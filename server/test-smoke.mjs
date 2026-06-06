#!/usr/bin/env node
/**
 * server/test-smoke.mjs
 *
 * Smoke test for the Express server. Boots on an ephemeral port, hits each
 * route, asserts response shape, then kills the server. Exit 0 = pass.
 */

import { start } from './index.mjs';

const failures = [];
function assert(cond, label, got, want) {
  if (cond) { process.stdout.write(`✓ ${label}\n`); return; }
  const detail = got !== undefined ? `\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}` : '';
  failures.push(`${label}${detail}`);
  process.stdout.write(`✗ ${label}${detail}\n`);
}

async function getJson(base, path) {
  const r = await fetch(`${base}${path}`);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

async function getText(base, path) {
  const r = await fetch(`${base}${path}`);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.text();
}

const srv = await start({ port: 0, silent: true });
const addr = srv.address();
const base = `http://${addr.address}:${addr.port}`;
process.stdout.write(`[smoke] server listening on ${base}\n`);

try {
  // /healthz
  const health = await getJson(base, '/healthz');
  assert(health.ok === true, 'GET /healthz returns ok');
  assert(health.specVersion === '1.2', 'GET /healthz reports specVersion 1.2');

  // /api/packs catalog
  const catalog = await getJson(base, '/api/packs');
  assert(Array.isArray(catalog.packs), 'GET /api/packs returns packs[]');
  assert(catalog.packs.length >= 4, 'GET /api/packs returns at least 4 packs (Phase 5 catalog)', catalog.packs.length, '>= 4');
  for (const id of ['payment-service', 'target-advanced', 'production-curated', 'demo-skeleton']) {
    const entry = catalog.packs.find(p => p.id === id);
    assert(!!entry && entry.ok === true, `catalog entry '${id}' loads ok`, entry?.error, 'ok');
  }
  const target = catalog.packs.find(p => p.id === 'target-advanced');
  assert(target?.criticality === 'tier-1', 'target-advanced declares tier-1');
  const demo = catalog.packs.find(p => p.id === 'demo-skeleton');
  assert(demo?.criticality === 'tier-3', 'demo-skeleton declares tier-3');
  const example = catalog.packs.find(p => p.id === 'payment-service');
  assert(!!example, 'catalog includes payment-service');
  assert(example?.ok === true, 'payment-service loaded ok');
  assert(example?.name === 'payment-service', 'payment-service name');
  assert(example?.criticality === 'tier-1', 'payment-service criticality');
  assert(example?.environments?.length === 2, 'payment-service environments count');
  const live = catalog.packs.find(p => p.id === 'production-live');
  assert(!!live, 'catalog includes production-live entry');
  // The cron writes packs/production-live.pack.yaml; in CI the file may not
  // exist yet, in which case catalog reports ok:false with an error message.
  if (live.ok) {
    assert(live.name === 'production-live', 'production-live pack name when present');
  } else {
    assert(/pack file missing|file not found|ENOENT/i.test(live.error || ''),
           'production-live missing-file error is surfaced cleanly');
  }

  // /api/packs/:id default env
  const adapted = await getJson(base, '/api/packs/payment-service');
  assert(adapted.meta?.apiVersion === 'observability.platform/v1', 'adapted meta.apiVersion');
  assert(adapted.meta?.environment === 'prod', 'adapted default env = prod');
  assert(adapted.meta?.target === 'ske', 'adapted default target ske');
  assert(adapted.layers?.L1?.length === 10, 'adapted L1 count', adapted.layers?.L1?.length, 10);
  assert(adapted.layers?.L2X?.length === 7, 'adapted L2X count', adapted.layers?.L2X?.length, 7);
  assert(adapted.layers?.L4?.policy?.length === 6, 'adapted L4.policy count');

  // /api/packs/:id with env override
  const staging = await getJson(base, '/api/packs/payment-service?env=staging');
  assert(staging.meta?.environment === 'staging', 'staging env selected');
  assert(staging.meta?.target === 'bare-k8s', 'staging target = bare-k8s');
  const stgOtel = staging.layers.L2.find(a => a.id === 'OTEL-01');
  assert(stgOtel?.spec?.sdk?.sampling?.ratio === 1, 'staging sampling.ratio override applied');

  // /api/packs/:id/canonical
  const canonical = await getJson(base, '/api/packs/payment-service/canonical?env=staging');
  assert(canonical.apiVersion === 'observability.platform/v1', 'canonical apiVersion');
  assert(canonical.kind === 'ObservabilityPack', 'canonical kind');
  assert(canonical.__effectiveEnvironment === 'staging', 'canonical effective env');
  assert(canonical.spec?.otel?.sdk?.sampling?.ratio === 1, 'canonical staging sampling override');

  // /api/packs/:id 404
  const notFound = await fetch(`${base}/api/packs/does-not-exist`);
  assert(notFound.status === 404, 'unknown pack returns 404');

  // /api/packs/:id/conformance
  const conformance = await getJson(base, '/api/packs/payment-service/conformance');
  assert(conformance.declaredTier === 'tier-1', 'conformance tier');
  assert(typeof conformance.scorePercent === 'number', 'conformance scorePercent is a number');
  assert(typeof conformance.mustPercent  === 'number', 'conformance mustPercent is a number');
  assert(Array.isArray(conformance.clauses), 'conformance clauses array');
  assert(conformance.clauses.length >= 20, 'conformance has >= 20 clauses');
  assert(conformance.byDimension?.L1?.mustTotal >= 1, 'conformance byDimension populated');
  const passClause = conformance.clauses.find(c => c.id === 'L1.MUST.availability_slo');
  assert(passClause?.pass === true, 'availability SLO clause passes on example');
  const failClause = conformance.clauses.find(c => c.id === 'L3.MUST.recording_rule_per_slo');
  assert(failClause?.pass === false, 'recording-rule-per-SLO clause flags real gap in example');

  // /api/packs/:id/conformance ?env= overlays
  const stgConf = await getJson(base, '/api/packs/payment-service/conformance?env=staging');
  assert(stgConf.declaredTier === 'tier-2', 'staging env overlay reports tier-2');

  // /api/diff
  const diff = await getJson(base, '/api/diff?a=target-advanced&b=demo-skeleton');
  // .id is the canonical metadata.name (consistent with /api/packs/:id)
  assert(diff.a?.id === 'platform-edge',  'diff.a.id = target-advanced metadata.name');
  assert(diff.b?.id === 'demo-skeleton',  'diff.b.id = demo-skeleton metadata.name');
  assert(diff.a?.criticality === 'tier-1', 'diff.a carries criticality');
  assert(diff.b?.criticality === 'tier-3', 'diff.b carries criticality');
  assert(typeof diff.summary?.onlyInA === 'number', 'diff.summary.onlyInA present');
  assert(typeof diff.summary?.inBoth  === 'number', 'diff.summary.inBoth present');
  assert(typeof diff.summary?.jaccard === 'number', 'diff.summary.jaccard present');
  assert(diff.summary.aTotal > diff.summary.bTotal,
         'target-advanced has more artefacts than demo-skeleton',
         { aTotal: diff.summary.aTotal, bTotal: diff.summary.bTotal },
         'aTotal > bTotal');
  assert(Array.isArray(diff.layers?.L1?.onlyInA), 'diff.layers.L1.onlyInA array');
  assert(Array.isArray(diff.layers?.L4?.inBoth),  'diff.layers.L4.inBoth array (sub-layers flattened)');
  // missing args
  const badDiff = await fetch(`${base}/api/diff?a=target-advanced`);
  assert(badDiff.status === 400, 'diff with missing b → 400');
  const unknownPack = await fetch(`${base}/api/diff?a=target-advanced&b=nope`);
  assert(unknownPack.status === 404, 'diff with unknown pack id → 404');

  // /api/compile/targets
  const compTargets = await getJson(base, '/api/compile/targets');
  assert(Array.isArray(compTargets.targets) && compTargets.targets.length === 4,
         '/api/compile/targets returns 4 target descriptors');
  const targetIds = compTargets.targets.map(t => t.id);
  for (const need of ['prometheus-rules', 'otel-collector', 'alertmanager', 'grafana-dashboard']) {
    assert(targetIds.includes(need), `compile target catalog includes ${need}`);
  }

  // /api/packs/:id/compile/prometheus-rules
  const rulesRes = await fetch(`${base}/api/packs/payment-service/compile/prometheus-rules`);
  assert(rulesRes.status === 200, 'compile prometheus-rules → 200');
  const rulesCt = rulesRes.headers.get('content-type') || '';
  assert(rulesCt.includes('application/x-yaml'), 'rules content-type is yaml', rulesCt, 'application/x-yaml');
  assert(rulesRes.headers.get('x-pack-source') === 'payment-service@1.5.0',
         'rules carry X-Pack-Source provenance header');
  assert(rulesRes.headers.get('x-compile-target') === 'prometheus-rules',
         'rules carry X-Compile-Target header');
  const rulesText = await rulesRes.text();
  assert(rulesText.includes('groups:'),  'rules text contains groups:');
  assert(rulesText.includes(':ratio_5m'), 'rules emit :ratio_5m records');
  assert(rulesText.includes('burn_'),     'rules emit burn-rate alerts');

  // /api/packs/:id/compile/grafana-dashboard?dashboardId=...&download=1
  const dashRes = await fetch(`${base}/api/packs/payment-service/compile/grafana-dashboard?dashboardId=payment-overview&download=1`);
  assert(dashRes.status === 200, 'grafana dashboard compile → 200');
  assert((dashRes.headers.get('content-type') || '').includes('application/json'),
         'dashboard content-type is json');
  assert((dashRes.headers.get('content-disposition') || '').includes('attachment'),
         'download=1 returns Content-Disposition: attachment');
  const dashJson = await dashRes.json();
  assert(dashJson.schemaVersion >= 30, 'dashboard schemaVersion >= 30');
  assert(Array.isArray(dashJson.panels), 'dashboard has panels[]');

  // /api/packs/:id/compile/<unknown> → 400
  const badTarget = await fetch(`${base}/api/packs/payment-service/compile/no-such-target`);
  assert(badTarget.status === 400, 'unknown compile target → 400');

  // /api/packs/<unknown>/compile/prometheus-rules → 404
  const badPack = await fetch(`${base}/api/packs/does-not-exist/compile/prometheus-rules`);
  assert(badPack.status === 404, 'unknown pack on compile → 404');

  // POST /api/packs/:id/deploy/:target — missing mcpUrl → 400
  const deployNoUrl = await fetch(`${base}/api/packs/payment-service/deploy/prometheus-rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert(deployNoUrl.status === 400, 'deploy without mcpUrl → 400');
  const deployBody = await deployNoUrl.json();
  assert(/mcpUrl/.test(deployBody.error || ''), 'deploy 400 mentions mcpUrl');

  // POST /api/packs/:id/deploy/:target — unknown pack → 404
  const deployBadPack = await fetch(`${base}/api/packs/does-not-exist/deploy/prometheus-rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mcpUrl: 'http://127.0.0.1:1/no' }),
  });
  assert(deployBadPack.status === 404, 'deploy unknown pack → 404');

  // POST /api/packs/:id/deploy/:target — unreachable MCP → 502 (still JSON)
  const deployBadMcp = await fetch(`${base}/api/packs/payment-service/deploy/prometheus-rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mcpUrl: 'http://127.0.0.1:1/no-mcp' }),
  });
  assert(deployBadMcp.status === 502, 'deploy unreachable MCP → 502');
  const deployErr = await deployBadMcp.json();
  assert(deployErr.tool === 'apply_prometheus_rules',
         'deploy 502 echoes the default MCP tool name for this target');
  assert(deployErr.target === 'prometheus-rules', 'deploy 502 echoes the target');

  // /api/maturity-rubric
  const rubric = await getJson(base, '/api/maturity-rubric');
  assert(rubric.specVersion === '1.2', 'rubric specVersion 1.2');
  assert(Array.isArray(rubric.clauses) && rubric.clauses.length >= 20, 'rubric clauses present');
  assert(!('evaluate' in (rubric.clauses[0] || {})), 'rubric clauses do not leak evaluate function');

  // /api/live-status — returns either {present: false} or details
  const liveStatus = await getJson(base, '/api/live-status');
  assert('present' in liveStatus, '/api/live-status responds with `present` flag');
  if (liveStatus.present) {
    assert(typeof liveStatus.refreshedAt === 'string' || liveStatus.refreshedAt === null,
           'live-status surfaces refreshedAt when present');
  }

  // POST /api/refresh-live — missing mcpUrl
  const badRefresh = await fetch(`${base}/api/refresh-live`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert(badRefresh.status === 400, 'POST /api/refresh-live rejects empty body with 400');
  const badRefreshBody = await badRefresh.json();
  assert(badRefreshBody.ok === false && /mcpUrl/.test(badRefreshBody.error || ''),
         'refresh-live error mentions mcpUrl');

  // POST /api/refresh-live — unreachable mcpUrl
  const unreachable = await fetch(`${base}/api/refresh-live`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mcpUrl: 'http://127.0.0.1:1/no-mcp' }),
  });
  assert(unreachable.status === 502, 'POST /api/refresh-live surfaces 502 on MCP failure');

  // POST /api/validate — valid canonical (use staging-with-effective shape rejected by additionalProperties)
  // Send a minimal valid canonical pack: re-fetch the raw vendored example via the canonical route (without env)
  const raw = await getJson(base, '/api/packs/payment-service/canonical');
  // strip the server's annotations so it round-trips through validate
  delete raw.__effectiveEnvironment;
  delete raw.__effective;
  const validateRes = await fetch(`${base}/api/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(raw),
  }).then(r => r.json());
  assert(validateRes.ok === true, 'POST /api/validate accepts a valid canonical pack', validateRes.errors, []);
  assert(validateRes.adapted?.meta?.apiVersion === 'observability.platform/v1', 'validate response includes adapted layered pack');
  assert(typeof validateRes.conformance?.scorePercent === 'number', 'validate response includes conformance report');

  // POST /api/validate — pre-1.2 should fail gatekeeper
  const bad = await fetch(`${base}/api/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'legacy', name: 'legacy', layers: {} }),
  }).then(r => r.json());
  assert(bad.ok === false, 'POST /api/validate rejects pre-1.2 input');
  assert((bad.errors || []).some(e => /not a canonical/.test(e)), 'gatekeeper error is descriptive');

  // GET / returns the studio shell
  const html = await getText(base, '/');
  assert(html.includes('<title>ObservabilityPack Studio</title>'), 'GET / returns studio shell');
  assert(html.includes('/app.mjs'), 'shell loads app.mjs');
  assert(html.includes('/app.css'), 'shell loads app.css');

  // Static assets
  const css = await getText(base, '/app.css');
  assert(css.includes('--L2X:'), '/app.css served with L2X palette');
  const js = await getText(base, '/app.mjs');
  assert(js.includes('LAYER_DEFS'), '/app.mjs served');
  const atlasJs = await getText(base, '/atlases.mjs');
  // Phases 7c + 7g now ship strata, periodic, constellation, skyline.
  // Transit + Arbor return in a later restoration PR.
  for (const fn of ['renderStrata', 'renderPeriodic', 'renderConstellation', 'renderSkyline']) {
    assert(atlasJs.includes(fn), `/atlases.mjs includes ${fn}`);
  }
} finally {
  await new Promise(r => srv.close(r));
}

if (failures.length) {
  process.stderr.write(`\n${failures.length} smoke assertion(s) failed.\n`);
  process.exit(1);
}
process.stdout.write(`\nall server smoke assertions pass.\n`);
