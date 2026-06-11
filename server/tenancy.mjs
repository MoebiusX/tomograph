// server/tenancy.mjs — Stage 2 of docs/PRODUCTIZATION_PLAN.md: tenancy
// (workspace-per-org).
//
// The whole design is one move: workspaceRoot() becomes context-aware.
// When tenancy is armed, every org gets its own subtree —
//
//   <TOMOGRAPH_WORKSPACE>/
//     users.json, session-secret, orgs.json     deployment-level (shared)
//     orgs/<orgId>/packs|deploys.jsonl|snapshots|journeys|runs
//
// — and the file-first machinery underneath (registry, deploys,
// snapshots, journeys, runs) is unchanged: it already resolves its root
// per call, so it only needed a context-aware answer. The request's org
// rides AsyncLocalStorage (node:async_hooks), so nothing threads an
// orgId parameter through twenty call sites.
//
// ARMING — mirrors users.json arming stand-alone auth: tenancy is ON
// when <workspace>/orgs.json exists. No file → byte-identical flat
// workspace, zero behaviour change (CI-asserted by every other suite).
//
//   orgs.json: { "<orgId>": { "name": "...", "members": { "<sub>": "<role>" } } }
//
// Roles are RECORDED here but not yet ENFORCED — that is Stage 3's
// per-route check. Stage 2 enforcement is membership only: you are in
// the org or you do not see it. Member management is admin-edited file
// (or tools/org-admin.mjs); mutation endpoints deliberately wait for
// Stage 3 roles — a members API any member can call would be a
// privilege-escalation hole, not a feature.
//
// MIGRATION — a deployment with an existing flat workspace gets it
// moved to orgs/default/ by a one-shot, idempotent boot migration that
// only runs once tenancy is armed (rename per entry; entries that
// already exist under orgs/default/ are left alone).

import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

function env(name) { return (process.env[name] || '').trim(); }

// The deployment-level base — auth state (users.json, session-secret)
// and orgs.json always live here, never inside an org subtree.
export function baseWorkspaceRoot() { return resolve(env('TOMOGRAPH_WORKSPACE') || '.tomograph'); }

export function orgsFilePath() { return join(baseWorkspaceRoot(), 'orgs.json'); }

export function tenancyEnabled() { return existsSync(orgsFilePath()); }

// ---------- the org registry (file-first, like everything else) ----------

export function readOrgs(file = orgsFilePath()) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
  } catch (_) { return {}; }
}

export function writeOrgs(orgs, file = orgsFilePath()) {
  mkdirSync(baseWorkspaceRoot(), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(orgs, null, 2) + '\n', { mode: 0o600 });
  try { renameSync(tmp, file); }
  catch (e) { try { rmSync(tmp, { force: true }); } catch (_) {} throw e; }
}

// Org ids are path components — same shape as the spec's Slug.
export function validOrgId(id) { return /^[a-z][a-z0-9_-]{0,62}[a-z0-9]$/.test(String(id || '')); }

export function orgsForUser(sub) {
  if (!sub) return [];
  const orgs = readOrgs();
  return Object.entries(orgs)
    .filter(([id, org]) => validOrgId(id) && org?.members && Object.hasOwn(org.members, sub))
    .map(([id, org]) => ({ id, name: org.name || id, role: String(org.members[sub] || 'member') }));
}

export function isMember(orgId, sub) {
  if (!validOrgId(orgId) || !sub) return false;
  const org = readOrgs()[orgId];
  return !!(org?.members && Object.hasOwn(org.members, sub));
}

export function orgExists(orgId) {
  return validOrgId(orgId) && Object.hasOwn(readOrgs(), orgId);
}

// ---------- roles (Stage 3 — authorization) ----------
//
// Three roles per org, strictly ordered:
//   viewer    read everything in the org
//   operator  + crawl / draft / register / deploy / retrofeed / reset
//   admin     + org settings: members, MCP endpoint config
//
// Stage 2 files wrote free-form role strings (default 'member'); they
// normalize to operator so existing orgs.json files keep working —
// a member could already do everything before enforcement existed, so
// operator is the no-surprise mapping. Unknown strings also land on
// operator rather than silently escalating to admin.

export const ROLES = ['viewer', 'operator', 'admin'];
const ROLE_RANK = { viewer: 0, operator: 1, admin: 2 };

export function normalizeRole(role) {
  const r = String(role || '').toLowerCase();
  return r === 'admin' ? 'admin' : r === 'viewer' ? 'viewer' : 'operator';
}

export function roleFor(orgId, sub) {
  if (!validOrgId(orgId) || !sub) return null;
  const org = readOrgs()[orgId];
  if (!org?.members || !Object.hasOwn(org.members, sub)) return null;
  return normalizeRole(org.members[sub]);
}

export function roleAtLeast(role, required) {
  return (ROLE_RANK[role] ?? -1) >= (ROLE_RANK[required] ?? Infinity);
}

// The number of admins an org would have after a hypothetical change —
// the guard that keeps the last admin from demoting or deleting
// themselves into a lockout.
export function adminCount(orgId, { excluding = null } = {}) {
  const org = readOrgs()[orgId];
  if (!org?.members) return 0;
  return Object.entries(org.members)
    .filter(([sub, role]) => sub !== excluding && normalizeRole(role) === 'admin')
    .length;
}

// ---------- per-request org context ----------

const orgContext = new AsyncLocalStorage();

export function runWithOrg(orgId, fn) { return orgContext.run(orgId, fn); }

export function currentOrg() { return orgContext.getStore() || null; }

// THE context-aware root. Flat (byte-identical v1 behaviour) unless
// tenancy is armed AND the request carries an org.
export function orgWorkspaceRoot() {
  const base = baseWorkspaceRoot();
  const org = currentOrg();
  if (!org || !tenancyEnabled()) return base;
  if (!validOrgId(org)) throw new Error(`tenancy: invalid org id ${JSON.stringify(org)}`);
  return join(base, 'orgs', org);
}

// ---------- org-scoped MCP endpoints (Stage 3) ----------
//
// Admins register NAMED read endpoints per org; operators reference them
// as `mcp:<name>` wherever a route takes an mcpUrl. The optional
// `authEnv` is env-name indirection for a READ token (resolved at use
// time, mirroring journeys' packB.mcp.authEnv) — the v1 secrets rule
// stands: write tokens are per-request pass-through, never stored, and
// endpoint records hold an env NAME, never a secret.
//
// File-first like everything else: <org workspace>/mcp-endpoints.json,
// which also means endpoint configs are org-isolated for free.

function mcpEndpointsPath() { return join(orgWorkspaceRoot(), 'mcp-endpoints.json'); }

export function validEndpointName(name) { return /^[a-z][a-z0-9_-]{1,39}$/.test(String(name || '')); }

export function readMcpEndpoints() {
  try {
    const data = JSON.parse(readFileSync(mcpEndpointsPath(), 'utf8'));
    return (data && typeof data === 'object' && data.endpoints && typeof data.endpoints === 'object')
      ? data : { endpoints: {} };
  } catch (_) { return { endpoints: {} }; }
}

export function writeMcpEndpoints(data) {
  const file = mcpEndpointsPath();
  mkdirSync(orgWorkspaceRoot(), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  try { renameSync(tmp, file); }
  catch (e) { try { rmSync(tmp, { force: true }); } catch (_) {} throw e; }
}

// `mcp:<name>` → the registered endpoint, or null. Only meaningful in
// tenancy mode (flat mode has no admin to curate the registry).
export function resolveMcpEndpoint(name) {
  if (!tenancyEnabled() || !currentOrg() || !validEndpointName(name)) return null;
  const rec = readMcpEndpoints().endpoints[name];
  return rec && typeof rec.url === 'string' ? rec : null;
}

// ---------- boot migration: flat workspace → orgs/default/ ----------
//
// Idempotent and per-entry: each flat entry moves only if it exists AND
// its destination doesn't. A half-migrated workspace (crash mid-move)
// finishes on the next boot; an already-migrated one is a no-op.

const MIGRATABLE = ['packs', 'deploys.jsonl', 'snapshots', 'journeys', 'runs'];

export function migrateFlatWorkspace({ log = () => {} } = {}) {
  if (!tenancyEnabled()) return { migrated: [] };
  const base = baseWorkspaceRoot();
  const migrated = [];
  for (const entry of MIGRATABLE) {
    const from = join(base, entry);
    const to = join(base, 'orgs', 'default', entry);
    if (!existsSync(from) || existsSync(to)) continue;
    mkdirSync(join(base, 'orgs', 'default'), { recursive: true });
    renameSync(from, to);
    migrated.push(entry);
  }
  if (migrated.length) {
    // The moved state must stay reachable: make sure a 'default' org
    // exists. Membership is left for the admin to fill in (orgs.json is
    // their file); the migration only guarantees the org key is there.
    const orgs = readOrgs();
    if (!Object.hasOwn(orgs, 'default')) {
      orgs.default = { name: 'Default', members: {} };
      writeOrgs(orgs);
      log(`[tenancy] created org "default" in orgs.json — add members to grant access to the migrated workspace`);
    }
    log(`[tenancy] migrated flat workspace entries to orgs/default/: ${migrated.join(', ')}`);
  }
  return { migrated };
}
