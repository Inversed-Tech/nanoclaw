/**
 * Host Request Runner
 * Polls the Gateway for approval, verifies the signed JWT, spawns Claude
 * via the Agent SDK, and writes the result back to an IPC file for the
 * container agent to read.
 *
 * Entire module is a no-op when Gateway env vars are missing.
 */

import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { query } from '@anthropic-ai/claude-agent-sdk';

import { DATA_DIR } from './config.js';
import {
  fetchGatewayStatus,
  GatewayResponse,
  HostRequest,
  MCP_JWT_SIGNING_KEY,
  postToGateway,
} from './gateway-client.js';
import { logger } from './logger.js';

const IPC_HOST_REQUESTS_DIR = path.join(DATA_DIR, 'ipc', 'host-requests');

// ---------------------------------------------------------------------------
// Result file (read by the container MCP tool via pollForResult)
// ---------------------------------------------------------------------------

interface HostResult {
  status: 'completed' | 'failed' | 'rejected';
  gateway_id?: number;
  output?: string;
  rejection_reason?: string;
}

function writeResult(requestId: string, result: HostResult): void {
  const payload = {
    status: result.status,
    gateway_id: result.gateway_id ?? null,
    output_summary: result.output?.slice(-800) ?? '',
    completed_at: new Date().toISOString(),
    rejection_reason: result.rejection_reason ?? null,
  };
  const resultPath = path.join(
    IPC_HOST_REQUESTS_DIR,
    `${requestId}.result.json`,
  );
  const tmpPath = `${resultPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tmpPath, resultPath);
  logger.info(
    { requestId, status: result.status },
    'Host request result written',
  );
}

// ---------------------------------------------------------------------------
// JWT verification
// ---------------------------------------------------------------------------

function verifyGatewayJwt(token: string): boolean {
  try {
    const payload = jwt.verify(token, MCP_JWT_SIGNING_KEY, {
      issuer: 'inversed-gateway',
      algorithms: ['HS256'],
    });
    return (payload as Record<string, unknown>).approved === true;
  } catch (err) {
    logger.warn({ err }, 'JWT verification failed');
    return false;
  }
}

// ---------------------------------------------------------------------------
// Gateway polling + Claude execution
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 5_000;
const TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function handleHostRequest(
  req: HostRequest,
  sendMessage: (jid: string, text: string) => Promise<void>,
  resolveGroupJid: (folder: string) => string | undefined,
): Promise<void> {
  const groupJid = req.sourceGroup
    ? resolveGroupJid(req.sourceGroup)
    : undefined;

  // 1. POST to Gateway
  let gatewayRes: GatewayResponse;
  try {
    gatewayRes = await postToGateway(req);
  } catch (err) {
    logger.error(
      { err, requestId: req.id },
      'Failed to POST host request to Gateway',
    );
    writeResult(req.id, { status: 'failed', output: String(err) });
    if (groupJid) {
      await sendMessage(
        groupJid,
        `Host request "${req.title}" failed to submit to Gateway.`,
      ).catch(() => {});
    }
    return;
  }

  // 2. Mark as submitted (prevent re-processing)
  const reqPath = path.join(IPC_HOST_REQUESTS_DIR, `${req.id}.json`);
  fs.writeFileSync(
    reqPath,
    JSON.stringify(
      {
        ...req,
        status: 'submitted',
        gateway_id: gatewayRes.id,
        status_url: gatewayRes.status_url,
      },
      null,
      2,
    ),
  );

  // 3. Notify originating group
  if (groupJid) {
    await sendMessage(
      groupJid,
      `Host request #${gatewayRes.id}: *${req.title}*\nReview and approve: ${gatewayRes.approval_url}`,
    ).catch(() => {});
  }

  // 4. Poll Gateway until approved/rejected (runs in background)
  pollGatewayAndRun(req, gatewayRes, sendMessage, groupJid).catch((err) => {
    logger.error({ err, requestId: req.id }, 'pollGatewayAndRun crashed');
    writeResult(req.id, {
      status: 'failed',
      gateway_id: gatewayRes.id,
      output: String(err),
    });
  });
}

async function pollGatewayAndRun(
  req: HostRequest,
  gatewayRes: GatewayResponse,
  sendMessage: (jid: string, text: string) => Promise<void>,
  groupJid: string | undefined,
): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    let status;
    try {
      status = await fetchGatewayStatus(gatewayRes.status_url);
    } catch (err) {
      logger.warn(
        { err, requestId: req.id },
        'Gateway status poll error, will retry',
      );
      continue;
    }

    if (status.status === 'rejected') {
      writeResult(req.id, {
        status: 'rejected',
        gateway_id: gatewayRes.id,
        rejection_reason: status.rejection_reason,
      });
      if (groupJid) {
        const reason = status.rejection_reason
          ? `\nReason: ${status.rejection_reason}`
          : '';
        await sendMessage(
          groupJid,
          `Host request #${gatewayRes.id} *${req.title}* was rejected.${reason}`,
        ).catch(() => {});
      }
      return;
    }

    if (status.status === 'approved' && status.signed_token) {
      // Verify JWT
      if (!verifyGatewayJwt(status.signed_token)) {
        writeResult(req.id, {
          status: 'failed',
          gateway_id: gatewayRes.id,
          output: 'JWT verification failed',
        });
        if (groupJid) {
          await sendMessage(
            groupJid,
            `Host request #${gatewayRes.id} JWT verification failed.`,
          ).catch(() => {});
        }
        return;
      }

      // Run Claude on the host
      await runHostClaude(req, gatewayRes.id, sendMessage, groupJid);
      return;
    }
  }

  // Timeout
  writeResult(req.id, {
    status: 'failed',
    gateway_id: gatewayRes.id,
    output: 'Timed out waiting for approval',
  });
  if (groupJid) {
    await sendMessage(
      groupJid,
      `Host request #${gatewayRes.id} *${req.title}* timed out waiting for approval.`,
    ).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Spawn Claude on the host via Agent SDK
// ---------------------------------------------------------------------------

async function runHostClaude(
  req: HostRequest,
  gatewayId: number,
  sendMessage: (jid: string, text: string) => Promise<void>,
  groupJid: string | undefined,
): Promise<void> {
  if (groupJid) {
    await sendMessage(
      groupJid,
      `Host request #${gatewayId} approved. Claude is running\u2026`,
    ).catch(() => {});
  }

  let output = '';
  let exitOk = true;

  try {
    for await (const msg of query({
      prompt: req.prompt,
      options: {
        cwd: req.cwd ?? process.cwd(),
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      },
    })) {
      if (msg.type === 'result' && 'result' in msg) {
        const text = (msg as { result?: string }).result;
        if (text) output = text;
      }
    }
  } catch (err) {
    exitOk = false;
    output = String(err);
    logger.error({ err, requestId: req.id }, 'Host Claude execution failed');
  }

  const summary = output.slice(-800);
  writeResult(req.id, {
    status: exitOk ? 'completed' : 'failed',
    gateway_id: gatewayId,
    output,
  });

  if (groupJid) {
    const statusEmoji = exitOk ? '\u2705' : '\u274c';
    const verb = exitOk ? 'completed' : 'failed';
    await sendMessage(
      groupJid,
      `${statusEmoji} Host task *${req.title}* ${verb}.\n\`\`\`\n${summary}\n\`\`\``,
    ).catch(() => {});
  }
}
