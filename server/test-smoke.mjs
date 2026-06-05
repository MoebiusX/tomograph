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
  assert(catalog.packs.length >= 1, 'GET /api/packs returns at least one pack');
  const example = catalog.packs.find(p => p.id === 'payment-service');
  assert(!!example, 'catalog includes payment-service');
  assert(example?.ok === true, 'payment-service loaded ok');
  assert(example?.name === 'payment-service', 'payment-service name');
  assert(example?.criticality === 'tier-1', 'payment-service criticality');
  assert(example?.environments?.length === 2, 'payment-service environments count');

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
} finally {
  await new Promise(r => srv.close(r));
}

if (failures.length) {
  process.stderr.write(`\n${failures.length} smoke assertion(s) failed.\n`);
  process.exit(1);
}
process.stdout.write(`\nall server smoke assertions pass.\n`);
