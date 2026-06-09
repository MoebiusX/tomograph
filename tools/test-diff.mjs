#!/usr/bin/env node
/**
 * tools/test-diff.mjs
 *
 * Regression tests for the behavioural matcher. The important case is a pack
 * containing multiple artefacts with the same behavioural identity key:
 * duplicate-severity alert routes, duplicate dashboard ids, and same
 * product+signal backend instances. These must survive diffPacks instead of
 * being collapsed by a Map.
 */

import { adapt } from './lib/adapter.mjs';
import { diffPacks, deltasOf } from './lib/diff.mjs';

const failures = [];
function assert(cond, label, got, want) {
  if (cond) { process.stdout.write(`✓ ${label}\n`); return; }
  const detail = got !== undefined ? `\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}` : '';
  failures.push(`${label}${detail}`);
  process.stdout.write(`✗ ${label}${detail}\n`);
}

const collisionPack = {
  apiVersion: 'observability.platform/v1',
  kind: 'ObservabilityPack',
  metadata: {
    name: 'matcher-collision-demo',
    version: '0.1.0',
    owners: ['team-platform'],
    bindings: {
      service: 'matcher-collision-demo',
      environments: ['prod'],
      criticality: 'tier-2',
    },
  },
  spec: {
    otel: {
      semconv: '1.27.0',
      resource_attributes: { required: ['service.name'] },
      sdk: { languages: ['go'], sampling: { policy: 'always_on' } },
    },
    telemetry: {
      backends: [
        { id: 'metrics-primary', signal: 'metrics', product: 'prometheus', endpoints: ['http://prom-a:9090'] },
        { id: 'metrics-replica', signal: 'metrics', product: 'prometheus', endpoints: ['http://prom-b:9090'], tenant: 'replica' },
      ],
    },
    slis: [
      {
        id: 'api_availability',
        type: 'ratio',
        good: 'sum(rate(http_requests_total{code!~"5.."}[5m]))',
        total: 'sum(rate(http_requests_total[5m]))',
      },
    ],
    slos: [
      {
        id: 'api_availability_99',
        sli: 'api_availability',
        objective: 0.99,
        window: '30d',
        error_budget_policy: 'ref:platform/default-budget',
      },
    ],
    pipelines: {
      receivers: [{ name: 'otlp' }],
      processors: [{ name: 'batch' }],
      exporters: {
        metrics: { kind: 'prometheusremotewrite' },
        logs: { kind: 'loki' },
        traces: { kind: 'jaeger' },
      },
    },
    queries: {
      recording_rules: [
        { name: 'demo:api_availability:ratio_5m', expr: 'ref:slis.api_availability' },
      ],
    },
    dashboards: [
      {
        id: 'overview',
        provider: { kind: 'grafana' },
        folder: 'service',
        panel_bindings: [{ panel: 'Availability', binds_to: 'slis.api_availability' }],
      },
      {
        id: 'overview',
        provider: { kind: 'grafana' },
        folder: 'slo',
        panel_bindings: [{ panel: 'SLO', binds_to: 'slos.api_availability_99' }],
      },
    ],
    policy: {
      burn_rate_alerts: [
        {
          slo: 'api_availability_99',
          windows: [
            { short: '5m', long: '1h', factor: 14, severity: 'SEV1' },
            { short: '30m', long: '6h', factor: 6, severity: 'SEV2' },
          ],
        },
      ],
    },
    alerting: {
      routes: [
        { severity: 'SEV2', match: { team: 'payments' }, channels: [{ email: 'payments@example.com' }] },
        { severity: 'SEV2', match: { team: 'settlement' }, channels: [{ webhook: 'https://hooks.example/settlement' }] },
        { severity: 'SEV2', match: { team: 'platform' }, channels: [{ msteams: '#platform-alerts' }] },
      ],
    },
    baselines: { mttd_target_p50: '5m', mttr_target_p50: '2h' },
    validation: {
      synthetic_checks: [
        { id: 'health', kind: 'blackbox-exporter', target: 'https://example.test/health', interval: '1m' },
      ],
    },
  },
};

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

function artefactCount(layered) {
  const l = layered.layers;
  return l.L1.length
    + l.L2.length
    + l.L2X.length
    + l.L3.length
    + l.L4.policy.length
    + l.L4.alerting.length
    + l.L4.healing.length
    + l.L5.length
    + l.GOV.length;
}

process.stdout.write('\n--- collision preservation ---\n');
const declared = adapt(collisionPack);
const total = artefactCount(declared);
const self = diffPacks(declared, adapt(clone(collisionPack)));

assert(self.summary.inBoth === total,
       'self-diff preserves every artefact, including duplicate identity keys',
       self.summary.inBoth, total);
assert(self.summary.onlyInA === 0 && self.summary.onlyInB === 0,
       'self-diff has no missing artefacts');
assert(self.summary.alignment === 1,
       'self-diff alignment remains 1.0');
assert(self.layers.L4.inBoth.filter(x => x.key.startsWith('alert_route::')).length === 3,
       'duplicate SEV2 routes survive as separate matched controls');

process.stdout.write('\n--- surplus duplicate drift ---\n');
const thinPack = clone(collisionPack);
thinPack.spec.telemetry.backends = thinPack.spec.telemetry.backends.slice(0, 1);
thinPack.spec.dashboards = thinPack.spec.dashboards.slice(0, 1);
thinPack.spec.alerting.routes = thinPack.spec.alerting.routes.slice(0, 1);
const thin = diffPacks(declared, adapt(thinPack));

assert(thin.summary.aTotal === total,
       'declared-side total still counts every artefact when live is thinner',
       thin.summary.aTotal, total);
assert(thin.summary.onlyInA === 5,
       'surplus duplicate controls are reported as onlyInA, not dropped',
       thin.summary.onlyInA, 5);
assert(thin.layers.L4.onlyInA.filter(x => x.key.startsWith('alert_route::')).length === 2,
       'two missing SEV2 routes are visible as drift');

process.stdout.write('\n--- canonicalisation edge cases ---\n');
const emptyArray = {
  id: 'BAK-01',
  defines: 'telemetry.backends.metrics-primary',
  spec: { id: 'metrics-primary', signal: 'metrics', product: 'prometheus', labels: [] },
};
const absentArray = {
  id: 'BAK-01',
  defines: 'telemetry.backends.metrics-primary',
  spec: { id: 'metrics-primary', signal: 'metrics', product: 'prometheus' },
};
assert(deltasOf(emptyArray, absentArray).length === 0,
       'empty arrays normalise like absent fields');

if (failures.length) {
  process.stderr.write(`\n${failures.length} diff assertion(s) failed.\n`);
  process.exit(1);
}
process.stdout.write('\nall diff assertions pass.\n');
