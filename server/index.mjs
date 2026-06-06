#!/usr/bin/env node
/**
 * server/index.mjs
 *
 * Express server for ObservabilityPack Studio v0.3+.
 *
 * Responsibilities:
 *   - Serve the studio HTML/CSS/JS shell from studio/.
 *   - Expose a JSON API that runs the validator, adapter, and conformance
 *     scorer server-side. The browser fetches adapted layered packs and
 *     pre-computed conformance reports; no in-browser YAML parsing, no
 *     in-browser schema validation, no embedded pack literals.
 *
 * Routes:
 *   GET  /                                Studio HTML shell
 *   GET  /healthz                         Liveness probe
 *   GET  /api/packs                       Pack catalog
 *   GET  /api/packs/:id                   Adapted layered pack (?env=<name>)
 *   GET  /api/packs/:id/canonical         Canonical manifest + env overlay (?env=<name>)
 *   GET  /api/packs/:id/conformance       Maturity-rubric scoring (?env=<name>)
 *   GET  /api/maturity-rubric             Rubric metadata (clause definitions)
 *   POST /api/validate                    Validate uploaded JSON/YAML body
 *
 * Env:
 *   PORT   default 8000
 *   HOST   default 127.0.0.1
 */

import express from 'express';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, emit as emitYaml } from '../tools/lib/mini-yaml.mjs';
import { adapt, listEnvironments, applyEnvironmentOverlay } from '../tools/lib/adapter.mjs';
import { validateCanonical, SPEC_VERSION } from '../tools/lib/validator.mjs';
import { evaluateConformance, RUBRIC } from '../tools/lib/conformance.mjs';
import { fetchMcp, buildCanonicalPack } from '../tools/fetch-live-pack.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const STUDIO_DIR = resolve(ROOT, 'studio');
const SCHEMA_PATH = resolve(
  ROOT, 'vendor', 'observability-pack-spec', `v${SPEC_VERSION}`, 'observability-pack.schema.json'
);
const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

// ---------- pack catalog ----------

const PACK_CATALOG = [
  {
    id: 'payment-service',
    label: 'Payment service (canonical example)',
    path: 'vendor/observability-pack-spec/v1.2/examples/payment-service.pack.yaml',
    description: "The spec repo's reference tier-1 pack — HTTP API + Kafka consumer.",
  },
  {
    id: 'target-advanced',
    label: 'Target advanced (tier-1 reference)',
    path: 'packs/target-advanced.pack.yaml',
    description: 'Aspirational tier-1 — 100% MUST conformance, all 5 SHOULDs pass.',
  },
  {
    id: 'production-curated',
    label: 'Production curated (tier-2 BAU)',
    path: 'packs/production-curated.pack.yaml',
    description: 'Hand-curated tier-2 baseline with intentional gaps the conformance panel surfaces.',
  },
  {
    id: 'production-live',
    label: 'Production live (MCP fetcher)',
    path: 'packs/production-live.pack.yaml',
    description: 'Refreshed by the refresh-live-pack workflow. Reflects MCP-verifiable state.',
  },
  {
    id: 'demo-skeleton',
    label: 'Demo skeleton (tier-3 minimum)',
    path: 'packs/demo-skeleton.pack.yaml',
    description: "Smallest valid canonical v1.2 pack — every schema-required section with the leanest content.",
  },
];

function loadPackFile(relPath) {
  const abs = resolve(ROOT, relPath);
  if (!existsSync(abs)) throw new Error(`pack file missing: ${relPath}`);
  const text = readFileSync(abs, 'utf8');
  const ext = extname(relPath).toLowerCase();
  return ext === '.json' ? JSON.parse(text) : parseYaml(text);
}

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

function readEnv(query) {
  return typeof query.env === 'string' && query.env ? query.env : null;
}

// Returns a canonical object with the env overlay applied to spec.* AND
// effective criticality/target propagated up to metadata.bindings so the
// conformance scorer sees the correct tier for the selected environment.
// (The adapter already takes opts.environment and produces its own metadata
// projection — this helper is for non-adapter consumers.)
function overlaidCanonical(canonical, envName) {
  const { spec, effective } = applyEnvironmentOverlay(canonical.spec || {}, envName);
  const next = { ...canonical, spec };
  if (effective.criticality || effective.target) {
    next.metadata = {
      ...(canonical.metadata || {}),
      bindings: {
        ...(canonical.metadata?.bindings || {}),
        ...(effective.criticality ? { criticality: effective.criticality } : {}),
        ...(effective.target ? { default_target: effective.target } : {}),
      },
    };
  }
  return { canonical: next, effective };
}

// ---------- app ----------

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', false);
app.use(express.json({ limit: '4mb' }));
app.use(express.text({ type: ['application/x-yaml', 'text/yaml', 'text/plain'], limit: '4mb' }));

app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    specVersion: SPEC_VERSION,
    schemaPath: `vendor/observability-pack-spec/v${SPEC_VERSION}/observability-pack.schema.json`,
  });
});

app.get('/api/packs', (req, res) => {
  res.json({ packs: PACK_CATALOG.map(catalogEntry) });
});

app.get('/api/packs/:id', (req, res) => {
  const meta = PACK_CATALOG.find(p => p.id === req.params.id);
  if (!meta) return res.status(404).json({ error: `unknown pack: ${req.params.id}` });
  try {
    const canonical = loadPackFile(meta.path);
    const env = readEnv(req.query);
    const errors = validateCanonical(canonical, SCHEMA);
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
    const env = readEnv(req.query);
    const { canonical: overlaid, effective } = overlaidCanonical(canonical, env);
    res.json({ ...overlaid, __effectiveEnvironment: env, __effective: effective });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/packs/:id/conformance', (req, res) => {
  const meta = PACK_CATALOG.find(p => p.id === req.params.id);
  if (!meta) return res.status(404).json({ error: `unknown pack: ${req.params.id}` });
  try {
    const canonical = loadPackFile(meta.path);
    const env = readEnv(req.query);
    const { canonical: overlaid } = overlaidCanonical(canonical, env);
    const report = evaluateConformance(overlaid);
    res.json({ environment: env, ...report });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/maturity-rubric', (req, res) => {
  res.json({
    specVersion: SPEC_VERSION,
    docs: `vendor/observability-pack-spec/v${SPEC_VERSION}/docs/maturity-model.md`,
    clauses: RUBRIC.map(({ evaluate, ...rest }) => rest),
  });
});

// ---------- live MCP refresh ----------
//
// The cron-driven workflow (.github/workflows/refresh-live-pack.yml) is the
// production path. This in-browser endpoint exists so a dev session can
// kick off an ad-hoc refresh from a local MCP without spawning a process.

const LIVE_PACK_PATH = 'packs/production-live.pack.yaml';

app.get('/api/live-status', (req, res) => {
  try {
    const abs = resolve(ROOT, LIVE_PACK_PATH);
    if (!existsSync(abs)) return res.json({ present: false });
    const c = parseYaml(readFileSync(abs, 'utf8'));
    const a = c.metadata?.annotations || {};
    res.json({
      present: true,
      refreshedAt:        a['mcp.refreshedAt']        || null,
      url:                a['mcp.url']                || null,
      toolsCalled:        a['mcp.toolsCalled']        || '',
      toolsFailed:        a['mcp.toolsFailed']        || '',
      servicesDiscovered: a['mcp.servicesDiscovered'] || '',
      baselinesComputed:  a['mcp.baselinesComputed']  || '0',
      activeAnomalies:    a['mcp.activeAnomalies']    || '0',
    });
  } catch (e) {
    res.json({ present: false, error: e.message });
  }
});

app.post('/api/refresh-live', async (req, res) => {
  const body = req.body || {};
  const mcpUrl = typeof body.mcpUrl === 'string' && body.mcpUrl.trim() ? body.mcpUrl.trim() : null;
  const mcpAuth = typeof body.mcpAuth === 'string' && body.mcpAuth ? body.mcpAuth : null;
  if (!mcpUrl) return res.status(400).json({ ok: false, error: 'mcpUrl required in JSON body' });

  const t0 = Date.now();
  try {
    process.stderr.write(`[refresh-live] POST /api/refresh-live -> ${mcpUrl}\n`);
    const fetched = await fetchMcp({ mcpUrl, mcpAuth });
    const refreshedAt = new Date().toISOString();
    const pack = buildCanonicalPack({ refreshedAt, mcpUrl, ...fetched });
    const errors = validateCanonical(pack, SCHEMA);
    if (errors.length) {
      return res.status(500).json({ ok: false, error: 'built pack failed schema validation', details: errors });
    }
    const abs = resolve(ROOT, LIVE_PACK_PATH);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, emitYaml(pack));
    process.stderr.write(`[refresh-live]   ok in ${Date.now() - t0}ms; ` +
      `services=${pack.metadata.annotations['mcp.servicesDiscovered'] || '(none)'} ` +
      `failed=${pack.metadata.annotations['mcp.toolsFailed'] || 'none'}\n`);
    res.json({
      ok: true,
      refreshedAt,
      pack: adapt(pack),
      annotations: pack.metadata.annotations,
    });
  } catch (e) {
    process.stderr.write(`[refresh-live]   error in ${Date.now() - t0}ms: ${e.message}\n`);
    res.status(502).json({ ok: false, error: e.message, details: e.details });
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
    const errors = validateCanonical(canonical, SCHEMA);
    if (errors.length) return res.json({ ok: false, errors });
    const env = readEnv(req.query);
    const adapted = adapt(canonical, { environment: env });
    const { canonical: overlaid } = overlaidCanonical(canonical, env);
    const conformance = evaluateConformance(overlaid);
    res.json({ ok: true, adapted, conformance });
  } catch (e) {
    res.status(400).json({ ok: false, errors: [e.message] });
  }
});

// Static studio shell + assets.
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

export { app };
export function start({ port = PORT, host = HOST, silent = false } = {}) {
  return new Promise((resolveListen, reject) => {
    const srv = app.listen(port, host, () => {
      const addr = srv.address();
      if (!silent) process.stdout.write(`[studio] listening on http://${addr.address}:${addr.port}\n`);
      resolveListen(srv);
    });
    srv.on('error', reject);
  });
}

const invokedDirectly = resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  start().catch(e => { process.stderr.write(`[studio] failed to start: ${e.message}\n`); process.exit(1); });
}
