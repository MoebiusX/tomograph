#!/usr/bin/env node
/**
 * tools/test-promql.mjs
 *
 * PromQL dependency extraction tests. These protect the executable-declaration
 * spine: expressions should yield real series names, not grouping labels,
 * label matcher keys, Grafana helper names, or string literals.
 */

import { extractPromqlMetricNames as extractCore, parsePromqlDependencies as parseCore } from './lib/promql.mjs';
import { extractPromqlMetricNames as extractLezer, parsePromqlDependencies as parseLezer } from './lib/promql-lezer.mjs';

const failures = [];
function assert(cond, label, got, want) {
  if (cond) { process.stdout.write(`✓ ${label}\n`); return; }
  const detail = got !== undefined ? `\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}` : '';
  failures.push(`${label}${detail}`);
  process.stdout.write(`✗ ${label}${detail}\n`);
}

function eq(actual, expected, label) {
  assert(JSON.stringify(actual) === JSON.stringify(expected), label, actual, expected);
}

process.stdout.write('\n--- core PromQL extraction ---\n');
eq(
  extractCore('sum(rate(http_requests_total{status=~"5.."}[5m])) by (service)'),
  ['http_requests_total'],
  'grouping labels and label matchers are not metrics',
);
eq(
  extractCore('1 - (1 - slo:http_request_duration:ratio_below_500ms_1d)/(1-0.95)'),
  ['slo:http_request_duration:ratio_below_500ms_1d'],
  'colon recording-rule output series is extracted',
);
eq(
  extractCore('histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))'),
  ['http_request_duration_seconds_bucket'],
  'histogram bucket metric extracted without le label',
);
eq(
  extractCore('ALERTS{alertname=~".*Forecast.*|.*Trend.*", alertstate="firing"}'),
  ['ALERTS'],
  'ALERTS pseudo-series extracted without alertname strings',
);
eq(
  extractCore('label_values(solace_client_username{dataCenter="$dataCenter"}, vpn)'),
  ['solace_client_username'],
  'Grafana label_values helper yields first-argument metric only',
);
eq(
  extractCore('{__name__="http_requests_total", job="api"}'),
  ['http_requests_total'],
  '__name__ exact matcher yields metric dependency',
);

const coreParsed = parseCore('sum(rate(http_requests_total{status="200"}[5m]))');
assert(coreParsed.selectors[0]?.labels?.some(l => l.label === 'status' && l.value === '200'),
       'core parser preserves selector label evidence');

process.stdout.write('\n--- Lezer-backed extraction ---\n');
const valid = parseLezer('sum(rate(http_requests_total{status=~"5.."}[5m])) by (service)');
assert(valid.parser === 'lezer-promql', 'Lezer wrapper identifies parser', valid.parser, 'lezer-promql');
assert(valid.parseOk === true, 'valid PromQL parses cleanly', valid.parseOk, true);
eq(valid.metrics, ['http_requests_total'], 'Lezer wrapper extracts valid expression metric');

const grafanaHelper = parseLezer('label_values(solace_client_username{dataCenter="$dataCenter"}, vpn)');
assert(grafanaHelper.metrics.includes('solace_client_username'),
       'Lezer wrapper salvages Grafana helper metric through core parser',
       grafanaHelper.metrics, ['solace_client_username']);
assert(grafanaHelper.parseOk === false,
       'Grafana helper is marked parse-warning, not clean PromQL',
       grafanaHelper.parseOk, false);

if (failures.length) {
  process.stderr.write(`\n${failures.length} PromQL assertion(s) failed.\n`);
  process.exit(1);
}
process.stdout.write('\nall PromQL assertions pass.\n');
