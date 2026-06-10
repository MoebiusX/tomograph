#!/usr/bin/env node
/**
 * server/test-workspace.mjs
 *
 * Unit test for the file-backed pack workspace (server/workspace.mjs).
 * Exercises the full lifecycle against a temp directory: save → load
 * round-trip (YAML fidelity on a representative canonical), delete,
 * orphan-file adoption, dangling-index pruning, touch ordering, and
 * clear. Exit 0 = pass.
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createHarness } from '../tools/lib/harness.mjs';
const { assert, report } = createHarness();

// Point the workspace at a fresh temp dir BEFORE first use — resolution is
// lazy by design, exactly so tests can do this.
const TMP = mkdtempSync(join(tmpdir(), 'tomograph-ws-'));
process.env.TOMOGRAPH_WORKSPACE = TMP;

const {
  saveWorkspacePack, deleteWorkspacePack, touchWorkspacePack,
  loadWorkspacePacks, clearWorkspacePacks, flushWorkspaceIndex,
  resetWorkspaceCache, workspaceInfo,
  appendDeployRecord, appendDeployVerify, readDeployRecords,
} = await import('./workspace.mjs');

try {
  // A representative canonical: nested objects, arrays, numbers, booleans,
  // multi-word strings — the shapes a real pack exercises in YAML round-trip.
  const canonical = {
    apiVersion: 'observability.platform/v1',
    kind: 'ObservabilityPack',
    metadata: { name: 'ws-test', version: '1.2.3', owners: ['team-a', 'team-b'] },
    spec: {
      slis: [{ id: 'avail', type: 'ratio', good: 'sum(rate(ok[5m]))', total: 'sum(rate(all[5m]))' }],
      slos: [{ id: 'avail_99', sli: 'avail', objective: 0.99, window: '30d' }],
      otel: { semconv: '1.27.0', sdk: { sampling: { ratio: 0.1 } } },
      flagish: { enabled: true, count: 42 },
    },
  };

  assert(workspaceInfo().root.startsWith(TMP), 'workspace resolves under the temp dir', workspaceInfo().root, TMP);

  // --- save + load round-trip ---
  saveWorkspacePack('uploaded-ws-test-aaaa1111', { canonical, label: 'WS Test', source: 'unit', createdAt: 1000, lastUsedAt: 1000 });
  saveWorkspacePack('uploaded-ws-two-bbbb2222',  { canonical: { ...canonical, metadata: { ...canonical.metadata, name: 'ws-two' } }, label: 'WS Two', source: 'unit', createdAt: 2000, lastUsedAt: 2000 });

  let packs = loadWorkspacePacks();
  assert(packs.length === 2, 'two saved packs load back', packs.length, 2);
  const p1 = packs.find(p => p.id === 'uploaded-ws-test-aaaa1111');
  assert(!!p1, 'pack id round-trips via filename');
  assert(p1.label === 'WS Test' && p1.source === 'unit', 'index metadata round-trips', { label: p1.label, source: p1.source }, { label: 'WS Test', source: 'unit' });
  assert(JSON.stringify(p1.canonical) === JSON.stringify(canonical),
         'canonical round-trips through YAML byte-equivalently (JSON view)');
  assert(p1.canonical.spec.slos[0].objective === 0.99, 'numbers survive round-trip', p1.canonical.spec.slos[0].objective, 0.99);
  assert(p1.canonical.spec.flagish.enabled === true, 'booleans survive round-trip');

  // Files are inspectable YAML on disk.
  const files = readdirSync(join(TMP, 'packs')).filter(f => f.endsWith('.pack.yaml'));
  assert(files.length === 2, 'one .pack.yaml per pack on disk', files.length, 2);
  assert(existsSync(join(TMP, 'packs', 'index.json')), 'index.json exists');

  // --- touch reorders retention (oldest lastUsedAt first) ---
  touchWorkspacePack('uploaded-ws-test-aaaa1111');
  flushWorkspaceIndex();
  packs = loadWorkspacePacks();
  assert(packs[packs.length - 1].id === 'uploaded-ws-test-aaaa1111',
         'touched pack sorts newest (last) in lastUsedAt order', packs[packs.length - 1].id, 'uploaded-ws-test-aaaa1111');

  // --- delete removes file + index entry ---
  deleteWorkspacePack('uploaded-ws-two-bbbb2222');
  packs = loadWorkspacePacks();
  assert(packs.length === 1 && packs[0].id === 'uploaded-ws-test-aaaa1111', 'delete removes exactly the one pack', packs.map(p => p.id), ['uploaded-ws-test-aaaa1111']);
  assert(!existsSync(join(TMP, 'packs', 'uploaded-ws-two-bbbb2222.pack.yaml')), 'deleted pack file is gone from disk');

  // --- orphan file adoption (hand-copied pack, no index entry) ---
  writeFileSync(join(TMP, 'packs', 'uploaded-orphan-cccc3333.pack.yaml'),
    'apiVersion: observability.platform/v1\nkind: ObservabilityPack\nmetadata:\n  name: orphan\n');
  packs = loadWorkspacePacks();
  const orphan = packs.find(p => p.id === 'uploaded-orphan-cccc3333');
  assert(!!orphan, 'orphan pack file is adopted on load');
  assert(orphan?.source === 'workspace', 'adopted orphan gets workspace source', orphan?.source, 'workspace');
  assert(orphan?.canonical?.metadata?.name === 'orphan', 'orphan canonical parses');

  // --- dangling index entry (file vanished) is pruned ---
  rmSync(join(TMP, 'packs', 'uploaded-orphan-cccc3333.pack.yaml'), { force: true });
  packs = loadWorkspacePacks();
  assert(!packs.find(p => p.id === 'uploaded-orphan-cccc3333'), 'index entry without a file is pruned');
  const idxAfter = JSON.parse(readFileSync(join(TMP, 'packs', 'index.json'), 'utf8'));
  assert(!idxAfter['uploaded-orphan-cccc3333'], 'pruned entry is flushed out of index.json');

  // --- unparseable pack file is skipped, not fatal ---
  writeFileSync(join(TMP, 'packs', 'uploaded-broken-dddd4444.pack.yaml'), '{{{{ not yaml at all: [');
  packs = loadWorkspacePacks();
  assert(!packs.find(p => p.id === 'uploaded-broken-dddd4444'), 'unparseable pack file is skipped');

  // --- deploy audit (10C): append-only JSONL, merge-at-read ---
  appendDeployRecord({ deployId: 'dep_t1', at: '2026-06-10T01:00:00Z', actor: 'local',
    pack: { id: 'uploaded-ws-test-aaaa1111', version: '1.2.3', contentHash: 'aaaa1111' },
    env: 'prod', mcpUrl: 'https://mcp.example/x', target: { product: 'grafana', version: '12', folder: null },
    mode: 'upsert', dryRun: false,
    items: [{ group: 'rules', artifact: 'all', ok: true, tool: 't', operations: 3, bytes: 100, tookMs: 5 }],
    summary: { total: 1, ok: 1, failed: 0 }, tookMs: 5 });
  appendDeployRecord({ deployId: 'dep_t2', at: '2026-06-10T02:00:00Z', actor: 'local',
    pack: { id: 'uploaded-other-ffff9999', version: '0.1.0', contentHash: 'ffff9999' },
    env: null, mcpUrl: 'https://mcp.example/y', target: { product: 'grafana', version: '13', folder: 'obs' },
    mode: 'upsert', dryRun: true, items: [], summary: { total: 0, ok: 0, failed: 0 }, tookMs: 1 });

  let recs = readDeployRecords();
  assert(recs.length === 2, 'two deploy records read back', recs.length, 2);
  assert(recs[0].deployId === 'dep_t2', 'records come back newest first', recs[0].deployId, 'dep_t2');
  assert(recs[0].dryRun === true, 'dry runs are audited too');
  assert(recs[1].items[0].operations === 3, 'item detail round-trips');

  recs = readDeployRecords({ packId: 'uploaded-ws-test-aaaa1111' });
  assert(recs.length === 1 && recs[0].deployId === 'dep_t1', '?pack filter scopes to one pack', recs.map(r => r.deployId), ['dep_t1']);

  // Verify write-back (item 9's contract): a later verify record merges into
  // its deploy at read time — the deploy line itself is never rewritten.
  appendDeployVerify('dep_t1', { outcome: 'verified', transitions: { aligned: 1, pending: 0 } });
  recs = readDeployRecords({ packId: 'uploaded-ws-test-aaaa1111' });
  assert(recs[0].verify?.outcome === 'verified', 'verify record merges into its deploy at read time');
  assert(recs[0].verify?.transitions?.aligned === 1, 'verify payload round-trips');

  // Torn/garbage line is skipped, not fatal.
  appendFileSync(join(TMP, 'deploys.jsonl'), '{"type":"deploy","deployId":"dep_torn"');
  recs = readDeployRecords();
  assert(recs.length === 2 && !recs.find(r => r.deployId === 'dep_torn'), 'torn JSONL line is skipped');

  // limit caps the result set (newest kept).
  recs = readDeployRecords({ limit: 1 });
  assert(recs.length === 1 && recs[0].deployId === 'dep_t2', 'limit keeps the newest record');

  // --- clear wipes packs but NEVER the audit log ---
  const dropped = clearWorkspacePacks();
  assert(dropped >= 2, 'clear reports dropped pack files', dropped, '>=2');
  assert(loadWorkspacePacks().length === 0, 'workspace is empty after clear');
  assert(readDeployRecords().length === 2, 'deploy audit survives a registry clear — reset is not amnesia');

  // --- cache reset honors a re-pointed workspace ---
  const TMP2 = mkdtempSync(join(tmpdir(), 'tomograph-ws2-'));
  process.env.TOMOGRAPH_WORKSPACE = TMP2;
  resetWorkspaceCache();
  saveWorkspacePack('uploaded-relocated-eeee5555', { canonical, label: 'Moved', source: 'unit' });
  assert(existsSync(join(TMP2, 'packs', 'uploaded-relocated-eeee5555.pack.yaml')),
         'TOMOGRAPH_WORKSPACE relocation takes effect after cache reset');
  rmSync(TMP2, { recursive: true, force: true });
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

report('workspace', 'all workspace persistence assertions pass.');
