#!/usr/bin/env node
/**
 * tools/test-fetch-live.mjs
 *
 * Offline test for the fetcher's pack builder. Feeds synthetic MCP
 * responses to `buildCanonicalPack`, then asserts:
 *   1. The produced pack validates against the vendored canonical schema.
 *   2. It round-trips through emit() / parse() byte-equivalent.
 *   3. Annotations carry the MCP context and per-symbol verification
 *      markers in the flat key form `mcp.verified.<symbol>`.
 *   4. The pack adapts cleanly via the layered adapter (Verified source
 *      tags surface where the fetcher attested them).
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, emit as emitYaml } from './lib/mini-yaml.mjs';
import { validateCanonical, SPEC_VERSION } from './lib/validator.mjs';
import { adapt } from './lib/adapter.mjs';
import { buildCanonicalPack } from './fetch-live-pack.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(readFileSync(
  resolve(__dirname, '..', 'vendor', 'observability-pack-spec', `v${SPEC_VERSION}`, 'observability-pack.schema.json'),
  'utf8'
));

const failures = [];
function assert(cond, label, got, want) {
  if (cond) { process.stdout.write(`✓ ${label}\n`); return; }
  const detail = got !== undefined ? `\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}` : '';
  failures.push(`${label}${detail}`);
  process.stdout.write(`✗ ${label}${detail}\n`);
}

const refreshedAt = '2026-06-06T00:00:00Z';

// ---------- case 1: rich MCP response ----------

const rich = buildCanonicalPack({
  refreshedAt,
  mcpUrl: 'https://fake-mcp.test/observability',
  health: {
    services: [
      { name: 'svc-checkout', status: 'healthy', avgDuration: 84, spanCount: 1200 },
      { name: 'svc-settler',  status: 'healthy', avgDuration: 22, spanCount: 800 },
      { name: 'svc-fraud',    status: 'degraded', avgDuration: 311, spanCount: 60 },
    ],
  },
  topology: {
    dependencies: [
      { parent: 'svc-checkout', child: 'svc-settler', callCount: 12 },
      { parent: 'svc-checkout', child: 'jaeger-all-in-one', callCount: 4200 },
    ],
  },
  anomaliesActive: { traceAnomalies: { active: [{ id: 'a1' }], recentCount: 4 }, amountAnomalies: { enabled: true } },
  baselinesData: { baselines: [
    { service: 'svc-checkout', sampleCount: 5000, thresholdMs: 200 },
    { service: 'svc-settler',  sampleCount: 2000, thresholdMs: 90  },
  ]},
  errors: {},
  packName: 'production-live',
});

// schema
{
  const errors = validateCanonical(rich, SCHEMA);
  assert(errors.length === 0, 'rich pack validates against canonical schema', errors, []);
}

// metadata
assert(rich.metadata.name === 'production-live', 'metadata.name = production-live');
assert(rich.metadata.bindings.criticality === 'tier-2', 'criticality tier-2 when services discovered');
assert(rich.metadata.owners.includes('mcp-fetcher'), 'owners includes mcp-fetcher');

// annotations
const a = rich.metadata.annotations;
assert(a['mcp.refreshedAt'] === refreshedAt, 'annotations carry refreshedAt');
assert(a['mcp.toolsCalled'].split(',').length === 4, 'all four MCP tools listed as called');
assert(a['mcp.servicesDiscovered'] === 'svc-checkout,svc-settler,svc-fraud', 'discovered services flattened');
assert(a['mcp.baselinesComputed'] === '2', 'baselinesComputed reflects MCP data');
assert(a['mcp.activeAnomalies'] === '1', 'activeAnomalies reflects MCP data');

// verified markers (flat keys)
assert(typeof a['mcp.verified.otel'] === 'string', 'otel verified');
assert(typeof a['mcp.verified.slis.svc_checkout_availability'] === 'string', 'per-service SLI verified');
assert(typeof a['mcp.verified.telemetry.backends.metrics-prom'] === 'string', 'metrics-prom backend verified');
assert(typeof a['mcp.verified.telemetry.backends.traces-jaeger'] === 'string', 'jaeger backend verified (topology shows it)');
assert(typeof a['mcp.verified.baselines'] === 'string', 'baselines verified');

// slis/slos
assert(rich.spec.slis.length === 3, 'one SLI per service', rich.spec.slis.length, 3);
assert(rich.spec.slos.length === 3, 'one SLO per service');
assert(rich.spec.slis.every(s => s.type === 'ratio'), 'all SLIs are ratio type');
assert(rich.spec.slos.every(s => s.window === '30d'), 'SLOs target 30d window');

// pipelines (must satisfy minItems for receivers/processors and required exporters)
assert(rich.spec.pipelines.receivers.length >= 1, 'pipelines.receivers >= 1');
assert(rich.spec.pipelines.processors.length >= 1, 'pipelines.processors >= 1');
assert(!!rich.spec.pipelines.exporters.metrics && !!rich.spec.pipelines.exporters.logs && !!rich.spec.pipelines.exporters.traces,
       'pipelines.exporters has metrics + logs + traces');

// burn rate alerts per SLO
assert(rich.spec.policy.burn_rate_alerts.length === 3, 'one burn-rate alert per SLO');
assert(rich.spec.policy.burn_rate_alerts.every(a => a.windows.length >= 2), 'burn-rate alerts have >=2 windows');

// baselines reflect MCP minimum-threshold
assert(rich.spec.baselines.mttd_target_p50 === '90ms', 'mttd_target_p50 derived from smallest baseline threshold',
       rich.spec.baselines.mttd_target_p50, '90ms');
assert(rich.spec.baselines.measurement_source === 'mcp.anomalies_baselines', 'baselines.measurement_source');

// adapter sees the Verified tags
const layered = adapt(rich);
const verifiedSli = layered.layers.L1.find(x => x.id === 'SLI-01');
assert(verifiedSli?.source === 'Verified', 'adapter surfaces Verified source for fetched SLI',
       verifiedSli?.source, 'Verified');
const verifiedBackend = layered.layers.L2.find(x => x.title === 'metrics-prom');
assert(verifiedBackend?.source === 'Verified', 'adapter surfaces Verified source for fetched backend');

// YAML round-trip
const text = emitYaml(rich);
const reparsed = parseYaml(text);
const rValidate = validateCanonical(reparsed, SCHEMA);
assert(rValidate.length === 0, 'YAML round-trip still validates', rValidate, []);
assert(reparsed.metadata.annotations['mcp.refreshedAt'] === refreshedAt, 'YAML round-trip preserves annotations');
assert(reparsed.spec.slis.length === 3, 'YAML round-trip preserves slis');

// ---------- case 2: empty MCP — no services, partial tool failures ----------

const empty = buildCanonicalPack({
  refreshedAt,
  mcpUrl: 'https://fake-mcp.test/observability',
  health: { services: [] },
  topology: { dependencies: [] },
  anomaliesActive: {},
  baselinesData: { baselines: [] },
  errors: { anomalies_baselines: 'HTTP 500' },
});
{
  const errors = validateCanonical(empty, SCHEMA);
  assert(errors.length === 0, 'empty-services pack still validates', errors, []);
}
assert(empty.metadata.bindings.criticality === 'tier-3', 'empty-services pack lands tier-3');
assert(empty.spec.slis.length === 1 && empty.spec.slis[0].id === 'platform_availability',
       'empty pack has stub platform_availability SLI');
assert(empty.spec.slos.length === 1, 'empty pack has matching stub SLO');
assert(empty.metadata.annotations['mcp.toolsFailed'].includes('anomalies_baselines'),
       'failed tool surfaced in mcp.toolsFailed');
assert(empty.metadata.annotations['mcp.verified.baselines'] === undefined,
       'baselines NOT marked verified when anomalies_baselines failed');

// ---------- case 2b: tool responded with a null payload ----------
// The MCP probe helper returns `null` when a tool answers with an
// empty/null body (an honest zero, not a failure). Those nulls are
// spread straight into buildCanonicalPack, bypassing the `= {}`
// destructuring defaults (which only fire for `undefined`). Guard
// against the regression where `baselinesData.baselines` threw
// "Cannot read properties of null (reading 'baselines')".
{
  let nullPayload;
  try {
    nullPayload = buildCanonicalPack({
      refreshedAt,
      mcpUrl: 'https://fake-mcp.test/observability',
      health: { services: [] },
      topology: null,
      anomaliesActive: null,
      baselinesData: null,
    });
  } catch (e) {
    nullPayload = e;
  }
  assert(!(nullPayload instanceof Error),
         'null tool payloads do not crash buildCanonicalPack',
         nullPayload instanceof Error ? nullPayload.message : 'ok', 'ok');
  const nErrors = validateCanonical(nullPayload, SCHEMA);
  assert(nErrors.length === 0, 'null-payload pack still validates', nErrors, []);
}

// ---------- case 3: probes return real data — recording rules, dashboards, scrape jobs, metrics ----------
//
// This is the case the user pushed back on: "metrics we're exporting or
// scraping MUST be declared there when present." Verifies the fetcher
// uses probe-discovered data instead of stubbing.

const probed = buildCanonicalPack({
  refreshedAt,
  mcpUrl: 'https://fake-mcp.test/observability',
  health: { services: [{ name: 'svc-checkout', criticality: 'tier-1' }] },
  topology: { dependencies: [{ child: 'svc-jaeger-agent' }] },
  anomaliesActive: {},
  baselinesData: { baselines: [{ service: 'svc-checkout', sampleCount: 1000, thresholdMs: 90 }] },
  probeResults: {
    recording_rules: {
      tool: 'list_recording_rules',
      adapted: [
        { name: 'svc_checkout:availability:good_5m',  expr: 'sum(rate(http_requests_total{status_code!~"5.."}[5m]))', interval: '30s' },
        { name: 'svc_checkout:availability:total_5m', expr: 'sum(rate(http_requests_total[5m]))',                       interval: '30s' },
        { name: 'svc_checkout:availability:ratio_5m', expr: 'svc_checkout:availability:good_5m / svc_checkout:availability:total_5m', interval: '30s' },
        { name: 'svc_checkout:latency_p95:value_5m',  expr: 'histogram_quantile(0.95, rate(http_request_duration_ms_bucket[5m]))', interval: '30s' },
      ],
    },
    alert_rules: {
      tool: 'list_alert_rules',
      adapted: [{ name: 'CheckoutHighErrorRate', expr: 'svc_checkout:availability:ratio_5m < 0.99', for: '5m', labels: {}, annotations: {} }],
    },
    dashboards: {
      tool: 'grafana_search',
      adapted: [
        { id: 'checkout-overview', provider: { kind: 'grafana', version: '12.0', schemaVersion: 41 }, folder: 'checkout', source: 'grafana://uid/checkout-overview' },
        { id: 'platform-health',   provider: { kind: 'grafana', version: '12.0', schemaVersion: 41 }, folder: 'platform', source: 'grafana://uid/platform-health' },
      ],
    },
    scrape_configs: { tool: 'list_scrape_configs', adapted: ['checkout', 'platform', 'collector'] },
    metric_names:   { tool: 'list_metrics',         adapted: ['http_requests_total', 'http_request_duration_ms_bucket', 'queue_depth'] },
  },
  errors: {},
});

{
  const errors = validateCanonical(probed, SCHEMA);
  assert(errors.length === 0, 'probed pack validates against canonical schema', errors, []);
}

// SLIs INFERRED from recording rules (not service-derived stubs).
assert(probed.spec.slis.some(s => s.id === 'svc_checkout_availability'),
       'SLI inferred from recording rules (svc_checkout_availability)');
assert(probed.spec.slis.some(s => s.id === 'svc_checkout_latency_p95'),
       'threshold SLI inferred from latency_p95 rule (svc_checkout_latency_p95)');
assert(probed.spec.slis.find(s => s.id === 'svc_checkout_availability')?.type === 'ratio',
       'ratio SLI inferred when good + total rules present');
assert(probed.spec.slis.find(s => s.id === 'svc_checkout_latency_p95')?.type === 'threshold',
       'threshold SLI inferred from single-value rule');

// queries.recording_rules carries the DISCOVERED rules, not the
// synthesised stubs.
const ruleNames = probed.spec.queries.recording_rules.map(r => r.name);
assert(ruleNames.includes('svc_checkout:availability:ratio_5m'),
       'queries.recording_rules carries discovered rules verbatim');
assert(!ruleNames.includes('platform:platform_availability:ratio_5m'),
       'queries.recording_rules does NOT include the synth stub when probe responded');

// dashboards: discovered ones replace the platform-overview stub.
const dashIds = probed.spec.dashboards.map(d => d.id);
assert(dashIds.includes('checkout-overview') && dashIds.includes('platform-health'),
       'dashboards section carries discovered dashboards');
assert(!dashIds.includes('platform-overview'),
       'dashboards section does NOT include the stub when probe responded');

// alert rule names surface as annotation (we can't reshape multi-window from a flat alert).
assert(probed.metadata.annotations['mcp.discovered.alert_rule_names']?.includes('CheckoutHighErrorRate'),
       'discovered alert rule names annotated');

// scrape jobs + metric inventory surfaced as annotations.
assert(probed.metadata.annotations['mcp.discovered.scrape_jobs'] === 'checkout,platform,collector',
       'scrape jobs annotated');
assert(probed.metadata.annotations['mcp.discovered.metric_names_count'] === '3',
       'metric inventory count annotated');
assert(probed.metadata.annotations['mcp.discovered.metric_names_sample']?.includes('http_requests_total'),
       'metric inventory sample annotated');

// probesAttempted + probesSucceeded reflect what we asked vs what answered.
assert(probed.metadata.annotations['mcp.probesAttempted']?.includes('recording_rules'),
       'probesAttempted lists recording_rules');
assert(probed.metadata.annotations['mcp.probesSucceeded']?.includes('dashboards'),
       'probesSucceeded lists dashboards');

// verified.* tags for the discovered surfaces.
assert(typeof probed.metadata.annotations['mcp.verified.queries.recording_rules'] === 'string',
       'recording rules verified by MCP');
assert(typeof probed.metadata.annotations['mcp.verified.dashboards'] === 'string',
       'dashboards verified by MCP');
assert(typeof probed.metadata.annotations['mcp.verified.telemetry.scrape'] === 'string',
       'scrape evidence verified by MCP');
assert(typeof probed.metadata.annotations['mcp.verified.otel.metrics'] === 'string',
       'metric inventory verified by MCP');

// ---------- case 4: probes attempted but came back empty — honest gap ----------
//
// Confirms the "what to refine" narrative. probesAttempted records the
// kind, but no `tool` field means nothing answered. The fetcher must
// fall back to stubs without claiming verification.

const probedEmpty = buildCanonicalPack({
  refreshedAt,
  mcpUrl: 'https://fake-mcp.test/observability',
  health: { services: [{ name: 'svc-checkout', criticality: 'tier-2' }] },
  topology: { dependencies: [] },
  anomaliesActive: {},
  baselinesData: { baselines: [] },
  probeResults: {
    recording_rules: { tool: null, attempted: ['list_recording_rules', 'prometheus_recording_rules'], adapted: null },
    dashboards:      { tool: null, attempted: ['grafana_search'], adapted: null },
  },
  errors: {},
});
assert(probedEmpty.metadata.annotations['mcp.probesAttempted']?.includes('recording_rules'),
       'probesAttempted lists recording_rules even when none answered');
assert(!probedEmpty.metadata.annotations['mcp.probesSucceeded']?.includes('recording_rules'),
       'probesSucceeded does NOT list recording_rules when none answered');
assert(probedEmpty.metadata.annotations['mcp.verified.queries.recording_rules'] === undefined,
       'recording rules NOT marked verified when probes returned empty');

// ---------- summary ----------

if (failures.length) {
  process.stderr.write(`\n${failures.length} fetcher assertion(s) failed.\n`);
  process.exit(1);
}
process.stdout.write(`\nall fetcher assertions pass.\n`);
