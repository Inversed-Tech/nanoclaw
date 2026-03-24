/**
 * Host Request Watcher
 *
 * Polls data/ipc/host-requests/ for new request files written by container agents.
 * On a new pending request, generates a one-time approval token and notifies
 * the requesting group with a link to the approval UI.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { APPROVAL_PORT, DATA_DIR, IPC_POLL_INTERVAL } from './config.js';
import { logger } from './logger.js';

export const HOST_REQUESTS_DIR = path.join(DATA_DIR, 'ipc', 'host-requests');

export interface HostRequest {
  id: string;
  created_at: string;
  group_jid: string;
  title: string;
  description: string;
  prompt: string;
  cwd: string;
  status: 'pending' | 'approved' | 'rejected' | 'completed' | 'failed';
}

export interface ApprovalToken {
  requestId: string;
  token: string;
  expiresAt: number; // epoch ms
}

// In-memory token store: token → ApprovalToken
const tokens = new Map<string, ApprovalToken>();

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

export function generateToken(requestId: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  tokens.set(token, {
    requestId,
    token,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });
  return token;
}

/** Returns the token record if valid, null if expired or not found. Does NOT consume. */
export function lookupToken(token: string): ApprovalToken | null {
  const entry = tokens.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    tokens.delete(token);
    return null;
  }
  return entry;
}

/** Consume a token (single-use). Returns true if it was valid. */
export function consumeToken(token: string): ApprovalToken | null {
  const entry = lookupToken(token);
  if (!entry) return null;
  tokens.delete(token);
  return entry;
}

export function readRequest(requestId: string): HostRequest | null {
  const file = path.join(HOST_REQUESTS_DIR, `${requestId}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as HostRequest;
  } catch {
    return null;
  }
}

export function writeResult(
  requestId: string,
  result: {
    status: 'completed' | 'failed' | 'rejected';
    exit_code?: number;
    output?: string;
    approved_at?: string;
    rejected_at?: string;
    rejection_reason?: string;
  },
): void {
  const file = path.join(HOST_REQUESTS_DIR, `${requestId}.result.json`);
  const data = {
    id: requestId,
    completed_at: new Date().toISOString(),
    ...result,
  };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function updateRequestStatus(
  requestId: string,
  status: HostRequest['status'],
): void {
  const file = path.join(HOST_REQUESTS_DIR, `${requestId}.json`);
  try {
    const req = JSON.parse(fs.readFileSync(file, 'utf-8')) as HostRequest;
    req.status = status;
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(req, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    logger.error({ err, requestId }, 'Failed to update request status');
  }
}

const seenIds = new Set<string>();

export function startHostRequestWatcher(deps: {
  sendMessage: (jid: string, text: string) => Promise<void>;
}): void {
  fs.mkdirSync(HOST_REQUESTS_DIR, { recursive: true });

  const poll = async () => {
    try {
      const files = fs
        .readdirSync(HOST_REQUESTS_DIR)
        .filter((f) => f.endsWith('.json') && !f.endsWith('.result.json'));

      for (const file of files) {
        const requestId = file.replace(/\.json$/, '');
        if (seenIds.has(requestId)) continue;

        const filePath = path.join(HOST_REQUESTS_DIR, file);
        let req: HostRequest;
        try {
          req = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as HostRequest;
        } catch {
          continue;
        }

        if (req.status !== 'pending') {
          seenIds.add(requestId);
          continue;
        }

        seenIds.add(requestId);

        const token = generateToken(requestId);
        const url = `http://localhost:${APPROVAL_PORT}/approve/${requestId}?token=${token}`;

        logger.info(
          { requestId, title: req.title, groupJid: req.group_jid },
          'New host request — notifying group',
        );

        try {
          await deps.sendMessage(
            req.group_jid,
            `📋 *Host work request*\n*${req.title}*\n\nReview and approve:\n${url}`,
          );
        } catch (err) {
          logger.error(
            { err, requestId, groupJid: req.group_jid },
            'Failed to notify group of host request',
          );
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error polling host-requests dir');
    }

    setTimeout(poll, IPC_POLL_INTERVAL);
  };

  poll();
  logger.info('Host request watcher started');
}
