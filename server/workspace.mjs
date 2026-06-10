// server/workspace.mjs
//
// File-backed persistence for registered packs — VALUE_BACKLOG item 10A.
// The server's upload registry (crawled / drafted / uploaded packs) used to
// be a process-scoped Map: every restart lost the user's working set. This
// module gives that registry a durable home without changing its contract:
//
//   .tomograph/                      (gitignored; TOMOGRAPH_WORKSPACE relocates)
//     packs/<id>.pack.yaml           one inspectable YAML file per pack
//     packs/index.json               id → { label, source, createdAt, lastUsedAt }
//
// Design constraints (deliberate):
//   - File-first, zero new dependencies: plain YAML files + one JSON index,
//     all inspectable with `cat`. No database.
//   - The pack id IS the filename (minus .pack.yaml). Ids are minted once at
//     registration from the canonical's content hash; on rehydrate we trust
//     the filename rather than re-hashing, so YAML round-trip formatting can
//     never silently re-mint an id. A hand-edited workspace file keeps its
//     id — that's documented behaviour, not drift detection's job.
//   - Env is read lazily (at call time, not module load) so tests can point
//     TOMOGRAPH_WORKSPACE at a temp dir before booting the server.
//   - Sync fs on the write paths (files are tens of KB); lastUsedAt touches
//     are debounced and the timer is unref'd so the process can still exit.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse as parseYaml, emit as emitYaml } from '../tools/lib/mini-yaml.mjs';

const PACK_SUFFIX = '.pack.yaml';

function workspaceRoot() {
  return resolve(process.env.TOMOGRAPH_WORKSPACE || '.tomograph');
}
function packsDir()  { return join(workspaceRoot(), 'packs'); }
function indexPath() { return join(packsDir(), 'index.json'); }

function ensureDirs() {
  mkdirSync(packsDir(), { recursive: true });
}

// ---------- index ----------
//
// The index carries the registry metadata that isn't part of the canonical
// pack itself (friendly label, source, timestamps). It's advisory: the pack
// files are the truth, and loadWorkspacePacks() reconciles the two — an
// index entry without a file is dropped, an orphan file is adopted.

function readIndex() {
  try {
    const data = JSON.parse(readFileSync(indexPath(), 'utf8'));
    return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
  } catch (_) { return {}; }
}

let pendingIndex = null;   // in-memory copy once loaded; mutations write through
let flushTimer = null;

function index() {
  if (!pendingIndex) pendingIndex = readIndex();
  return pendingIndex;
}

function flushIndexNow() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!pendingIndex) return;
  ensureDirs();
  writeFileSync(indexPath(), JSON.stringify(pendingIndex, null, 2));
}

function scheduleIndexFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => { flushTimer = null; flushIndexNow(); }, 1500);
  // Never keep the process alive just to persist a lastUsedAt touch.
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

// ---------- public API ----------

export function saveWorkspacePack(id, { canonical, label, source, createdAt, lastUsedAt } = {}) {
  ensureDirs();
  writeFileSync(join(packsDir(), id + PACK_SUFFIX), emitYaml(canonical || {}));
  index()[id] = {
    label: label || null,
    source: source || 'upload',
    createdAt: createdAt || Date.now(),
    lastUsedAt: lastUsedAt || Date.now(),
  };
  flushIndexNow();
}

export function deleteWorkspacePack(id) {
  try { rmSync(join(packsDir(), id + PACK_SUFFIX), { force: true }); } catch (_) {}
  delete index()[id];
  flushIndexNow();
}

// Record that a pack was read. Debounced: high-traffic /api/packs/:id/*
// handlers touch on every hit, and lastUsedAt only needs to be roughly
// right (it drives retention pruning, nothing user-visible).
export function touchWorkspacePack(id) {
  const entry = index()[id];
  if (!entry) return;
  entry.lastUsedAt = Date.now();
  scheduleIndexFlush();
}

// Load every persisted pack, reconciling index against the files on disk.
// Returns entries sorted oldest-lastUsedAt first so callers can seed an
// LRU-ordered Map by insertion order.
export function loadWorkspacePacks() {
  ensureDirs();
  const idx = index();
  const out = [];
  let files = [];
  try { files = readdirSync(packsDir()).filter(f => f.endsWith(PACK_SUFFIX)); } catch (_) {}
  const seen = new Set();
  for (const file of files) {
    const id = file.slice(0, -PACK_SUFFIX.length);
    let canonical;
    try { canonical = parseYaml(readFileSync(join(packsDir(), file), 'utf8')); }
    catch (e) {
      process.stderr.write(`[workspace] skipping unparseable pack ${file}: ${e.message}\n`);
      continue;
    }
    if (!canonical || typeof canonical !== 'object') continue;
    seen.add(id);
    const meta = idx[id];
    if (!meta) {
      // Orphan file (e.g. copied in by hand) — adopt it with file mtime.
      let mtime = Date.now();
      try { mtime = statSync(join(packsDir(), file)).mtimeMs; } catch (_) {}
      idx[id] = { label: null, source: 'workspace', createdAt: mtime, lastUsedAt: mtime };
    }
    const m = idx[id];
    out.push({ id, canonical, label: m.label, source: m.source, createdAt: m.createdAt, lastUsedAt: m.lastUsedAt });
  }
  // Index entries whose pack file vanished are dropped.
  let pruned = false;
  for (const id of Object.keys(idx)) {
    if (!seen.has(id)) { delete idx[id]; pruned = true; }
  }
  if (pruned || out.some(p => !readIndex()[p.id])) flushIndexNow();
  out.sort((a, b) => (a.lastUsedAt || 0) - (b.lastUsedAt || 0));
  return out;
}

export function clearWorkspacePacks() {
  let dropped = 0;
  try {
    for (const f of readdirSync(packsDir())) {
      if (f.endsWith(PACK_SUFFIX)) { rmSync(join(packsDir(), f), { force: true }); dropped++; }
    }
  } catch (_) {}
  pendingIndex = {};
  flushIndexNow();
  return dropped;
}

// ---------- deploy audit (VALUE_BACKLOG item 10C) ----------
//
// Append-only JSONL: audit history is never rewritten. Two record types —
// { type: 'deploy', deployId, ... } written when a deploy is attempted, and
// { type: 'verify', deployId, ... } appended later by post-deploy re-verify
// (item 9). readDeployRecords() merges the latest verify into its deploy
// record at read time, so consumers see one object per deploy while the
// on-disk log stays a faithful, immutable sequence of events.
//
// Deliberately NOT cleared by DELETE /api/uploads: resetting the pack
// registry must not erase the record of what was pushed to production.

function deploysPath() { return join(workspaceRoot(), 'deploys.jsonl'); }

export function appendDeployRecord(record) {
  mkdirSync(workspaceRoot(), { recursive: true });
  appendFileSync(deploysPath(), JSON.stringify({ type: 'deploy', ...record }) + '\n');
}

export function appendDeployVerify(deployId, verify) {
  mkdirSync(workspaceRoot(), { recursive: true });
  appendFileSync(deploysPath(), JSON.stringify({ type: 'verify', deployId, at: new Date().toISOString(), ...verify }) + '\n');
}

// Newest-first deploy records with the latest verify (if any) merged in.
// Unparseable lines are skipped — a torn write must not poison the log.
export function readDeployRecords({ packId, limit = 50 } = {}) {
  let raw = '';
  try { raw = readFileSync(deploysPath(), 'utf8'); } catch (_) { return []; }
  const deploys = [];
  const verifies = new Map();   // deployId → latest verify record
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (_) { continue; }
    if (rec.type === 'deploy' && rec.deployId) deploys.push(rec);
    else if (rec.type === 'verify' && rec.deployId) verifies.set(rec.deployId, rec);
  }
  let out = deploys.map(d => {
    const v = verifies.get(d.deployId);
    if (!v) return d;
    const { type: _t, deployId: _id, ...verify } = v;
    return { ...d, verify };
  });
  if (packId) out = out.filter(d => d.pack?.id === packId);
  out.reverse();   // appended oldest-first → serve newest-first
  return limit > 0 ? out.slice(0, limit) : out;
}

// ---------- pre-deploy snapshots (VALUE_BACKLOG item 10D) ----------
//
// One directory per deploy: snapshots/<deployId>/meta.json plus one JSON
// file per captured artefact. The snapshot is taken BEFORE the first write
// so rollback always has a pre-state to restore — or an honest record that
// the artefact did not exist (a create, whose rollback is a delete).

function snapshotDir(deployId) {
  // deployIds are server-minted (dep_<ts>_<rand>), but never trust a path
  // component: strip anything that isn't filename-safe.
  const safe = String(deployId).replace(/[^A-Za-z0-9_-]/g, '');
  if (!safe) throw new Error('workspace: empty snapshot id');
  return join(workspaceRoot(), 'snapshots', safe);
}

export function saveDeploySnapshot(deployId, meta, files = {}) {
  const dir = snapshotDir(deployId);
  mkdirSync(dir, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    const safeName = String(name).replace(/[^A-Za-z0-9._-]/g, '_');
    writeFileSync(join(dir, safeName + '.json'), JSON.stringify(data, null, 2));
  }
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  return dir;
}

// → { meta, readFile(name) } or null when no snapshot was taken.
export function readDeploySnapshot(deployId) {
  const dir = snapshotDir(deployId);
  let meta;
  try { meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')); }
  catch (_) { return null; }
  return {
    meta,
    readFile(name) {
      const safeName = String(name).replace(/[^A-Za-z0-9._-]/g, '_');
      try { return JSON.parse(readFileSync(join(dir, safeName + '.json'), 'utf8')); }
      catch (_) { return null; }
    },
  };
}

// Test hook: force any debounced index write to land now.
export function flushWorkspaceIndex() { flushIndexNow(); }

// Test hook: drop the in-memory index cache so a re-pointed
// TOMOGRAPH_WORKSPACE takes effect within the same process.
export function resetWorkspaceCache() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  pendingIndex = null;
}

export function workspaceInfo() {
  return { root: workspaceRoot(), packs: packsDir() };
}
