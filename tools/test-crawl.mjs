#!/usr/bin/env node
// ============================================================
// test-crawl.mjs — fixture-driven crawler test.
//
// Builds a synthetic file map representing a service repo, runs
// the crawler, then validates the resulting canonical pack
// against the spec v1.2 schema. Asserts the end-to-end loop
// works: crawler output is a valid pack.
// ============================================================

import { crawlFiles, detectArtefactKind, crawlToYaml } from './lib/crawler.mjs';
import { validateCanonical } from './lib/validator.mjs';
import { readFileSync } from 'node:fs';
import { adapt } from './lib/adapter.mjs';
import { evaluateConformance } from './lib/conformance.mjs';

const SCHEMA_PATH = new URL('../vendor/observability-pack-spec/v1.2/observability-pack.schema.json', import.meta.url);
const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

let failures = 0;
function assert(cond, label) {
  if (cond) { process.stdout.write(`✓ ${label}\n`); return; }
  process.stdout.write(`✗ ${label}\n`);
  failures++;
}

// ---------- synthetic fixture ----------
const FIXTURE = {
  'docker-compose.yml': `version: '3.8'
services:
  prometheus:
    image: prom/prometheus:v2.51.0
    ports: ["9090:9090"]
  grafana:
    image: grafana/grafana:12.0.0
    ports: ["3000:3000"]
  loki:
    image: grafana/loki:3.0.0
    ports: ["3100:3100"]
  tempo:
    image: grafana/tempo:2.4.0
    ports: ["3200:3200"]
  alertmanager:
    image: prom/alertmanager:v0.27.0
    ports: ["9093:9093"]
  otel-collector:
    image: otel/opentelemetry-collector-contrib:0.96.0
    ports: ["4318:4318"]
`,
  'prometheus/rules/sli.yml': `groups:
  - name: payments_slis
    interval: 30s
    rules:
      - record: payments:api_availability:ratio_5m
        expr: sum(rate(http_requests_total{status_code!~"5..",service="payments"}[5m])) / sum(rate(http_requests_total{service="payments"}[5m]))
      - record: payments:api_latency_p95:ms
        expr: histogram_quantile(0.95, rate(http_request_duration_ms_bucket{service="payments"}[5m]))
`,
  'prometheus/rules/alerts.yml': `groups:
  - name: payments_burn
    rules:
      - alert: payments_api_availability_99_burn
        expr: payments:api_availability:ratio_5m < 0.99
        for: 5m
        labels:
          severity: SEV1
      - alert: payments_api_availability_99_slow_burn
        expr: payments:api_availability:ratio_5m < 0.999
        for: 30m
        labels:
          severity: SEV2
`,
  // Note: leading scalar key in each compact sequence item — mini-yaml
  // requires that, so we put `receiver:` first.
  'alertmanager.yml': `route:
  receiver: oncall
  routes:
    - receiver: pager
      match:
        severity: SEV1
    - receiver: teams
      match:
        severity: SEV2
receivers:
  - name: oncall
    msteams_configs:
      - channel_url: '#payments-oncall'
  - name: pager
    pagerduty_configs:
      - service_key: REDACTED
  - name: teams
    msteams_configs:
      - channel_url: '#payments-channel'
`,
  'config/otel-collector.yaml': `receivers:
  otlp:
    protocols:
      http: {}
      grpc: {}
processors:
  batch: {}
  memory_limiter: {}
exporters:
  prometheusremotewrite:
    endpoint: http://prometheus:9090/api/v1/write
  loki:
    endpoint: http://loki:3100/loki/api/v1/push
service:
  pipelines:
    metrics:
      receivers: [otlp]
      processors: [batch, memory_limiter]
      exporters: [prometheusremotewrite]
    logs:
      receivers: [otlp]
      processors: [batch]
      exporters: [loki]
`,
  'dashboards/payments-overview.json': JSON.stringify({
    title: 'Payments Overview',
    uid: 'payments-overview',
    schemaVersion: 41,
    version: 3,
    tags: ['payments'],
    panels: [
      { title: 'Availability', type: 'stat', targets: [{ expr: 'payments:api_availability:ratio_5m' }] },
      { title: 'p95 latency', type: 'timeseries' },
    ],
  }),
  'README.md': '# payments service — should be ignored',
  'src/index.go': '// should be ignored',
};

// ---------- detection ----------
process.stdout.write('\n--- detection ---\n');
assert(detectArtefactKind('docker-compose.yml',         FIXTURE['docker-compose.yml'])         === 'docker-compose',    'docker-compose detected');
assert(detectArtefactKind('prometheus/rules/sli.yml',   FIXTURE['prometheus/rules/sli.yml'])   === 'prometheus-rules',  'prometheus rules detected');
assert(detectArtefactKind('prometheus/rules/alerts.yml',FIXTURE['prometheus/rules/alerts.yml'])=== 'prometheus-rules',  'prometheus alerts detected');
assert(detectArtefactKind('alertmanager.yml',           FIXTURE['alertmanager.yml'])           === 'alertmanager',      'alertmanager detected');
assert(detectArtefactKind('config/otel-collector.yaml', FIXTURE['config/otel-collector.yaml']) === 'otel-collector',    'otel-collector detected');
assert(detectArtefactKind('dashboards/payments-overview.json', FIXTURE['dashboards/payments-overview.json']) === 'grafana-dashboard', 'grafana-dashboard detected');
assert(detectArtefactKind('README.md',                  FIXTURE['README.md'])                  === 'unknown',           'markdown not classified');
assert(detectArtefactKind('src/index.go',               FIXTURE['src/index.go'])               === 'unknown',           'source code not classified');

// ---------- crawl ----------
process.stdout.write('\n--- crawl ---\n');
const { canonical, summary, evidence } = crawlFiles(FIXTURE, {
  repoName: 'payments',
  environment: 'prod',
  now: '2026-06-05T00:00:00.000Z',
});

assert(canonical.apiVersion === 'observability.platform/v1', 'apiVersion is v1');
assert(canonical.kind === 'ObservabilityPack',                 'kind is ObservabilityPack');
assert(canonical.metadata.name === 'payments',                 'metadata.name = repo name');
assert(canonical.metadata.bindings.criticality === 'tier-2',
  `tier-2 inferred from rules+dashboards+alerting (got ${canonical.metadata.bindings.criticality}; discovered ${JSON.stringify(summary.discovered)})`);

const backends = canonical.spec.telemetry?.backends || [];
assert(backends.length >= 5, `discovered ≥5 backends (got ${backends.length})`);
assert(backends.some(b => b.product === 'prometheus'),  'prometheus backend discovered');
assert(backends.some(b => b.product === 'grafana'),     'grafana backend discovered');
assert(backends.some(b => b.product === 'loki'),        'loki backend discovered');
assert(backends.some(b => b.product === 'tempo'),       'tempo backend discovered');
assert(backends.some(b => b.product === 'alertmanager'),'alertmanager backend discovered');

const rules = canonical.spec.queries.recording_rules;
assert(rules.length >= 2, `recording rules discovered (got ${rules.length})`);
assert(rules.some(r => r.name === 'payments:api_availability:ratio_5m'),  'availability ratio rule preserved');
assert(rules.some(r => r.name === 'payments:api_latency_p95:ms'),         'p95 latency rule preserved');

const alerts = canonical.spec.policy.burn_rate_alerts;
assert(alerts.length >= 1,                       'burn-rate alerts emitted');
assert(alerts.every(a => a.windows.length >= 2), 'each alert has ≥2 windows (spec minItems)');

const routes = canonical.spec.alerting.routes;
assert(routes.length >= 1,                              'alerting routes emitted');
assert(routes.some(r => r.severity === 'SEV1'),         'SEV1 route lifted from alertmanager');

const dashboards = canonical.spec.dashboards;
assert(dashboards.length >= 1, 'dashboards emitted');
assert(dashboards.some(d => d.id === 'payments-overview'), 'payments-overview dashboard discovered');
assert(dashboards.every(d => d.provider.kind === 'grafana'), 'all dashboards have grafana provider');

assert(canonical.spec.slis.length >= 1, 'SLIs emitted');
assert(canonical.spec.slos.length >= 1, 'SLOs emitted');
assert(canonical.spec.baselines.mttd_target_p50, 'baselines emitted');
assert(canonical.spec.validation.synthetic_checks.length >= 1, 'synthetic checks emitted');

assert(Object.keys(evidence).length >= 5, `evidence map populated (${Object.keys(evidence).length} entries)`);

// ---------- validate against spec v1.2 ----------
process.stdout.write('\n--- validate ---\n');
const validationErrors = validateCanonical(canonical, SCHEMA);
if (validationErrors.length) {
  process.stdout.write(`✗ canonical pack passes v1.2 schema — got ${validationErrors.length} errors:\n`);
  for (const e of validationErrors.slice(0, 8)) process.stdout.write(`    · ${e}\n`);
  failures++;
} else {
  process.stdout.write(`✓ canonical pack passes v1.2 schema\n`);
}

// ---------- adapt + conformance ----------
process.stdout.write('\n--- downstream ---\n');
try {
  const adapted = adapt(canonical);
  assert(adapted.layers.L1.length > 0, 'adapter populates L1 from SLIs/SLOs');
  assert(adapted.layers.L2.length > 0, 'adapter populates L2 from backends + pipelines');
  assert(adapted.layers.L3.length > 0, 'adapter populates L3 from queries + dashboards');

  const conf = evaluateConformance(canonical);
  assert(typeof conf?.declaredTier === 'string',   'conformance scored (declared tier present)');
  assert(Array.isArray(conf?.clauses),             'conformance returns clauses array');
} catch (e) {
  process.stdout.write(`✗ downstream failed: ${e.message}\n`);
  failures++;
}

// ---------- yaml emission round-trip ----------
process.stdout.write('\n--- yaml ---\n');
const { yaml } = crawlToYaml(FIXTURE, { repoName: 'payments', now: '2026-06-05T00:00:00.000Z' });
assert(yaml.startsWith('# ='), 'yaml output starts with banner');
assert(/^apiVersion: observability\.platform\/v1$/m.test(yaml), 'yaml contains apiVersion');
assert(/payments-overview/.test(yaml), 'yaml contains discovered dashboard id');

process.stdout.write(`\n${failures === 0 ? 'all crawler assertions pass.' : failures + ' failure(s).'}\n`);
process.exit(failures === 0 ? 0 : 1);
