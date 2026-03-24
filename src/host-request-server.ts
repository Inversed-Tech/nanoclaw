/**
 * Host Request Approval Server
 *
 * Minimal HTTP server (no external deps, uses Node built-ins) that serves:
 *   GET  /approve/:id?token=xxx  — render approval UI
 *   POST /approve/:id            — handle approve/reject form submit
 *   GET  /status/:id?token=xxx   — JSON status for polling
 *   GET  /health                 — no auth, liveness check
 *
 * Binds to localhost only. Token is single-use with a 1h TTL.
 */

import http from 'http';
import path from 'path';
import { URL } from 'url';

import { APPROVAL_PORT, DATA_DIR } from './config.js';
import { runHostRequest } from './host-request-runner.js';
import {
  consumeToken,
  HOST_REQUESTS_DIR,
  HostRequest,
  lookupToken,
  readRequest,
  writeResult,
} from './host-request-watcher.js';
import { logger } from './logger.js';

import fs from 'fs';

function html(body: string, title = 'Host Request Approval'): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#0f0f0f;color:#e8e8e8;min-height:100vh;display:flex;justify-content:center;padding:2rem 1rem}
  .card{background:#1a1a1a;border:1px solid #2e2e2e;border-radius:12px;max-width:680px;width:100%;padding:2rem;align-self:flex-start;margin-top:1rem}
  h1{font-size:1.2rem;color:#fff;margin-bottom:1.5rem;display:flex;align-items:center;gap:.5rem}
  .field{margin-bottom:1.2rem}
  .label{font-size:.75rem;text-transform:uppercase;letter-spacing:.07em;color:#888;margin-bottom:.4rem}
  .value{color:#e8e8e8;word-break:break-word}
  pre{background:#111;border:1px solid #2e2e2e;border-radius:8px;padding:1rem;overflow-x:auto;font-size:.85rem;white-space:pre-wrap;color:#c9d1d9;max-height:320px;overflow-y:auto}
  .actions{display:flex;gap:1rem;margin-top:2rem}
  button{padding:.75rem 1.5rem;border:none;border-radius:8px;cursor:pointer;font-size:1rem;font-weight:600;transition:opacity .15s}
  .approve{background:#238636;color:#fff}
  .reject{background:#8b1a1a;color:#fff}
  button:hover{opacity:.85}
  .status-banner{padding:.75rem 1rem;border-radius:8px;margin-bottom:1.5rem;font-weight:600}
  .status-approved{background:#1a3a1a;border:1px solid #238636;color:#5fca6e}
  .status-rejected{background:#2a1a1a;border:1px solid #8b1a1a;color:#f08080}
  .status-running{background:#1a2a3a;border:1px solid #1f6feb;color:#79c0ff}
  .reject-reason{display:none;margin-top:1rem}
  .reject-reason textarea{width:100%;padding:.75rem;background:#111;border:1px solid #2e2e2e;border-radius:8px;color:#e8e8e8;font-size:.9rem;resize:vertical;min-height:80px}
  #spinner{display:none;text-align:center;padding:1rem;color:#79c0ff}
</style>
</head>
<body>
<div class="card">
${body}
</div>
<script>
  const rejectBtn = document.getElementById('rejectBtn');
  const rejectReason = document.getElementById('rejectReason');
  if(rejectBtn && rejectReason){
    rejectBtn.addEventListener('click',()=>{
      rejectReason.style.display = rejectReason.style.display==='block'?'none':'block';
    });
  }
  // Auto-poll for status
  const statusUrl = document.getElementById('statusUrl');
  const spinner = document.getElementById('spinner');
  if(statusUrl && spinner){
    spinner.style.display='block';
    const poll = setInterval(async()=>{
      try{
        const r = await fetch(statusUrl.value);
        const d = await r.json();
        if(d.status==='completed'||d.status==='failed'){
          clearInterval(poll);
          spinner.textContent = d.status==='completed'
            ? '✅ Task completed successfully.'
            : '❌ Task failed. Check logs.';
        }
      }catch{}
    },3000);
  }
</script>
</body>
</html>`;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function errorPage(msg: string): string {
  return html(
    `<h1>🔐 Host Request Approval</h1><div class="status-banner status-rejected">${escHtml(msg)}</div>`,
  );
}

function approvalPage(
  req: HostRequest,
  token: string,
  statusBase: string,
): string {
  const created = new Date(req.created_at).toUTCString();
  const statusUrl = `${statusBase}/status/${req.id}?token=${token}`;

  return html(
    `
<h1>🔐 Verso — Host Request Approval</h1>
<div class="field"><div class="label">Title</div><div class="value">${escHtml(req.title)}</div></div>
<div class="field"><div class="label">Description</div><div class="value">${escHtml(req.description)}</div></div>
<div class="field"><div class="label">Requested at</div><div class="value">${escHtml(created)}</div></div>
<div class="field"><div class="label">Working directory</div><div class="value"><code>${escHtml(req.cwd)}</code></div></div>
<div class="field"><div class="label">Prompt</div><pre>${escHtml(req.prompt)}</pre></div>
<form method="POST" action="/approve/${escHtml(req.id)}">
  <input type="hidden" name="token" value="${escHtml(token)}">
  <div class="actions">
    <button type="submit" name="action" value="approve" class="approve">✅ Approve</button>
    <button type="button" id="rejectBtn" class="reject">❌ Reject</button>
  </div>
  <div class="reject-reason" id="rejectReason">
    <textarea name="rejection_reason" placeholder="Reason for rejection (optional)"></textarea>
    <div style="margin-top:.5rem">
      <button type="submit" name="action" value="reject" class="reject">Confirm rejection</button>
    </div>
  </div>
</form>`,
    req.title,
  );
}

function approvedPage(
  req: HostRequest,
  statusBase: string,
  token: string,
): string {
  // token has been consumed; we pass a status URL using the request id only (no sensitive action possible)
  const statusUrl = `${statusBase}/status/${req.id}?token=${token}`;
  return html(
    `
<h1>🔐 Verso — Host Request</h1>
<div class="status-banner status-running">✅ Approved — Claude is running…</div>
<div class="field"><div class="label">Title</div><div class="value">${escHtml(req.title)}</div></div>
<div class="field"><div class="label">Working directory</div><div class="value"><code>${escHtml(req.cwd)}</code></div></div>
<input type="hidden" id="statusUrl" value="${escHtml(statusUrl)}">
<div id="spinner">Waiting for result…</div>`,
    req.title,
  );
}

function rejectedPage(req: HostRequest): string {
  return html(
    `
<h1>🔐 Verso — Host Request</h1>
<div class="status-banner status-rejected">❌ Request rejected</div>
<div class="field"><div class="label">Title</div><div class="value">${escHtml(req.title)}</div></div>`,
    req.title,
  );
}

function parseBody(req: http.IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const params: Record<string, string> = {};
      for (const pair of body.split('&')) {
        const [k, v] = pair.split('=').map(decodeURIComponent);
        if (k) params[k.replace(/\+/g, ' ')] = (v || '').replace(/\+/g, ' ');
      }
      resolve(params);
    });
  });
}

export function startHostRequestServer(deps: {
  sendMessage: (jid: string, text: string) => Promise<void>;
}): http.Server {
  const server = http.createServer(async (req, res) => {
    const baseUrl = new URL(`http://localhost:${APPROVAL_PORT}`);
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(req.url || '/', baseUrl);
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }

    const pathname = parsedUrl.pathname;

    // Health check — no auth
    if (pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // GET /approve/:id
    const approveMatch = pathname.match(/^\/approve\/([a-zA-Z0-9_-]+)$/);
    if (approveMatch && req.method === 'GET') {
      const requestId = approveMatch[1];
      const token = parsedUrl.searchParams.get('token') || '';

      const tokenEntry = lookupToken(token);
      if (!tokenEntry || tokenEntry.requestId !== requestId) {
        res.writeHead(401, { 'Content-Type': 'text/html' });
        res.end(errorPage('Invalid or expired approval link.'));
        return;
      }

      const request = readRequest(requestId);
      if (!request) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end(errorPage('Request not found.'));
        return;
      }

      if (request.status !== 'pending') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        const banner =
          request.status === 'rejected'
            ? rejectedPage(request)
            : approvedPage(request, `http://localhost:${APPROVAL_PORT}`, token);
        res.end(banner);
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        approvalPage(request, token, `http://localhost:${APPROVAL_PORT}`),
      );
      return;
    }

    // POST /approve/:id
    if (approveMatch && req.method === 'POST') {
      const requestId = approveMatch[1];
      const body = await parseBody(req);
      const { token, action, rejection_reason } = body;

      const tokenEntry = consumeToken(token);
      if (!tokenEntry || tokenEntry.requestId !== requestId) {
        res.writeHead(401, { 'Content-Type': 'text/html' });
        res.end(errorPage('Invalid or expired token.'));
        return;
      }

      const request = readRequest(requestId);
      if (!request || request.status !== 'pending') {
        res.writeHead(409, { 'Content-Type': 'text/html' });
        res.end(errorPage('Request is no longer pending.'));
        return;
      }

      if (action === 'reject') {
        writeResult(requestId, {
          status: 'rejected',
          rejected_at: new Date().toISOString(),
          rejection_reason: rejection_reason || '',
        });
        try {
          await deps.sendMessage(
            request.group_jid,
            `❌ Host request *${request.title}* was rejected.`,
          );
        } catch (err) {
          logger.error({ err }, 'Failed to notify group of rejection');
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(rejectedPage(request));
        return;
      }

      if (action === 'approve') {
        const approvedAt = new Date().toISOString();
        // Respond immediately, run Claude async
        res.writeHead(200, { 'Content-Type': 'text/html' });
        // Generate a fresh view-only token for status polling (single action already consumed)
        res.end(approvedPage(request, `http://localhost:${APPROVAL_PORT}`, ''));

        runHostRequest(request, approvedAt, deps.sendMessage).catch((err) => {
          logger.error({ err, requestId }, 'runHostRequest threw unexpectedly');
        });
        return;
      }

      res.writeHead(400).end('Unknown action');
      return;
    }

    // GET /status/:id
    const statusMatch = pathname.match(/^\/status\/([a-zA-Z0-9_-]+)$/);
    if (statusMatch && req.method === 'GET') {
      const requestId = statusMatch[1];
      const resultFile = `${HOST_REQUESTS_DIR}/${requestId}.result.json`;
      const reqFile = `${HOST_REQUESTS_DIR}/${requestId}.json`;

      try {
        if (fs.existsSync(resultFile)) {
          const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              status: result.status,
              exit_code: result.exit_code,
            }),
          );
        } else if (fs.existsSync(reqFile)) {
          const r = JSON.parse(fs.readFileSync(reqFile, 'utf-8'));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: r.status }));
        } else {
          res.writeHead(404).end(JSON.stringify({ error: 'not found' }));
        }
      } catch {
        res.writeHead(500).end(JSON.stringify({ error: 'read error' }));
      }
      return;
    }

    res.writeHead(404).end('Not found');
  });

  server.listen(APPROVAL_PORT, '127.0.0.1', () => {
    logger.info(
      { port: APPROVAL_PORT },
      'Host request approval server listening on localhost',
    );
  });

  return server;
}
