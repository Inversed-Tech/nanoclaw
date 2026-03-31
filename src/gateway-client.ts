/**
 * Gateway API client for host request workflow.
 * POSTs agentic requests and polls for approval status.
 * Disabled at runtime when env vars are missing.
 */

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const secrets = readEnvFile([
  'GATEWAY_BASE_URL',
  'CF_ACCESS_CLIENT_ID',
  'CF_ACCESS_CLIENT_SECRET',
  'MCP_JWT_SIGNING_KEY',
]);

export const GATEWAY_BASE_URL =
  process.env.GATEWAY_BASE_URL ||
  secrets.GATEWAY_BASE_URL ||
  'https://gateway.inversed.ai';

export const CF_ACCESS_CLIENT_ID =
  process.env.CF_ACCESS_CLIENT_ID || secrets.CF_ACCESS_CLIENT_ID || '';

export const CF_ACCESS_CLIENT_SECRET =
  process.env.CF_ACCESS_CLIENT_SECRET || secrets.CF_ACCESS_CLIENT_SECRET || '';

export const MCP_JWT_SIGNING_KEY =
  process.env.MCP_JWT_SIGNING_KEY || secrets.MCP_JWT_SIGNING_KEY || '';

/** Returns true when all required Gateway credentials are configured. */
export function isHostRequestsEnabled(): boolean {
  return !!(
    CF_ACCESS_CLIENT_ID &&
    CF_ACCESS_CLIENT_SECRET &&
    MCP_JWT_SIGNING_KEY
  );
}

export interface GatewayResponse {
  id: number;
  approval_url: string;
  status_url: string;
}

export interface GatewayStatus {
  status: 'pending' | 'approved' | 'rejected';
  signed_token?: string;
  rejection_reason?: string;
}

export interface HostRequest {
  id: string;
  title: string;
  description: string;
  prompt: string;
  cwd?: string;
  status: string;
  created_at: string;
  /** Set by IPC watcher from the source directory name */
  sourceGroup?: string;
}

export async function postToGateway(
  req: HostRequest,
): Promise<GatewayResponse> {
  const url = `${GATEWAY_BASE_URL}/admin/agentic/requests`;
  logger.info({ url, title: req.title }, 'Posting host request to Gateway');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Access-Client-Id': CF_ACCESS_CLIENT_ID,
      'CF-Access-Client-Secret': CF_ACCESS_CLIENT_SECRET,
    },
    body: JSON.stringify({
      origin_agent_name: 'Verso',
      title: req.title,
      description: req.description,
      prompt: req.prompt,
      metadata: { cwd: req.cwd },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gateway POST failed (${res.status}): ${body}`);
  }

  return (await res.json()) as GatewayResponse;
}

export async function fetchGatewayStatus(
  statusUrl: string,
): Promise<GatewayStatus> {
  const res = await fetch(statusUrl, {
    headers: {
      'CF-Access-Client-Id': CF_ACCESS_CLIENT_ID,
      'CF-Access-Client-Secret': CF_ACCESS_CLIENT_SECRET,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gateway status poll failed (${res.status}): ${body}`);
  }

  return (await res.json()) as GatewayStatus;
}
