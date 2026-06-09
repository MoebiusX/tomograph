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
import { diffPacks } from './lib/diff.mjs';

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
  init-helper:
    image: busybox:1.36
    command: >
      echo preparing observability stack
      && echo ready
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
  pyroscope:
    image: grafana/pyroscope:1.7.0
    ports: ["4040:4040"]
  cilium:
    image: quay.io/cilium/cilium:v1.15.0
  opa:
    image: openpolicyagent/opa:0.63.0
    ports: ["8181:8181"]
  envoy:
    image: envoyproxy/envoy:v1.31.0
    ports: ["9901:9901"]
  kong:
    image: kong:3.6
    ports: ["8001:8001"]
  vector:
    image: timberio/vector:0.36.0
    ports: ["8686:8686"]
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
assert(summary.warnings.every(w => !/Failed to parse docker-compose\.yml/.test(w)),
       'docker-compose folded command block does not abort backend extraction');

const backends = canonical.spec.telemetry?.backends || [];
assert(backends.length >= 5, `discovered ≥5 backends (got ${backends.length})`);
assert(backends.some(b => b.product === 'prometheus'),  'prometheus backend discovered');
assert(backends.some(b => b.product === 'grafana'),     'grafana backend discovered');
assert(backends.some(b => b.product === 'loki'),        'loki backend discovered');
assert(backends.some(b => b.product === 'tempo'),       'tempo backend discovered');
assert(backends.some(b => b.product === 'alertmanager'),'alertmanager backend discovered');
assert(backends.some(b => b.product === 'pyroscope'),   'pyroscope backend discovered');
assert(backends.some(b => b.product === 'cilium'),      'cilium backend discovered');
assert(backends.some(b => b.product === 'opa'),         'opa backend discovered');
assert(backends.some(b => b.product === 'envoy'),       'envoy backend discovered');
assert(backends.some(b => b.product === 'kong'),        'kong backend discovered');
assert(backends.some(b => b.product === 'vector'),      'vector backend discovered');
assert(summary.discovered.extendedSurfaces >= 6,
       `L2X extended surfaces materialised (got ${summary.discovered.extendedSurfaces})`);

assert(canonical.spec.profiling?.backend === 'profiles-pyroscope', 'profiling surface references pyroscope backend');
assert(canonical.spec.network?.backend === 'network-cilium',       'network surface references cilium backend');
assert(canonical.spec.policy_engine?.backend === 'policy-opa',     'policy engine surface references opa backend');
assert(canonical.spec.mesh?.some(m => m.product === 'envoy' && m.role === 'proxy'),
       'mesh surface materialises envoy proxy');
assert(canonical.spec.mesh?.some(m => m.product === 'kong' && m.role === 'gateway'),
       'mesh surface materialises kong gateway');
assert(canonical.spec.collection?.some(c => c.product === 'vector' && c.role === 'aggregator'),
       'collection surface materialises vector aggregator');

const rules = canonical.spec.queries.recording_rules;
assert(rules.length >= 2, `recording rules discovered (got ${rules.length})`);
assert(rules.some(r => r.name === 'payments:api_availability:ratio_5m'),  'availability ratio rule preserved');
assert(rules.some(r => r.name === 'payments:api_latency_p95:ms'),         'p95 latency rule preserved');
assert(!rules.some(r => String(r.expr || '').startsWith('ref:slis.')),
       'source-less synthetic recording rules are not emitted');
assert((summary.omitted?.syntheticRecordingRules || []).length >= 1,
       'source-less synthetic recording rule candidates are reported as omitted');

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
  assert(adapted.layers.L2X.length >= 6, `adapter populates L2X from extended surfaces (got ${adapted.layers.L2X.length})`);
  assert(adapted.layers.L3.length > 0, 'adapter populates L3 from queries + dashboards');

  const conf = evaluateConformance(canonical);
  assert(typeof conf?.declaredTier === 'string',   'conformance scored (declared tier present)');
  assert(Array.isArray(conf?.clauses),             'conformance returns clauses array');
  assert(conf.clauses.some(c => c.id === 'L2X.MUST.extended_backend_refs_resolve' && c.pass === true),
         'conformance checks L2X backend references');

  const sameLive = structuredClone(canonical);
  const aligned = diffPacks(adapted, adapt(sameLive));
  assert(aligned.layers.L2X.inBoth.length >= 6 && aligned.layers.L2X.onlyInA.length === 0,
         'repo-vs-live L2X diff aligns when surfaces match');

  const missingLive = structuredClone(canonical);
  delete missingLive.spec.network;
  const drift = diffPacks(adapted, adapt(missingLive));
  assert(drift.layers.L2X.onlyInA.some(x => x.key.startsWith('network::')),
         'repo-vs-live L2X diff reports missing live network surface');
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

// ---------- real-world YAML shapes the parser used to choke on ----------
// These mirror what `crawl-repo` hits on production repos: multi-document
// Prometheus rule files, Alertmanager routes whose first key is a block
// (`- match:`), and Grafana unified-alerting provisioned rules.
process.stdout.write('\n--- real-world shapes ---\n');
const REAL = {
  // Multi-document Prometheus rules (note the leading `---` and `---` between docs).
  'rules/multidoc.rules.yaml': `---
groups:
  - name: latency_recording
    interval: 30s
    rules:
      - record: api:request_latency_p99:ms
        expr: histogram_quantile(0.99, rate(http_request_duration_ms_bucket[5m]))
---
groups:
  - name: availability_alerts
    rules:
      - alert: api_availability_burnrate
        expr: slo:error_ratio:5m > 0.01
        for: 5m
        labels:
          severity: critical
`,
  // Alertmanager whose route children lead with a block key (`- match:`).
  'alertmanager.config.yaml': `route:
  receiver: default
  routes:
    - match:
        severity: critical
      receiver: pagerduty
    - match:
        severity: warning
      receiver: slack
receivers:
  - name: default
  - name: pagerduty
    pagerduty_configs:
      - service_key: REDACTED
  - name: slack
    slack_configs:
      - channel: '#alerts'
`,
  // Grafana unified-alerting provisioned rules (no record/alert keys; uses title).
  'grafana/alerts.yaml': `apiVersion: 1
groups:
  - orgId: 1
    name: checkout_alerts
    folder: SLO
    interval: 1m
    rules:
      - uid: ce-001
        title: checkout_latency_burnrate
        condition: A
        for: 5m
        labels:
          severity: warning
`,
};
assert(detectArtefactKind('rules/multidoc.rules.yaml', REAL['rules/multidoc.rules.yaml']) === 'prometheus-rules', 'multi-doc rules detected');
assert(detectArtefactKind('alertmanager.config.yaml', REAL['alertmanager.config.yaml']) === 'alertmanager', 'block-first-key alertmanager detected');
const real = crawlFiles(REAL, { repoName: 'checkout', now: '2026-06-05T00:00:00.000Z' });
assert(real.summary.warnings.every(w => !/Failed to parse/.test(w)),
  `no parse failures on real-world shapes (warnings: ${JSON.stringify(real.summary.warnings.filter(w => /Failed to parse/.test(w)))})`);
assert(real.canonical.spec.queries.recording_rules.some(r => r.name === 'api:request_latency_p99:ms'),
  'recording rule lifted from multi-doc file');
assert(real.summary.discovered.burnRateAlerts >= 2,
  `burn-rate alerts lifted from both prometheus + grafana forms (got ${real.summary.discovered.burnRateAlerts})`);
assert(real.summary.discovered.alertingRoutes >= 1,
  `routes lifted past the block-first-key shape (got ${real.summary.discovered.alertingRoutes})`);
assert(validateCanonical(real.canonical, SCHEMA).length === 0, 'real-world crawl still validates against v1.2 schema');

// ---------- helm chart introspection ----------
process.stdout.write('\n--- helm chart introspection ---\n');
// A Helm template embeds Prometheus rules + a Grafana dashboard inside a
// rendered ConfigMap, wrapped in Go-template scaffolding (control flow,
// .Values injections, include calls, and the {{ "{{" }} literal-brace escape
// in an annotation). The crawler must look through the scaffolding and lift
// the embedded observability contracts exactly as if they were standalone.
const HELM = {
  'charts/checkout/Chart.yaml': [
    'apiVersion: v2',
    'name: checkout',
    'version: 1.4.2',
    '',
  ].join('\n'),
  'charts/checkout/templates/configmaps.yaml': [
    '{{- if .Values.prometheus.enabled }}',
    'apiVersion: v1',
    'kind: ConfigMap',
    'metadata:',
    '  name: {{ include "checkout.fullname" . }}-rules',
    '  namespace: {{ .Release.Namespace }}',
    'data:',
    '  recording-rules.yml: |',
    '    groups:',
    '      - name: slo:checkout',
    '        interval: 30s',
    '        rules:',
    '          - record: slo:http_requests:good_5m',
    '            expr: sum(rate(http_requests_total{code!~"5.."}[5m]))',
    '          - record: slo:http_requests:total_5m',
    '            expr: sum(rate(http_requests_total[5m]))',
    '  alerting-rules.yml: |',
    '    groups:',
    '      - name: checkout.alerts',
    '        rules:',
    '          - alert: HighErrorRate',
    '            expr: slo:http_requests:good_5m / slo:http_requests:total_5m < 0.99',
    '            for: 2m',
    '            labels:',
    '              severity: critical',
    '            annotations:',
    '              summary: "error rate is {{ "{{" }} $value | humanizePercentage {{ "}}" }}"',
    '  overview.json: |',
    '    {"uid":"checkout-overview","title":"Checkout Overview","schemaVersion":39,"version":3,"panels":[]}',
    '{{- end }}',
  ].join('\n'),
};
assert(detectArtefactKind('charts/checkout/templates/configmaps.yaml', HELM['charts/checkout/templates/configmaps.yaml']) === 'helm-template',
  'helm template detected via Go-template scaffolding');
assert(detectArtefactKind('charts/checkout/Chart.yaml', HELM['charts/checkout/Chart.yaml']) === 'helm-chart',
  'Chart.yaml detected as helm-chart');
const helm = crawlFiles(HELM, { repoName: 'checkout-helm', now: '2026-06-05T00:00:00.000Z' });
assert(helm.summary.warnings.every(w => !/Failed to parse/.test(w)),
  `no parse failures on helm chart (warnings: ${JSON.stringify(helm.summary.warnings.filter(w => /Failed to parse/.test(w)))})`);
assert(helm.canonical.spec.queries.recording_rules.some(r => r.name === 'slo:http_requests:good_5m'),
  'recording rule lifted from embedded ConfigMap');
assert(helm.canonical.spec.slis.some(s => s.id === 'slo_http_requests'),
  'SLI inferred from embedded recording rules');
assert(helm.canonical.spec.dashboards.some(d => d.id === 'checkout-overview'),
  'grafana dashboard lifted from embedded ConfigMap JSON');
assert(validateCanonical(helm.canonical, SCHEMA).length === 0, 'helm chart crawl validates against v1.2 schema');

// ---------- environment-scoped extraction ----------
process.stdout.write('\n--- environment scoped extraction ---\n');
const ENV_MIXED = {
  'docker-compose.yml': `services:
  prometheus:
    image: prom/prometheus:v2.51.0
`,
  'k8s/charts/checkout/values.yaml': `grafana:
  image:
    repository: grafana/grafana
    tag: 12.0.0
`,
  'k8s/charts/checkout/values-local.yaml': `loki:
  image:
    repository: grafana/loki
    tag: 3.0.0
`,
  'k8s/charts/checkout/values-eks.yaml': `victoriametrics:
  image:
    repository: victoriametrics/victoria-metrics
    tag: v1.101.0
`,
  'k8s/manifests/kube-state-metrics.yaml': `apiVersion: apps/v1
kind: Deployment
metadata:
  name: kube-state-metrics
spec:
  template:
    spec:
      containers:
        - name: kube-state-metrics
          image: registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.13.0
`,
};
assert(detectArtefactKind('k8s/charts/checkout/values-eks.yaml', ENV_MIXED['k8s/charts/checkout/values-eks.yaml']) === 'helm-values',
  'Helm values detected as backend source');
assert(detectArtefactKind('k8s/manifests/kube-state-metrics.yaml', ENV_MIXED['k8s/manifests/kube-state-metrics.yaml']) === 'k8s-workload',
  'plain K8s workload detected as backend source');

const products = (result) => new Set((result.canonical.spec.telemetry?.backends || []).map(b => b.product));
const prod = crawlFiles(ENV_MIXED, { repoName: 'checkout', environment: 'prod', now: '2026-06-05T00:00:00.000Z' });
const prodProducts = products(prod);
assert(prod.summary.environment.profile === 'prod' && prod.summary.environment.scoped === true,
  `prod environment maps to production Kubernetes extraction (${JSON.stringify(prod.summary.environment)})`);
assert(prod.summary.files.excludedByEnvironment >= 2,
  `prod scope excludes docker/local files when an explicit production overlay exists (got ${prod.summary.files.excludedByEnvironment})`);
assert(prodProducts.has('victoriametrics'), 'production values backend discovered');
assert(prodProducts.has('kube-state-metrics'), 'production K8s workload backend discovered');
assert(!prodProducts.has('prometheus'), 'prod scan does not mix in docker-compose Prometheus');
assert(!prodProducts.has('loki'), 'prod scan does not mix in local-k8s Loki');

const eks = crawlFiles(ENV_MIXED, { repoName: 'checkout', environment: 'eks', now: '2026-06-05T00:00:00.000Z' });
const eksProducts = products(eks);
assert(eks.summary.environment.profile === 'eks' && eks.summary.environment.scoped === true,
  `explicit eks environment keeps EKS profile (${JSON.stringify(eks.summary.environment)})`);
assert(eksProducts.has('victoriametrics'), 'explicit EKS values backend discovered');
assert(!eksProducts.has('loki'), 'explicit EKS scan excludes local-k8s Loki');

const localDocker = crawlFiles(ENV_MIXED, { repoName: 'checkout', environment: 'local-docker', now: '2026-06-05T00:00:00.000Z' });
const dockerProducts = products(localDocker);
assert(dockerProducts.has('prometheus'), 'local-docker scan keeps docker-compose backend');
assert(!dockerProducts.has('victoriametrics'), 'local-docker scan excludes EKS values');

const localK8s = crawlFiles(ENV_MIXED, { repoName: 'checkout', environment: 'local-k8s', now: '2026-06-05T00:00:00.000Z' });
const localK8sProducts = products(localK8s);
assert(localK8sProducts.has('grafana') && localK8sProducts.has('loki'),
  'local-k8s scan reads base + local Helm values');
assert(!localK8sProducts.has('prometheus'), 'local-k8s scan excludes docker-compose backend');
assert(!localK8sProducts.has('victoriametrics'), 'local-k8s scan excludes EKS values');

process.stdout.write(`\n${failures === 0 ? 'all crawler assertions pass.' : failures + ' failure(s).'}\n`);
process.exit(failures === 0 ? 0 : 1);
