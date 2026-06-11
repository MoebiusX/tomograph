#!/usr/bin/env node
/**
 * server/test-authz.mjs — Stage 3 authorization
 * (docs/PRODUCTIZATION_PLAN.md): the AuthZ matrix gate. Table-driven:
 * representative routes × {anonymous, viewer, operator, admin, bearer}
 * → expected status class. Plus the admin surfaces themselves (member
 * management with the last-admin guard, org-scoped MCP endpoints with
 * `mcp:<name>` resolution and env-indirected read tokens).
 *
 * Roles only exist inside tenancy; flat-mode regression is every other
 * suite (none configure orgs.json).
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

const WORKSPACE = mkdtempSync(join(tmpdir(), 'tomograph-authz-'));
process.env.TOMOGRAPH_WORKSPACE = WORKSPACE;
process.env.TOMOGRAPH_API_TOKEN = 'ci-token-authz-0123456789';
process.env.TOMOGRAPH_USERS_FILE = join(WORKSPACE, 'users.json');
process.env.TOMOGRAPH_AUTHZ_TEST_READ_TOKEN = 'read-token-from-env';
delete process.env.TOMOGRAPH_OIDC_ISSUER;
delete process.env.TOMOGRAPH_SESSION_SECRET;

import { createHarness } from '../tools/lib/harness.mjs';
const { assert, failures, report } = createHarness({ indent: '  ', truncate: 200 });

const { hashPassword, writeUsers } = await import('./auth.mjs');
const { writeOrgs } = await import('./tenancy.mjs');

writeUsers({ users: {
  vera:  { name: 'Vera',  createdAt: 'test', password: hashPassword('vera-passw0rd!!') },
  oscar: { name: 'Oscar', createdAt: 'test', password: hashPassword('oscar-passw0rd!') },
  ada:   { name: 'Ada',   createdAt: 'test', password: hashPassword('ada-passw0rd!!!') },
} });
writeOrgs({
  acme: { name: 'Acme', members: { vera: 'viewer', oscar: 'operator', ada: 'admin' } },
});

const { start } = await import('./index.mjs');
const srv = await start({ port: 0, host: '127.0.0.1', silent: true });
const base = `http://127.0.0.1:${srv.address().port}`;

const login = async (u, p) => {
  const r = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `username=${u}&password=${encodeURIComponent(p)}`,
    redirect: 'manual',
  });
  const c = (r.headers.getSetCookie?.() || []).find(x => x.startsWith('tomo_session='))?.split(';')[0];
  if (!c) throw new Error(`login failed for ${u}`);
  return c;
};

const PACK_YAML = readFileSync('examples/demo-skeleton.pack.yaml', 'utf8');

// A tiny MCP server so `mcp:<name>` resolution can be proven end to end,
// including the env-indirected read token actually arriving.
const seenAuth = [];
const mcp = createServer(async (req, res) => {
  seenAuth.push(req.headers.authorization || null);
  let raw = '';
  req.setEncoding('utf8');
  for await (const ch of req) raw += ch;
  let msg = {};
  try { msg = JSON.parse(raw || '{}'); } catch (_) {}
  res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'authz' });
  if (msg.method === 'initialize') {
    return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? 1, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'authz-mcp' } } }));
  }
  if (msg.method === 'tools/list') {
    return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? 1, result: { tools: [] } }));
  }
  res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? 1, result: {} }));
});
await new Promise(r => mcp.listen(0, '127.0.0.1', r));
const mcpUrl = `http://127.0.0.1:${mcp.address().port}/mcp`;

try {
  const vera = { Cookie: await login('vera', 'vera-passw0rd!!'), 'X-Tomograph-CSRF': '1' };
  const oscar = { Cookie: await login('oscar', 'oscar-passw0rd!'), 'X-Tomograph-CSRF': '1' };
  const ada = { Cookie: await login('ada', 'ada-passw0rd!!!'), 'X-Tomograph-CSRF': '1' };
  const bearer = { Authorization: `Bearer ${process.env.TOMOGRAPH_API_TOKEN}`, 'Content-Type': 'application/json' };

  // ---- the matrix ----
  // expected entries: number = exact status; 'ok' = 2xx; '!auth' = anything
  // BUT 401/403 (the request passed authz and failed/succeeded downstream).
  const MATRIX = [
    { label: 'GET /api/packs (read)',
      req: (h) => fetch(`${base}/api/packs`, { headers: h }),
      expect: { anon: 401, viewer: 'ok', operator: 'ok', admin: 'ok', bearer: 'ok' } },
    { label: 'POST /api/validate (register)',
      req: (h) => fetch(`${base}/api/validate`, { method: 'POST', headers: { ...h, 'Content-Type': 'text/yaml' }, body: PACK_YAML }),
      expect: { anon: 401, viewer: 403, operator: 'ok', admin: 'ok', bearer: 'ok' } },
    { label: 'POST /api/crawl (scan)',
      req: (h) => fetch(`${base}/api/crawl`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ files: {}, repoName: 'x' }) }),
      expect: { anon: 401, viewer: 403, operator: '!auth', admin: '!auth', bearer: '!auth' } },
    { label: 'POST /api/draft-from-mcp',
      req: (h) => fetch(`${base}/api/draft-from-mcp`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ mcpUrl }) }),
      expect: { anon: 401, viewer: 403, operator: '!auth', admin: '!auth', bearer: '!auth' } },
    { label: 'DELETE /api/uploads (reset)',
      req: (h) => fetch(`${base}/api/uploads`, { method: 'DELETE', headers: h }),
      expect: { anon: 401, viewer: 403, operator: 'ok', admin: 'ok', bearer: 'ok' } },
    { label: 'GET /api/orgs/acme/members (org admin read)',
      req: (h) => fetch(`${base}/api/orgs/acme/members`, { headers: h }),
      expect: { anon: 401, viewer: 403, operator: 403, admin: 'ok', bearer: 'ok' } },
    { label: 'PUT /api/orgs/acme/members/newbie (org admin write)',
      req: (h) => fetch(`${base}/api/orgs/acme/members/newbie`, { method: 'PUT', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'viewer' }) }),
      expect: { anon: 401, viewer: 403, operator: 403, admin: 'ok', bearer: 'ok' } },
    { label: 'GET /api/org/mcp-endpoints (registry read)',
      req: (h) => fetch(`${base}/api/org/mcp-endpoints`, { headers: h }),
      expect: { anon: 401, viewer: 'ok', operator: 'ok', admin: 'ok', bearer: 'ok' } },
    { label: 'PUT /api/org/mcp-endpoints/krys (registry write)',
      req: (h) => fetch(`${base}/api/org/mcp-endpoints/krys`, { method: 'PUT', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: mcpUrl }) }),
      expect: { anon: 401, viewer: 403, operator: 403, admin: 'ok', bearer: 'ok' } },
  ];
  const ACTORS = { anon: {}, viewer: vera, operator: oscar, admin: ada, bearer };

  for (const row of MATRIX) {
    for (const [actor, headers] of Object.entries(ACTORS)) {
      const want = row.expect[actor];
      const r = await row.req(headers);
      const pass = want === 'ok' ? (r.status >= 200 && r.status < 300)
        : want === '!auth' ? (r.status !== 401 && r.status !== 403)
        : r.status === want;
      assert(pass, `${row.label} × ${actor} → ${want}`, r.status, want);
    }
  }

  // ---- member management details ----
  let r = await fetch(`${base}/api/orgs/acme/members`, { headers: ada });
  let j = await r.json();
  assert(j.members.some(m => m.sub === 'newbie' && m.role === 'viewer'), 'admin PUT added the member with the role');

  r = await fetch(`${base}/api/orgs/acme/members/ada`, {
    method: 'PUT', headers: { ...ada, 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'viewer' }),
  });
  assert(r.status === 400, 'demoting the last admin → 400 (lockout guard)', r.status, 400);
  r = await fetch(`${base}/api/orgs/acme/members/ada`, { method: 'DELETE', headers: ada });
  assert(r.status === 400, 'removing the last admin → 400 (lockout guard)', r.status, 400);
  r = await fetch(`${base}/api/orgs/acme/members/newbie`, { method: 'DELETE', headers: ada });
  assert(r.ok, 'admin removes a non-admin member');

  // ---- org MCP endpoints: mcp:<name> resolution end to end ----
  r = await fetch(`${base}/api/org/mcp-endpoints/krys`, {
    method: 'PUT', headers: { ...ada, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: mcpUrl, authEnv: 'TOMOGRAPH_AUTHZ_TEST_READ_TOKEN', note: 'authz test endpoint' }),
  });
  j = await r.json();
  assert(r.ok && j.endpoint?.authEnv === 'TOMOGRAPH_AUTHZ_TEST_READ_TOKEN' && !JSON.stringify(j).includes('read-token-from-env'),
    'endpoint stores the env NAME, never the secret');

  r = await fetch(`${base}/api/org/mcp-endpoints/bad`, {
    method: 'PUT', headers: { ...ada, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'file:///etc/passwd' }),
  });
  assert(r.status === 400, 'registry rejects non-http(s) URLs via validateMcpUrl', r.status, 400);

  seenAuth.length = 0;
  r = await fetch(`${base}/api/draft-from-mcp`, {
    method: 'POST', headers: { ...oscar, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mcpUrl: 'mcp:krys' }),
  });
  assert(r.status !== 401 && r.status !== 403 && r.status !== 400,
    'operator drafts via mcp:<name> (resolution + role both pass)', r.status, 'not 400/401/403');
  assert(seenAuth.some(a => a === 'Bearer read-token-from-env'),
    'the env-indirected READ token reached the MCP server', seenAuth[0], 'Bearer read-token-from-env');

  r = await fetch(`${base}/api/draft-from-mcp`, {
    method: 'POST', headers: { ...oscar, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mcpUrl: 'mcp:nonexistent' }),
  });
  j = await r.json();
  assert(r.status === 400 && /unknown org MCP endpoint/.test(j.error || ''),
    'unknown mcp:<name> → 400 with guidance', `${r.status} ${j.error?.slice(0, 60)}`);
} finally {
  await new Promise(res => srv.close(res));
  await new Promise(res => mcp.close(res));
  rmSync(WORKSPACE, { recursive: true, force: true });
}

report('authz');
