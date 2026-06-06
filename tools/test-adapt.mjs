#!/usr/bin/env node
/**
 * tools/test-adapt.mjs
 *
 * Adapter regression test. Loads the vendored canonical example, runs the
 * adapter for each declared environment, and asserts layer counts, key
 * artefacts, source-tag derivation, environment overlay, and cross-reference
 * resolution.
 *
 * Exit 0 = all assertions pass. Exit 1 = at least one assertion failed.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { adapt, listEnvironments } from './lib/adapter.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(
  __dirname, '..',
  'vendor', 'observability-pack-spec', 'v1.2',
  'examples', 'payment-service.pack.yaml',
);

const failures = [];
function assert(cond, label, got, want) {
  if (cond) { process.stdout.write(`✓ ${label}\n`); return; }
  const detail = got !== undefined ? `\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}` : '';
  failures.push(`${label}${detail}`);
  process.stdout.write(`✗ ${label}${detail}\n`);
}

const text = readFileSync(FIXTURE, 'utf8');
const canonical = parseYaml(text);
const envs = listEnvironments(canonical);

assert(envs.length === 2, 'lists both environments', envs.length, 2);
assert(envs[0] === 'prod', 'prod is first env (default)', envs[0], 'prod');

// ---------- default-environment adapter pass ----------

const prod = adapt(canonical);

assert(prod.meta.apiVersion === 'observability.platform/v1', 'meta.apiVersion');
assert(prod.meta.kind === 'ObservabilityPack',               'meta.kind');
assert(prod.meta.binding === 'otel-elastic-prometheus-grafana', 'meta.binding');
assert(prod.meta.version === '1.5.0',                        'meta.version');
assert(prod.meta.environment === 'prod',                     'default env = prod');
assert(prod.meta.target === 'ske',                           'prod target');
assert(prod.meta.criticality === 'tier-1',                   'prod criticality');
assert(prod.badge === 'TIER-1',                              'badge derived from criticality');

// Layer counts (each section of the canonical example contributes a known number)
assert(prod.layers.L1.length === 10,           'L1 = 5 SLIs + 5 SLOs', prod.layers.L1.length, 10);
assert(prod.layers.L2.length === 24,           'L2 = 1 otel + 9 backends + 8 pipelines + 3 exporters + 3 storage', prod.layers.L2.length, 24);
assert(prod.layers.L2X.length === 7,           'L2X = profiling + network + policy_engine + 2 mesh + 2 collection', prod.layers.L2X.length, 7);
assert(prod.layers.L3.length === 14,           'L3 = 4 recording + 2 derived + 4 dashboards + 4 panels (expand)', prod.layers.L3.length, 14);
assert(prod.layers.L4.policy.length === 6,    'L4.policy = 4 burn-rate + 2 forecasts', prod.layers.L4.policy.length, 6);
assert(prod.layers.L4.alerting.length === 3,  'L4.alerting = SEV1/SEV2/SEV3 routes', prod.layers.L4.alerting.length, 3);
assert(prod.layers.L4.healing.length === 3,   'L4.healing = 3 remediations', prod.layers.L4.healing.length, 3);
assert(prod.layers.L5.length === 6,           'L5 = 1 baseline + 3 chaos + 2 synthetic', prod.layers.L5.length, 6);
assert(prod.layers.GOV.length === 3,          'GOV = 3 imports', prod.layers.GOV.length, 3);

// SLI/SLO shape
const sli = prod.layers.L1.find(a => a.title === 'api_availability');
assert(sli && sli.defines === 'slis.api_availability', 'SLI defines slis.<id>', sli && sli.defines, 'slis.api_availability');
assert(sli && sli.id === 'SLI-01',                     'SLI id pattern',         sli && sli.id, 'SLI-01');
assert(sli && sli.source === 'Declared',               'SLI source = Declared',  sli && sli.source, 'Declared');

const slo = prod.layers.L1.find(a => a.title === 'api_availability_99_9');
assert(slo && slo.defines === 'slos.api_availability_99_9',
       'SLO defines slos.<id>', slo && slo.defines, 'slos.api_availability_99_9');
assert(slo && slo.refs?.[0] === 'slis.api_availability',
       'SLO refs the SLI', slo && slo.refs?.[0], 'slis.api_availability');

// Backend shape — gating tags + defines
const bak = prod.layers.L2.find(a => a.title === 'metrics-prom');
assert(bak?.defines === 'telemetry.backends.metrics-prom', 'backend defines',  bak?.defines, 'telemetry.backends.metrics-prom');
assert(bak?.tags.includes('metrics'),                      'backend signal tag');
assert(bak?.tags.includes('gating-warn'),                  'backend gating tag from VersionSpec');
assert(bak?.tags.includes('default'),                      'default backend tag');

// L2X — extended surfaces present
const prof = prod.layers.L2X.find(a => a.id === 'PROF-01');
assert(prof?.refs?.[0] === 'telemetry.backends.profiles-pyroscope', 'profiling refs its backend');
const meshKong = prod.layers.L2X.find(a => a.title === 'gateway: kong');
assert(!!meshKong, 'kong mesh artefact present');

// Dashboard cross-refs
const dash = prod.layers.L3.find(a => a.title === 'payment-overview');
assert(dash?.refs?.includes('slis.api_availability'),    'dashboard panel binding ref to SLI');
assert(dash?.refs?.includes('slos.api_availability_99_9'),'dashboard panel binding ref to SLO');

// Chaos cross-refs
const chaos = prod.layers.L5.find(a => a.title === 'api-pod-kill');
assert(chaos?.refs?.includes('ref:slos.api_availability_99_9'), 'chaos steady-state-hypothesis ref kept verbatim');
assert(chaos?.refs?.includes('alert:payment-api-pod-down'),     'chaos expected_alerts ref normalized');

// Remediation refs (trigger preserved)
const heal = prod.layers.L4.healing.find(a => a.title === 'alert:payment-api-pod-oom');
assert(!!heal, 'remediation HEAL artefact present');

// ---------- staging-environment adapter pass: overlay verification ----------

const stg = adapt(canonical, { environment: 'staging' });
assert(stg.meta.environment === 'staging',   'env=staging selected');
assert(stg.meta.target === 'bare-k8s',       'staging target overridden');
assert(stg.meta.criticality === 'tier-2',    'staging criticality overridden');

const stgOtel = stg.layers.L2.find(a => a.id === 'OTEL-01').spec;
const prodOtel = prod.layers.L2.find(a => a.id === 'OTEL-01').spec;
assert(prodOtel.sdk.sampling.ratio === 0.1,  'prod sampling.ratio 0.1');
assert(stgOtel.sdk.sampling.ratio === 1,     'staging sampling.ratio overridden to 1.0');

// Override should NOT bleed across env passes (adapter does deep-clone per call)
const prod2 = adapt(canonical);
assert(prod2.layers.L2.find(a => a.id === 'OTEL-01').spec.sdk.sampling.ratio === 0.1,
       'prod sampling unchanged after a staging call (no shared mutable spec)');

// ---------- summary ----------

if (failures.length) {
  process.stderr.write(`\n${failures.length} adapter assertion(s) failed.\n`);
  process.exit(1);
}
process.stdout.write(`\nall adapter assertions pass.\n`);
