#!/usr/bin/env node
/**
 * tools/test-backend-live.mjs
 *
 * T4 of docs/TEST_PLAN_COMPILER_VALIDITY.md — the round trip that IS the
 * product story, against a REAL Grafana:
 *
 *   compile → deploy (the server's real /api/packs/:id/deploy-bulk path,
 *   MCP tools, snapshots and all) → fetch the live state back (the real
 *   fetch-live builder) → diff (the real engine) → assert the deployed
 *   set landed ALIGNED.
 *
 * Anything declared-not-live after a successful deploy is, by
 * definition, either a compiler emission bug or a diff/identity bug.
 *
 * Infrastructure: the disposable Grafana from
 * docker/validate.compose.yaml plus tools/lib/grafana-mcp-bridge.mjs —
 * the bridge plays otel-mcp-server's gateway role so the entire ratified
 * MCP chain is exercised. If Grafana isn't reachable and docker can't
 * start it, the suite SKIPS loudly; --strict (CI) turns that into a
 * failure. The Tomograph server runs in-process against a temp
 * workspace, so the host's .tomograph/ is never touched.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const STRICT = process.argv.includes('--strict');
const GRAFANA_URL = process.env.T4_GRAFANA_URL || 'http://127.0.0.1:13000';
const GRAFANA_AUTH = process.env.T4_GRAFANA_AUTH || 'admin:admin';
const COMPOSE_FILE = join(ROOT, 'docker', 'validate.compose.yaml');
const FOLDER = 't4-roundtrip';

// The in-process server must see an isolated workspace BEFORE the module
// loads (workspace paths resolve from this env at call time, but boot
// rehydration runs at start()).
const WORKSPACE = mkdtempSync(join(tmpdir(), 'tomograph-t4-'));
process.env.TOMOGRAPH_WORKSPACE = WORKSPACE;

import { createHarness } from './lib/harness.mjs';
const { assert, failures, report } = createHarness({ indent: '  ', truncate: 400 });

function skip(reason) {
  if (STRICT) {
    assert(false, `T4 preconditions (--strict): ${reason}`);
    report('backend-live');
    return;
  }
  process.stdout.write(`backend-live: SKIPPED — ${reason}\n`);
  process.stdout.write('  (start it with: docker compose -f docker/validate.compose.yaml up -d --wait)\n');
  process.exit(0);
}

async function grafanaUp() {
  try {
    const r = await fetch(`${GRAFANA_URL}/api/health`);
    return r.ok;
  } catch (_) { return false; }
}

async function ensureGrafana() {
  if (await grafanaUp()) return true;
  const probe = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
  if (probe.status !== 0) return false;
  process.stdout.write(`backend-live: starting Grafana via ${COMPOSE_FILE}\n`);
  const up = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d', '--wait'], { encoding: 'utf8', timeout: 300_000 });
  if (up.status !== 0) {
    process.stdout.write(`  docker compose up failed: ${(up.stderr || '').slice(0, 300)}\n`);
    return false;
  }
  for (let i = 0; i < 45; i++) {
    if (await grafanaUp()) return true;
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

async function api(base, path, opts = {}) {
  const res = await fetch(`${base}${path}`, opts);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON */ }
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

// Every name a diff entry answers to — key, ids, titles on either side.
function entryNames(entry) {
  const names = new Set();
  const add = (v) => { if (v && typeof v === 'string') names.add(v); };
  add(entry?.key);
  for (const side of [entry?.artefact, entry?.a, entry?.b]) {
    add(side?.id); add(side?.title); add(side?.name);
  }
  return names;
}

async function main() {
  if (!(await ensureGrafana())) {
    skip(`Grafana not reachable at ${GRAFANA_URL} and docker could not start it`);
    return;
  }
  process.stdout.write(`backend-live: Grafana up at ${GRAFANA_URL}\n`);

  // ---- boot the real server in-process on an ephemeral port ----
  const { start } = await import('../server/index.mjs');
  const srv = await start({ port: 0, host: '127.0.0.1', silent: true });
  const base = `http://127.0.0.1:${srv.address().port}`;

  // ---- the MCP gateway (otel-mcp-server's role) over the real Grafana ----
  const { startGrafanaMcpBridge } = await import('./lib/grafana-mcp-bridge.mjs');
  const bridge = await startGrafanaMcpBridge({ grafanaUrl: GRAFANA_URL, auth: GRAFANA_AUTH, datasourceUid: 'obs-pack-prom' });
  process.stdout.write(`backend-live: MCP bridge at ${bridge.url}\n`);

  try {
    // ---- register Pack A (the canonical spec example) ----
    const packYaml = readFileSync(join(ROOT, 'vendor/observability-pack-spec/v1.2/examples/payment-service.pack.yaml'), 'utf8');
    const reg = await api(base, '/api/validate?env=prod&source=t4-pack-a', {
      method: 'POST', headers: { 'Content-Type': 'text/yaml' }, body: packYaml,
    });
    assert(reg.ok === true && reg.registered?.id, 'Pack A registers via /api/validate', reg.registered, 'registered id');
    const packAId = reg.registered.id;
    const { parse: parseYaml } = await import('./lib/mini-yaml.mjs');
    const canonical = parseYaml(packYaml);
    const dashboardIds = (canonical?.spec?.dashboards || []).map(d => d.id);

    // ---- deploy through the REAL bulk path ----
    const items = [
      { group: 'rules', artifact: 'all', scope: 'both' },
      ...dashboardIds.map(id => ({ group: 'dashboards', dashboardId: id })),
    ];
    const deploy = await api(base, `/api/packs/${encodeURIComponent(packAId)}/deploy-bulk?env=prod`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mcpUrl: bridge.url,
        targetProduct: 'grafana',
        targetVersion: '12',
        targetFolder: FOLDER,
        mode: 'upsert',
        items,
      }),
    });
    const results = deploy.results || [];
    assert(results.length === items.length, 'deploy-bulk returns one result per item', results.length, items.length);
    for (const r of results) {
      assert(r.ok === true, `deploy item ok · ${r.item?.group}${r.item?.dashboardId ? ':' + r.item.dashboardId : ''}`,
        r.error || r, 'ok: true');
    }
    const deployedRuleNames = results
      .filter(r => r.ok && r.item?.group === 'rules')
      .flatMap(r => (r.result || []).map(c => c.name)).filter(Boolean);
    const deployedKinds = results
      .filter(r => r.ok && r.item?.group === 'rules')
      .flatMap(r => (r.result || []).map(c => c.kind));
    assert(deployedRuleNames.length > 0, 'rules deploy expanded into per-rule MCP calls', deployedRuleNames.length, '> 0');
    process.stdout.write(`  deployed: ${deployedRuleNames.length} rules (${deployedKinds.filter(k => k === 'alerting').length} alerting · ${deployedKinds.filter(k => k === 'recording').length} recording) + ${dashboardIds.length} dashboards\n`);

    // ---- authoritative read-back straight from Grafana ----
    const gfAuth = { headers: { Authorization: `Basic ${Buffer.from(GRAFANA_AUTH).toString('base64')}` } };
    const search = await api(GRAFANA_URL, '/api/search?type=dash-db&limit=200', gfAuth);
    // Compiled dashboards carry title = dash.id; uids are capped +
    // fingerprinted, so titles are the stable read-back identity.
    const liveDashTitles = new Set((search || []).map(d => d.title));
    for (const id of dashboardIds) {
      assert(liveDashTitles.has(id),
        `dashboard '${id}' exists in Grafana after deploy`, [...liveDashTitles].join(','), id);
    }
    const provisioned = await api(GRAFANA_URL, '/api/v1/provisioning/alert-rules', gfAuth);
    const liveRuleTitles = new Set((provisioned || []).map(r => r.title));
    for (const name of deployedRuleNames) {
      assert(liveRuleTitles.has(name), `rule '${name}' exists in Grafana provisioning after deploy`,
        [...liveRuleTitles].slice(0, 12).join(','), name);
    }

    // ---- fetch the live state back through the REAL fetch-live builder ----
    const { buildAndValidate } = await import('./fetch-live-pack.mjs');
    const { emit: emitYaml } = await import('./lib/mini-yaml.mjs');
    const { pack: packB } = await buildAndValidate({ mcpUrl: bridge.url, packName: 'payment-service' });
    assert(!!packB?.metadata?.name, 'fetch-live builds a schema-valid Pack B from the bridge');
    const regB = await api(base, '/api/validate?env=prod&source=t4-pack-b-live', {
      method: 'POST', headers: { 'Content-Type': 'text/yaml' }, body: emitYaml(packB),
    });
    assert(regB.ok === true && regB.registered?.id, 'Pack B registers via /api/validate');
    const packBId = regB.registered.id;

    // ---- THE diff — the engine's verdict on the round trip ----
    const diff = await api(base, `/api/diff?a=${encodeURIComponent(packAId)}&b=${encodeURIComponent(packBId)}&aEnv=prod&scopeMode=all`);
    assert(!!diff?.layers, 'diff engine produces layers');

    // Every deployed artefact must be CONFIRMED LIVE — i.e. absent from
    // every onlyInA bucket. Declared-not-live after a successful deploy
    // is the exact failure class T4 exists to catch.
    const deployedNames = new Set([...deployedRuleNames, ...dashboardIds]);
    const missingLive = [];
    for (const [L, bucket] of Object.entries(diff.layers)) {
      for (const entry of bucket?.onlyInA || []) {
        if (entry?.artefact?.source === 'Scaffold') continue;
        const names = entryNames(entry);
        for (const dn of deployedNames) {
          if (names.has(dn) || [...names].some(n => n.includes(dn))) {
            missingLive.push(`${L}: ${dn}`);
          }
        }
      }
    }
    assert(missingLive.length === 0,
      `every deployed artefact is confirmed live by the diff (${deployedNames.size} deployed)`,
      missingLive.join(' · '), 'none declared-not-live');

    // Deployed artefacts that came back DRIFTED must not drift on
    // decision-bearing fields — cosmetic round-trip rewrites are
    // tolerated (Grafana normalises), behaviour changes are not.
    const { driftedEntryBadness } = await import('../studio/diagnostic-grade.mjs');
    const decisionDrift = [];
    let driftedDeployed = 0;
    for (const [L, bucket] of Object.entries(diff.layers)) {
      for (const entry of (bucket?.inBoth || []).filter(e => e.match === 'drifted')) {
        const names = entryNames(entry);
        const isDeployed = [...deployedNames].some(dn => names.has(dn) || [...names].some(n => n.includes(dn)));
        if (!isDeployed) continue;
        driftedDeployed++;
        const cost = driftedEntryBadness(entry);
        if (cost.className === 'decision') {
          decisionDrift.push(`${L}: ${[...names][0]} (${(entry.deltas || []).map(d => d.field).join(',')})`);
        }
      }
    }
    assert(decisionDrift.length === 0,
      `no decision-bearing drift on deployed artefacts (${driftedDeployed} drifted cosmetically/default)`,
      decisionDrift.join(' · '), 'none');

    process.stdout.write(`\n  round trip: ${deployedNames.size} deployed → all confirmed live · ${driftedDeployed} round-trip drift (non-decision)\n`);
  } finally {
    await bridge.close();
    await new Promise(r => srv.close(r));
    rmSync(WORKSPACE, { recursive: true, force: true });
  }

  report('backend-live');
}

main().catch(e => {
  process.stdout.write(`  ✗ backend-live threw: ${e.stack || e.message}\n`);
  failures.push(String(e.message));
  report('backend-live');
});
