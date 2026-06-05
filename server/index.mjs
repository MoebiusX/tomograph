#!/usr/bin/env node
/**
 * server/index.mjs
 *
 * Express server for ObservabilityPack Studio v0.3+.
 *
 * Responsibilities:
 *   - Serve the studio HTML/CSS/JS shell from studio/.
 *   - Expose a JSON API that runs the validator and adapter server-side.
 *     The browser fetches adapted layered packs; no in-browser YAML parsing,
 *     no in-browser schema validation, no embedded pack literals.
 *
 * Routes:
 *   GET  /                              Studio HTML shell
 *   GET  /healthz                       Liveness probe
 *   GET  /api/packs                     Pack catalog (id, name, version, criticality, environments)
 *   GET  /api/packs/:id                 Adapted layered pack (?env=<name>)
 *   GET  /api/packs/:id/canonical       Raw canonical manifest with env overlay applied (?env=<name>)
 *   POST /api/validate                  Validate an uploaded YAML/JSON body; returns {ok, errors, adapted?}
 *
 * Env:
 *   PORT   default 8000
 *   HOST   default 127.0.0.1
 *
 * Requires Node 18+ and the `express` npm dep.
 */

import express from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from '../tools/lib/mini-yaml.mjs';
import { adapt, listEnvironments, applyEnvironmentOverlay } from '../tools/lib/adapter.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const STUDIO_DIR = resolve(ROOT, 'studio');
const SCHEMA_PATH = resolve(
  ROOT, 'vendor', 'observability-pack-spec', 'v1.2', 'observability-pack.schema.json'
);
const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

// ---------- pack catalog ----------
//
// Catalog of packs the server knows about. Phase 5 adds packs/*.pack.yaml
// entries; Phase 3a ships with the vendored canonical example only.

const PACK_CATALOG = [
  {
    id: 'payment-service',
    label: 'Payment service (canonical example)',
    path: 'vendor/observability-pack-spec/v1.2/examples/payment-service.pack.yaml',
    description: "The spec repo's reference tier-1 pack — HTTP API + Kafka consumer.",
  },
];

function loadPackFile(relPath) {
  const abs = resolve(ROOT, relPath);
  if (!existsSync(abs)) throw new Error(`pack file missing: ${relPath}`);
  const text = readFileSync(abs, 'utf8');
  const ext = extname(relPath).toLowerCase();
  return ext === '.json' ? JSON.parse(text) : parseYaml(text);
}

// ---------- in-process validator (shares logic with tools/validate-pack.mjs) ----------
//
// The validator is small enough to inline here so /api/validate can return
// structured errors without spawning a subprocess. Kept in sync by hand for
// now; Phase 3b folds both into tools/lib/validator.mjs as a shared module.

const REQUIRED_API_VERSION = 'observability.platform/v1';
const REQUIRED_KIND = 'ObservabilityPack';
const URI_RE = /^[a-z][a-z0-9+.-]*:\S+$/i;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
function matchType(expected, actual, value) {
  if (expected === actual) return true;
  if (expected === 'integer' && actual === 'number' && Number.isInteger(value)) return true;
  if (expected === 'number'  && actual === 'number') return true;
  return false;
}
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every(k => deepEqual(a[k], b[k]));
  }
  return false;
}
function resolveRef(ref, root) {
  if (!ref.startsWith('#/$defs/')) throw new Error(`unsupported $ref: ${ref}`);
  const name = ref.slice('#/$defs/'.length);
  const t = root.$defs?.[name];
  if (!t) throw new Error(`unresolved $ref: ${ref}`);
  return t;
}
function validate(value, schema, path, errors, root) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.$ref) schema = resolveRef(schema.$ref, root);
  if (schema.type !== undefined) {
    const t = typeOf(value);
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(e => matchType(e, t, value))) {
      errors.push(`${path}: expected ${types.join('|')}, got ${t}`);
      return;
    }
  }
  if ('const' in schema && !deepEqual(value, schema.const)) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }
  if (schema.enum && !schema.enum.some(e => deepEqual(e, value))) {
    errors.push(`${path}: not in enum ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
  }
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: does not match pattern /${schema.pattern}/`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: length ${value.length} < minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: length ${value.length} > maxLength ${schema.maxLength}`);
    }
    if (schema.format === 'uri'       && !URI_RE.test(value))       errors.push(`${path}: not a valid uri`);
    if (schema.format === 'date-time' && !DATE_TIME_RE.test(value)) errors.push(`${path}: not a valid date-time`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push(`${path}: ${value} <= exclusiveMinimum ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) errors.push(`${path}: ${value} >= exclusiveMaximum ${schema.exclusiveMaximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: ${value.length} items < minItems ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: ${value.length} items > maxItems ${schema.maxItems}`);
    if (schema.items) value.forEach((v, i) => validate(v, schema.items, `${path}[${i}]`, errors, root));
    if (schema.contains) {
      const ok = value.some((v, i) => { const s = []; validate(v, schema.contains, `${path}[${i}]`, s, root); return s.length === 0; });
      if (!ok) errors.push(`${path}: contains schema not satisfied by any item`);
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (schema.required) for (const k of schema.required) if (!(k in value)) errors.push(`${path}: missing required key '${k}'`);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) errors.push(`${path}: ${keys.length} props < minProperties ${schema.minProperties}`);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) errors.push(`${path}: ${keys.length} props > maxProperties ${schema.maxProperties}`);
    if (schema.propertyNames) for (const k of keys) validate(k, schema.propertyNames, `${path}.(propertyName ${JSON.stringify(k)})`, errors, root);
    const props = schema.properties || {};
    const patternProps = schema.patternProperties;
    const addProps = schema.additionalProperties;
    for (const k of keys) {
      let matched = false;
      const cp = `${path}.${k}`;
      if (props[k]) { validate(value[k], props[k], cp, errors, root); matched = true; }
      if (patternProps) for (const [pat, sub] of Object.entries(patternProps)) if (new RegExp(pat).test(k)) { validate(value[k], sub, cp, errors, root); matched = true; }
      if (!matched) {
        if (addProps === false) errors.push(`${path}: unknown property '${k}'`);
        else if (addProps && typeof addProps === 'object') validate(value[k], addProps, cp, errors, root);
      }
    }
  }
  if (schema.allOf) for (const sub of schema.allOf) validate(value, sub, path, errors, root);
  if (schema.oneOf) {
    let passes = 0;
    for (const sub of schema.oneOf) { const s = []; validate(value, sub, path, s, root); if (s.length === 0) passes++; }
    if (passes === 0) errors.push(`${path}: matches none of oneOf branches`);
    else if (passes > 1) errors.push(`${path}: matches ${passes} oneOf branches (expected 1)`);
  }
  if (schema.anyOf && !schema.anyOf.some(sub => { const s = []; validate(value, sub, path, s, root); return s.length === 0; })) {
    errors.push(`${path}: matches none of anyOf branches`);
  }
  if (schema.not) { const s = []; validate(value, schema.not, path, s, root); if (s.length === 0) errors.push(`${path}: matches forbidden 'not' schema`); }
  if (schema.if) {
    const s = []; validate(value, schema.if, path, s, root);
    if (s.length === 0 && schema.then) validate(value, schema.then, path, errors, root);
    else if (s.length > 0 && schema.else) validate(value, schema.else, path, errors, root);
  }
}

function gatekeep(pack) {
  if (pack?.apiVersion !== REQUIRED_API_VERSION || pack?.kind !== REQUIRED_KIND) {
    return `not a canonical ObservabilityPack v1.2 manifest (apiVersion=${JSON.stringify(pack?.apiVersion)}, kind=${JSON.stringify(pack?.kind)})`;
  }
  return null;
}

function validateCanonical(pack) {
  const gate = gatekeep(pack);
  if (gate) return [gate];
  const errors = [];
  validate(pack, SCHEMA, '$', errors, SCHEMA);
  return errors;
}

// ---------- catalog descriptor ----------

function catalogEntry(meta) {
  try {
    const c = loadPackFile(meta.path);
    return {
      id: meta.id,
      label: meta.label,
      description: meta.description,
      name: c.metadata?.name,
      version: c.metadata?.version,
      binding: c.metadata?.binding,
      criticality: c.metadata?.bindings?.criticality,
      environments: listEnvironments(c),
      ok: true,
    };
  } catch (e) {
    return { id: meta.id, label: meta.label, ok: false, error: e.message };
  }
}

// ---------- routes ----------

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', false);
app.use(express.json({ limit: '4mb' }));
app.use(express.text({ type: ['application/x-yaml', 'text/yaml', 'text/plain'], limit: '4mb' }));

app.get('/healthz', (req, res) => {
  res.json({ ok: true, specVersion: '1.2', schemaPath: 'vendor/observability-pack-spec/v1.2/observability-pack.schema.json' });
});

app.get('/api/packs', (req, res) => {
  res.json({ packs: PACK_CATALOG.map(catalogEntry) });
});

app.get('/api/packs/:id', (req, res) => {
  const meta = PACK_CATALOG.find(p => p.id === req.params.id);
  if (!meta) return res.status(404).json({ error: `unknown pack: ${req.params.id}` });
  try {
    const canonical = loadPackFile(meta.path);
    const env = typeof req.query.env === 'string' && req.query.env ? req.query.env : null;
    const errors = validateCanonical(canonical);
    if (errors.length) return res.status(500).json({ error: 'pack failed schema validation', details: errors });
    const layered = adapt(canonical, { environment: env });
    res.json(layered);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/packs/:id/canonical', (req, res) => {
  const meta = PACK_CATALOG.find(p => p.id === req.params.id);
  if (!meta) return res.status(404).json({ error: `unknown pack: ${req.params.id}` });
  try {
    const canonical = loadPackFile(meta.path);
    const env = typeof req.query.env === 'string' && req.query.env ? req.query.env : null;
    const { spec, effective } = applyEnvironmentOverlay(canonical.spec || {}, env);
    res.json({ ...canonical, spec, __effectiveEnvironment: env, __effective: effective });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/validate', (req, res) => {
  try {
    let canonical;
    if (typeof req.body === 'string') {
      canonical = parseYaml(req.body);
    } else if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
      canonical = req.body;
    } else {
      return res.status(400).json({ ok: false, errors: ['expected JSON body or text/yaml body'] });
    }
    const errors = validateCanonical(canonical);
    if (errors.length) return res.json({ ok: false, errors });
    const env = typeof req.query.env === 'string' && req.query.env ? req.query.env : null;
    const adapted = adapt(canonical, { environment: env });
    res.json({ ok: true, adapted });
  } catch (e) {
    res.status(400).json({ ok: false, errors: [e.message] });
  }
});

// Static studio shell (served from studio/index.html and assets alongside).
app.use(express.static(STUDIO_DIR, { extensions: ['html'], index: 'index.html' }));

// SPA-style fallback: any unknown GET returns the studio shell so the client
// can route. The /api/* paths above already handled JSON requests.
app.get(/^(?!\/api\/).*/, (req, res, next) => {
  if (req.method !== 'GET') return next();
  res.sendFile(resolve(STUDIO_DIR, 'index.html'));
});

// ---------- entrypoint ----------

const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '127.0.0.1';

// Expose `app` for tests; only listen when invoked directly.
export { app };
export function start({ port = PORT, host = HOST, silent = false } = {}) {
  return new Promise((resolveListen, reject) => {
    const srv = app.listen(port, host, () => {
      const addr = srv.address();
      if (!silent) {
        process.stdout.write(`[studio] listening on http://${addr.address}:${addr.port}\n`);
      }
      resolveListen(srv);
    });
    srv.on('error', reject);
  });
}

const invokedDirectly = resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  start().catch(e => { process.stderr.write(`[studio] failed to start: ${e.message}\n`); process.exit(1); });
}
