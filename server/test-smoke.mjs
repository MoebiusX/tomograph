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

  // /api/packs catalog — empty by design as of Phase 7q (the studio
  // boots empty; user opens packs from disk via Upload / crawler /
  // MCP draft / examples browser).
  const catalog = await getJson(base, '/api/packs');
  assert(Array.isArray(catalog.packs), 'GET /api/packs returns packs[]');
  assert(catalog.packs.length === 0, 'GET /api/packs returns empty catalog (Phase 7q)', catalog.packs.length, 0);

  // /api/examples — the 5 archived reference packs
  const examples = await getJson(base, '/api/examples');
  assert(Array.isArray(examples.examples), 'GET /api/examples returns examples[]');
  assert(examples.examples.length === 5, 'examples lists all 5 archived packs', examples.examples.length, 5);
  for (const id of ['payment-service', 'target-advanced', 'production-curated', 'demo-skeleton']) {
    const entry = examples.examples.find(p => p.id === id);
    assert(!!entry && entry.ok === true, `example '${id}' loads ok from examples/`, entry?.error, 'ok');
  }
  const target = examples.examples.find(p => p.id === 'target-advanced');
  assert(target?.criticality === 'tier-1', 'target-advanced declares tier-1');
  const demo = examples.examples.find(p => p.id === 'demo-skeleton');
  assert(demo?.criticality === 'tier-3', 'demo-skeleton declares tier-3');
  const example = examples.examples.find(p => p.id === 'payment-service');
  assert(!!example, 'examples include payment-service');
  assert(example?.criticality === 'tier-1', 'payment-service criticality');
  assert(example?.environments?.length === 2, 'payment-service environments count');
  const live = examples.examples.find(p => p.id === 'production-live');
  assert(!!live, 'examples include production-live entry');
  // The cron writes examples/production-live.pack.yaml; in CI the file
  // may not exist yet, in which case the entry reports ok:false.
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

  // --- Compile redesign (Phase 7m): per-artifact catalog + endpoint ---
  const compCat = await getJson(base, '/api/packs/payment-service/compile-catalog');
  assert(Array.isArray(compCat.groups), 'compile-catalog returns groups');
  const groupIds = compCat.groups.map(g => g.id);
  assert(groupIds.includes('rules'), 'catalog has a rules group');
  assert(groupIds.includes('dashboards'), 'catalog has a dashboards group');
  assert(groupIds.includes('pipelines'), 'catalog has a pipelines group');
  assert(groupIds.includes('alertmanager'), 'catalog has an alertmanager group');
  const rulesGroup = compCat.groups.find(g => g.id === 'rules');
  const rulesFlavorIds = rulesGroup.flavors.map(f => f.id);
  assert(rulesFlavorIds.includes('prometheus'), 'rules group has Prometheus flavor');
  assert(rulesFlavorIds.includes('grafana-managed'), 'rules group has Grafana-managed flavor');
  for (const f of rulesGroup.flavors) {
    assert(typeof f.platform === 'string' && f.platform.length > 5,
           `flavor "${f.id}" declares an explicit target platform string`);
    assert(typeof f.description === 'string' && f.description.length > 10,
           `flavor "${f.id}" declares a description`);
  }
  const rulesItemIds = rulesGroup.items.map(it => it.id);
  assert(rulesItemIds.includes('all'),                    'rules items include "all"');
  assert(rulesItemIds.some(id => id.startsWith('slo:')),  'rules items include per-SLO entries');
  const firstSloId = rulesItemIds.find(id => id.startsWith('slo:'));

  // Per-artifact compile: Prometheus per-SLO
  const promSloRes = await fetch(`${base}/api/packs/payment-service/compile-artifact?group=rules&flavor=prometheus&artifact=${encodeURIComponent(firstSloId)}`);
  assert(promSloRes.status === 200, 'per-SLO Prometheus compile → 200');
  assert((promSloRes.headers.get('content-type') || '').includes('application/x-yaml'),
         'per-SLO Prometheus content-type is yaml');
  assert(promSloRes.headers.get('x-compile-flavor') === 'prometheus',
         'per-SLO Prometheus echoes X-Compile-Flavor');
  assert(promSloRes.headers.get('x-compile-artifact') === firstSloId,
         'per-SLO Prometheus echoes X-Compile-Artifact');
  const promSloText = await promSloRes.text();
  const sloIdOnly = firstSloId.slice(4);
  assert(promSloText.includes(sloIdOnly), `per-SLO Prometheus contains the SLO id (${sloIdOnly})`);
  assert(!promSloText.includes('apiVersion: 1'),
         'per-SLO Prometheus does NOT use the Grafana-managed apiVersion header');

  // Per-artifact compile: Grafana-managed per-SLO
  const grafSloRes = await fetch(`${base}/api/packs/payment-service/compile-artifact?group=rules&flavor=grafana-managed&artifact=${encodeURIComponent(firstSloId)}`);
  assert(grafSloRes.status === 200, 'per-SLO Grafana-managed compile → 200');
  const grafSloText = await grafSloRes.text();
  assert(grafSloText.includes('apiVersion: 1'),
         'per-SLO Grafana-managed uses Grafana provisioning apiVersion: 1');
  assert(grafSloText.includes('folder: observability-pack'),
         'per-SLO Grafana-managed declares the folder');
  assert(grafSloText.includes('refId'),
         'per-SLO Grafana-managed emits Grafana query data with refIds');

  // Per-artifact compile: single dashboard
  const dashRes2 = await fetch(`${base}/api/packs/payment-service/compile-artifact?group=dashboards&flavor=grafana&artifact=dash:payment-overview`);
  assert(dashRes2.status === 200, 'per-artifact dashboard compile → 200');
  assert((dashRes2.headers.get('content-type') || '').includes('application/json'),
         'per-artifact dashboard content-type is json');

  // Catalog reflects the env overlay
  const compCatStaging = await getJson(base, '/api/packs/payment-service/compile-catalog?env=staging');
  assert(compCatStaging.env === 'staging', 'catalog echoes env when provided');

  // Bad group → 500-with-message (handled as JSON)
  const badGroup = await fetch(`${base}/api/packs/payment-service/compile-artifact?group=does-not-exist`);
  assert(badGroup.status === 500, 'unknown compile group → 500 (error JSON)');
  const badGroupBody = await badGroup.json();
  assert(/unknown compile group/.test(badGroupBody.error || ''),
         'unknown group error message names the bad group kind');

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
  // Default deploy is to Grafana 12 with scope=both → apply_grafana_rules.
  assert(deployErr.tool === 'apply_grafana_rules',
         'deploy 502 echoes the default tool for prometheus-rules → Grafana 12 + scope=both');
  assert(deployErr.target === 'prometheus-rules', 'deploy 502 echoes the target');
  assert(deployErr.targetProduct === 'grafana', 'deploy 502 echoes targetProduct');
  assert(deployErr.targetVersion === '12', 'deploy 502 echoes targetVersion');
  assert(deployErr.scope === 'both', 'deploy 502 echoes scope (both)');

  // Deploy v2 — target product / version / scope wiring
  const matrix = await getJson(base, '/api/deploy/matrix');
  assert(Array.isArray(matrix.products) && matrix.products.includes('grafana'),
         '/api/deploy/matrix lists grafana as a product');
  assert(Array.isArray(matrix.versions?.grafana) && matrix.versions.grafana.includes('12') && matrix.versions.grafana.includes('13'),
         '/api/deploy/matrix lists Grafana versions 12 and 13');
  assert(matrix.targets?.['prometheus-rules']?.deployable === true,
         'matrix marks prometheus-rules deployable');
  assert(matrix.targets?.['grafana-dashboard']?.deployable === true,
         'matrix marks grafana-dashboard deployable');
  assert(matrix.targets?.['otel-collector']?.deployable === false,
         'matrix marks otel-collector NOT deployable');
  assert(matrix.targets?.['alertmanager']?.deployable === false,
         'matrix marks alertmanager NOT deployable');

  // Deploy on a non-deployable target → 400 with a clear message
  const deployUndeployable = await fetch(`${base}/api/packs/payment-service/deploy/otel-collector`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mcpUrl: 'http://127.0.0.1:1/no' }),
  });
  assert(deployUndeployable.status === 400, 'deploy to undeployable target → 400');
  const undeployableBody = await deployUndeployable.json();
  assert(/not supported/.test(undeployableBody.error || ''),
         'undeployable error mentions "not supported"');

  // Deploy with unknown target version → 400
  const deployBadVer = await fetch(`${base}/api/packs/payment-service/deploy/prometheus-rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mcpUrl: 'http://127.0.0.1:1/no', targetVersion: '11' }),
  });
  assert(deployBadVer.status === 400, 'deploy with bad target version → 400');
  const badVerBody = await deployBadVer.json();
  assert(/unsupported.*version/i.test(badVerBody.error || ''),
         'bad-version error names the unsupported version');

  // Deploy with scope=recording → default tool flips to recording variant
  const deployRecording = await fetch(`${base}/api/packs/payment-service/deploy/prometheus-rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mcpUrl: 'http://127.0.0.1:1/no', scope: 'recording' }),
  });
  assert(deployRecording.status === 502, 'deploy with scope=recording → 502 from unreachable mcp');
  const recBody = await deployRecording.json();
  assert(recBody.tool === 'apply_grafana_recording_rules',
         'scope=recording defaults to apply_grafana_recording_rules');
  assert(recBody.scope === 'recording', 'echoes scope=recording');

  // Deploy with scope=alerting → default tool flips again
  const deployAlerting = await fetch(`${base}/api/packs/payment-service/deploy/prometheus-rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mcpUrl: 'http://127.0.0.1:1/no', scope: 'alerting', targetVersion: '13' }),
  });
  const alrBody = await deployAlerting.json();
  assert(alrBody.tool === 'apply_grafana_alerting_rules',
         'scope=alerting defaults to apply_grafana_alerting_rules');
  assert(alrBody.targetVersion === '13', 'echoes Grafana 13');

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
  assert(html.includes('<title>Tomograph</title>'), 'GET / returns studio shell');
  assert(html.includes('/app.mjs'), 'shell loads app.mjs');
  assert(html.includes('/app.css'), 'shell loads app.css');

  // POST /api/crawl — Path A of pack creation. Real fixture: docker-compose
  // + Prometheus rules + Alertmanager + Grafana dashboard. Output must pass
  // canonical schema and surface evidence pointers.
  const crawlBody = {
    repoName: 'smoke-crawl',
    files: {
      'docker-compose.yml': `version: '3.8'\nservices:\n  prometheus:\n    image: prom/prometheus:v2.51.0\n    ports: ["9090:9090"]\n  grafana:\n    image: grafana/grafana:12.0.0\n    ports: ["3000:3000"]\n`,
      'rules.yml': `groups:\n  - name: g\n    rules:\n      - record: smoke:availability:ratio\n        expr: sum(rate(req_total[5m]))\n`,
      'dashboards/svc.json': JSON.stringify({ title: 'svc', uid: 'svc', schemaVersion: 41, version: 1, panels: [{ title: 'p', type: 'stat' }] }),
      'alertmanager.yml': `route:\n  receiver: oncall\nreceivers:\n  - name: oncall\n    msteams_configs:\n      - channel_url: '#oncall'\n`,
    },
  };
  const crawlRes = await fetch(`${base}/api/crawl`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(crawlBody),
  });
  assert(crawlRes.status === 200, 'POST /api/crawl returns 200 on valid input');
  const crawlOut = await crawlRes.json();
  assert(crawlOut.ok === true, 'crawl ok');
  assert(crawlOut.canonical?.apiVersion === 'observability.platform/v1', 'crawl emits canonical v1');
  assert(crawlOut.canonical?.metadata?.name === 'smoke-crawl', 'crawl honors repoName');
  assert(Array.isArray(crawlOut.canonical?.spec?.telemetry?.backends), 'crawl emits telemetry.backends');
  assert(crawlOut.canonical.spec.telemetry.backends.some(b => b.product === 'prometheus'),
         'crawl discovers prometheus backend from docker-compose');
  assert(crawlOut.canonical.spec.queries.recording_rules.some(r => r.name === 'smoke:availability:ratio'),
         'crawl preserves recording rule name');
  assert(crawlOut.canonical.spec.dashboards.some(d => d.provider?.kind === 'grafana'),
         'crawl emits grafana dashboard');
  assert(crawlOut.validation?.ok === true,
         `crawl output passes v1.2 schema (errors: ${JSON.stringify(crawlOut.validation?.errors || []).slice(0, 200)})`);
  assert(typeof crawlOut.canonicalYaml === 'string' && crawlOut.canonicalYaml.includes('apiVersion'),
         'crawl returns canonical YAML');
  assert(crawlOut.summary?.discovered?.backends >= 2, 'crawl summary counts ≥2 backends');
  assert(crawlOut.evidence && Object.keys(crawlOut.evidence).length >= 3,
         'crawl returns evidence pointers');
  assert(typeof crawlOut.conformance?.declaredTier === 'string',
         'crawl includes conformance report');

  // POST /api/crawl — empty body → 400
  const crawlEmpty = await fetch(`${base}/api/crawl`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert(crawlEmpty.status === 400, 'POST /api/crawl rejects empty body with 400');

  // POST /api/crawl — non-string value → 400
  const crawlBad = await fetch(`${base}/api/crawl`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: { 'x.yml': 123 } }),
  });
  assert(crawlBad.status === 400, 'POST /api/crawl rejects non-string content with 400');

  // Shell carries the crawler panel scaffolding (Phase 7j-2)
  const shell = await getText(base, '/');
  assert(shell.includes('id="crawl-panel"'), 'shell includes #crawl-panel');
  assert(shell.includes('id="crawl-dropzone"'), 'shell includes the dropzone');
  assert(shell.includes('id="crawl-btn"'), 'shell includes the "new from repo" button');

  // Shell carries the Path B "new from live" surface (Phase 7n)
  assert(shell.includes('id="draft-mcp-panel"'), 'shell includes #draft-mcp-panel');
  assert(shell.includes('id="draft-mcp-btn"'), 'shell includes the "new from live" button');
  assert(shell.includes('id="draft-mcp-go-btn"'), 'shell includes the draft submit button');

  // /api/draft-from-mcp — empty body
  const draftEmpty = await fetch(`${base}/api/draft-from-mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert(draftEmpty.status === 400, 'POST /api/draft-from-mcp without mcpUrl → 400');
  const draftEmptyBody = await draftEmpty.json();
  assert(/mcpUrl/.test(draftEmptyBody.error || ''),
         'draft-from-mcp 400 mentions mcpUrl');

  // /api/draft-from-mcp — unreachable MCP returns 502 with JSON
  const draftBad = await fetch(`${base}/api/draft-from-mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mcpUrl: 'http://127.0.0.1:1/no-mcp' }),
  });
  assert(draftBad.status === 502, 'POST /api/draft-from-mcp unreachable → 502');
  assert((draftBad.headers.get('content-type') || '').includes('application/json'),
         'draft-from-mcp 502 is JSON');

  // /lib/* — shared crawler + YAML library exposed to the browser so it
  // can do classification BEFORE blasting a 3000-file repo at the
  // server. Same module the CLI + server use.
  const libCrawler = await fetch(`${base}/lib/crawler.mjs`);
  assert(libCrawler.status === 200, '/lib/crawler.mjs served');
  assert((libCrawler.headers.get('content-type') || '').includes('javascript'),
         '/lib/crawler.mjs served as application/javascript');
  const libCrawlerBody = await libCrawler.text();
  assert(libCrawlerBody.includes('export function detectArtefactKind'),
         '/lib/crawler.mjs exports detectArtefactKind for the browser');
  const libMini = await fetch(`${base}/lib/mini-yaml.mjs`);
  assert(libMini.status === 200, '/lib/mini-yaml.mjs served (transitive import target)');

  // 413 PayloadTooLarge on /api/* must come back as JSON, not HTML.
  // Build a body just over the 16 MB cap by repeating the smallest valid
  // crawl shape.
  const huge = '{"files":{' + Array.from({ length: 100 }, (_, i) =>
    `"f${i}.yml":"${'x'.repeat(180 * 1024)}"`
  ).join(',') + '}}';
  const tooBig = await fetch(`${base}/api/crawl`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: huge,
  });
  assert(tooBig.status === 413, 'oversize /api/crawl request → 413');
  const tooBigCt = tooBig.headers.get('content-type') || '';
  assert(tooBigCt.includes('application/json'),
         `413 response carries JSON content-type (got ${tooBigCt})`);
  const tooBigBody = await tooBig.json();
  assert(/too large/i.test(tooBigBody.error || ''),
         '413 error message names the size problem');

  // Static assets
  const css = await getText(base, '/app.css');
  assert(css.includes('--L2X:'), '/app.css served with L2X palette');
  assert(css.includes('.crawl-dropzone'), '/app.css ships crawl-dropzone styles');
  const js = await getText(base, '/app.mjs');
  assert(js.includes('LAYER_DEFS'), '/app.mjs served');
  assert(js.includes('setupCrawlPanel'), '/app.mjs wires setupCrawlPanel');
  assert(js.includes('renderCrawlResult'), '/app.mjs ships renderCrawlResult');
  assert(js.includes('setupDraftFromMcpPanel'), '/app.mjs wires setupDraftFromMcpPanel (Phase 7n)');
  assert(js.includes('renderDraftMcpResult'), '/app.mjs ships renderDraftMcpResult');
  const atlasJs = await getText(base, '/atlases.mjs');
  // The full atlas roster is restored as of Phase 7h.
  for (const fn of ['renderStrata', 'renderPeriodic', 'renderConstellation', 'renderSkyline', 'renderTransit', 'renderArbor']) {
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
