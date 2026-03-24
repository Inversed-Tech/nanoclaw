/**
 * Host Request Runner
 *
 * Spawns Claude Code on the host to execute an approved request.
 * Writes the result to {uuid}.result.json and notifies the group.
 */

import { spawn } from 'child_process';

import {
  HostRequest,
  updateRequestStatus,
  writeResult,
} from './host-request-watcher.js';
import { logger } from './logger.js';

const MAX_OUTPUT_CHARS = 4000;

export async function runHostRequest(
  req: HostRequest,
  approvedAt: string,
  sendMessage: (jid: string, text: string) => Promise<void>,
): Promise<void> {
  logger.info(
    { requestId: req.id, title: req.title, cwd: req.cwd },
    'Running host request via Claude',
  );

  updateRequestStatus(req.id, 'approved');

  let output = '';
  let exitCode = 0;

  try {
    output = await spawnClaude(req.prompt, req.cwd);
  } catch (err: unknown) {
    exitCode = 1;
    output = err instanceof Error ? err.message : String(err);
    logger.error({ err, requestId: req.id }, 'Claude execution failed');
  }

  const succeeded = exitCode === 0;
  const status = succeeded ? 'completed' : 'failed';

  writeResult(req.id, {
    status,
    exit_code: exitCode,
    output,
    approved_at: approvedAt,
    rejected_at: undefined,
    rejection_reason: undefined,
  });

  updateRequestStatus(req.id, status);

  const tail = output.slice(-MAX_OUTPUT_CHARS);
  const icon = succeeded ? '✅' : '❌';

  try {
    await sendMessage(
      req.group_jid,
      `${icon} Host task *${req.title}* ${status} (exit ${exitCode})\n\`\`\`\n${tail}\n\`\`\``,
    );
  } catch (err) {
    logger.error(
      { err, requestId: req.id },
      'Failed to notify group of task result',
    );
  }
}

function spawnClaude(prompt: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Use claude CLI with dangerously-skip-permissions for no human-in-loop
    const child = spawn(
      'claude',
      ['--dangerously-skip-permissions', '-p', prompt],
      {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      },
    );

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      const combined = stdout + (stderr ? `\n[stderr]\n${stderr}` : '');
      if (code === 0) {
        resolve(combined);
      } else {
        reject(new Error(`Claude exited with code ${code}\n${combined}`));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}
