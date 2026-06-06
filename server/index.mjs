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
import { crawlFiles, crawlToYaml } from '../tools/lib/crawler.mjs';
import { fetchMcp, buildCanonicalPack, createMcpClient } from '../tools/fetch-live-pack.mjs';
import { diffPacks } from '../tools/lib/diff.mjs';
import { compile, listTargets, compileCatalog, compileArtifact } from '../tools/lib/compile.mjs';

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
app.use(express.json({ limit: '16mb' }));   // /api/crawl can carry a whole repo's worth of YAML
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

app.get('/api/diff', (req, res) => {
  const aId = typeof req.query.a === 'string' ? req.query.a : null;
  const bId = typeof req.query.b === 'string' ? req.query.b : null;
  if (!aId || !bId) return res.status(400).json({ error: 'query params `a` and `b` (pack ids) required' });
  const aMeta = PACK_CATALOG.find(p => p.id === aId);
  const bMeta = PACK_CATALOG.find(p => p.id === bId);
  if (!aMeta) return res.status(404).json({ error: `unknown pack: ${aId}` });
  if (!bMeta) return res.status(404).json({ error: `unknown pack: ${bId}` });
  const aEnv = typeof req.query.aEnv === 'string' && req.query.aEnv ? req.query.aEnv : null;
  const bEnv = typeof req.query.bEnv === 'string' && req.query.bEnv ? req.query.bEnv : null;
  try {
    const aCanonical = loadPackFile(aMeta.path);
    const bCanonical = loadPackFile(bMeta.path);
    const aLayered = adapt(aCanonical, { environment: aEnv });
    const bLayered = adapt(bCanonical, { environment: bEnv });
    res.json(diffPacks(aLayered, bLayered));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- pack compiler ----------
//
// The pack is the source of truth; this endpoint emits the real
// platform artefacts (Prometheus rules, OTel Collector config, etc.)
// derived from it. Spec §9's reference implementation table made real.

app.get('/api/compile/targets', (req, res) => {
  res.json({ targets: listTargets() });
});

// ----------------------------------------------------------------
// /api/packs/:id/compile-catalog — enumerate every individually
// compilable artifact in this pack. The studio renders this as a
// left-nav tree; each leaf is then compiled via /api/packs/:id/
// compile-artifact?group=&flavor=&artifact= below.
// ----------------------------------------------------------------
app.get('/api/packs/:id/compile-catalog', (req, res) => {
  const meta = PACK_CATALOG.find(p => p.id === req.params.id);
  if (!meta) return res.status(404).json({ ok: false, error: `unknown pack: ${req.params.id}` });
  try {
    const canonical = loadPackFile(meta.path);
    const env = readEnv(req.query);
    const { canonical: overlaid } = overlaidCanonical(canonical, env);
    const catalog = compileCatalog(overlaid);
    res.json({
      pack: meta.id,
      env: env || null,
      ...catalog,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ----------------------------------------------------------------
// /api/packs/:id/compile-artifact?group=&flavor=&artifact=
// Per-artifact compilation. Returns the same content-type/body
// shape as /api/packs/:id/compile/:target so the client can reuse
// the existing display path.
// ----------------------------------------------------------------
app.get('/api/packs/:id/compile-artifact', (req, res) => {
  const meta = PACK_CATALOG.find(p => p.id === req.params.id);
  if (!meta) return res.status(404).json({ ok: false, error: `unknown pack: ${req.params.id}` });
  const group = String(req.query.group || '');
  const flavor = req.query.flavor ? String(req.query.flavor) : undefined;
  const artifact = req.query.artifact ? String(req.query.artifact) : 'all';
  if (!group) return res.status(400).json({ ok: false, error: 'group query param required' });
  try {
    const canonical = loadPackFile(meta.path);
    const env = readEnv(req.query);
    const { canonical: overlaid } = overlaidCanonical(canonical, env);
    const out = compileArtifact(overlaid, { group, flavor, artifact });
    res.setHeader('Content-Type', out.contentType + '; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.setHeader('X-Pack-Source', `${meta.id}@${overlaid?.metadata?.version || '?'}`);
    res.setHeader('X-Compile-Group', group);
    if (flavor)   res.setHeader('X-Compile-Flavor', flavor);
    if (artifact) res.setHeader('X-Compile-Artifact', artifact);
    res.send(out.content);
  } catch (e) {
    res.status(500).type('application/json').send(JSON.stringify({ ok: false, error: e.message }));
  }
});

// Deploy matrix — what's deployable, to which products, with what default
// MCP tool. Spec §9's reference table lists more targets but for now we
// only ship deploy paths to Grafana 12/13 (the version floor the spec
// requires and the only platform where the rules + dashboards land
// through a single unified API). OTel Collector + standalone
// Alertmanager remain download-only; the compile output is still
// emitted for hand-off, just not deployable from the UI.

const DEPLOY_PRODUCTS = ['grafana'];
const DEPLOY_VERSIONS = {
  grafana: ['12', '13'],
};
const RULES_SCOPES = ['both', 'recording', 'alerting'];

// (product, target) → default MCP tool name. The server lets the client
// override via body.mcpTool; this dispatch supplies the convention.
function defaultDeployTool({ product, target, scope }) {
  if (product === 'grafana') {
    if (target === 'prometheus-rules') {
      if (scope === 'recording') return 'apply_grafana_recording_rules';
      if (scope === 'alerting')  return 'apply_grafana_alerting_rules';
      return 'apply_grafana_rules';   // both
    }
    if (target === 'grafana-dashboard') return 'apply_grafana_dashboard';
  }
  return null;   // not deployable
}

function targetIsDeployable(target) {
  return target === 'prometheus-rules' || target === 'grafana-dashboard';
}

app.get('/api/deploy/matrix', (req, res) => {
  // Surface the deployable targets + products + versions so the client
  // can drive the UI from one source of truth.
  res.json({
    products: DEPLOY_PRODUCTS,
    versions: DEPLOY_VERSIONS,
    scopes: RULES_SCOPES,
    targets: {
      'prometheus-rules': {
        deployable: true,
        products: ['grafana'],
        scopable: true,
        scopes: RULES_SCOPES,
        description: 'Recording + multi-window burn-rate alerting rules, applied via Grafana\'s unified alerting (Mimir-compatible) ruler.',
      },
      'grafana-dashboard': {
        deployable: true,
        products: ['grafana'],
        scopable: false,
        description: 'Grafana 12/13 dashboard JSON, applied via the dashboards API.',
      },
      'otel-collector': {
        deployable: false,
        reason: 'OTel Collector configs are environment-specific; emit and apply via your own deploy pipeline (kustomize / helm).',
      },
      'alertmanager': {
        deployable: false,
        reason: 'Standalone Alertmanager deploys are handled out-of-band; routes are folded into Grafana unified alerting for now.',
      },
    },
  });
});

// Filter a prometheus-rules YAML payload down to recording rules only or
// alerting rules only. This lives in the deploy path (not in compile)
// because the compiled output remains canonical; scope is a deploy-time
// concern.
function filterPromRulesScope(yamlText, scope) {
  if (!scope || scope === 'both') return yamlText;
  // Parse with our mini YAML, drop rules of the other kind, re-emit.
  // We keep the comment banner the compiler put at the top.
  const headerMatch = yamlText.match(/^(\s*#[^\n]*\n)+/);
  const header = headerMatch ? headerMatch[0] : '';
  const obj = parseYaml(yamlText.replace(/^(\s*#[^\n]*\n)+/, ''));
  if (!obj?.groups) return yamlText;
  const wantKey = scope === 'recording' ? 'record' : 'alert';
  obj.groups = obj.groups
    .map(g => ({ ...g, rules: (g.rules || []).filter(r => wantKey in r) }))
    .filter(g => (g.rules || []).length > 0);
  return header + emitYaml(obj);
}

app.post('/api/packs/:id/deploy/:target', async (req, res) => {
  const meta = PACK_CATALOG.find(p => p.id === req.params.id);
  if (!meta) return res.status(404).json({ ok: false, error: `unknown pack: ${req.params.id}` });

  const target = req.params.target;
  if (!targetIsDeployable(target)) {
    return res.status(400).json({
      ok: false, target,
      error: `deploy not supported for target '${target}'. Deploy is currently limited to Grafana 12/13 — see GET /api/deploy/matrix.`,
    });
  }

  const body = req.body || {};
  const mcpUrl  = typeof body.mcpUrl  === 'string' ? body.mcpUrl.trim()  : '';
  const mcpAuth = typeof body.mcpAuth === 'string' ? body.mcpAuth        : null;
  const product = (typeof body.targetProduct === 'string' && body.targetProduct.trim())
    ? body.targetProduct.trim() : 'grafana';
  const version = (typeof body.targetVersion === 'string' && body.targetVersion.trim())
    ? body.targetVersion.trim() : '12';
  const scope = (target === 'prometheus-rules' && typeof body.scope === 'string' && RULES_SCOPES.includes(body.scope))
    ? body.scope : (target === 'prometheus-rules' ? 'both' : undefined);

  if (!DEPLOY_PRODUCTS.includes(product)) {
    return res.status(400).json({ ok: false, error: `unsupported target product: ${product}. Known: ${DEPLOY_PRODUCTS.join(', ')}.` });
  }
  if (!DEPLOY_VERSIONS[product]?.includes(version)) {
    return res.status(400).json({ ok: false, error: `unsupported ${product} version: ${version}. Known: ${(DEPLOY_VERSIONS[product] || []).join(', ')}.` });
  }

  const mcpTool = (typeof body.mcpTool === 'string' && body.mcpTool.trim())
    ? body.mcpTool.trim()
    : defaultDeployTool({ product, target, scope });
  if (!mcpTool) {
    return res.status(400).json({ ok: false, error: 'no default deploy tool for this (product, target) combination; pass mcpTool in body.' });
  }

  const env = readEnv(req.query);
  const dashboardId = typeof req.query.dashboardId === 'string' ? req.query.dashboardId : undefined;
  if (!mcpUrl) return res.status(400).json({ ok: false, error: 'mcpUrl required in JSON body' });

  const t0 = Date.now();
  try {
    const canonical = loadPackFile(meta.path);
    const { canonical: overlaid } = overlaidCanonical(canonical, env);
    const compiled = compile(overlaid, target, { dashboardId });

    // For rules deploy, apply the scope filter (recording-only / alerting-only).
    const payload = (target === 'prometheus-rules')
      ? filterPromRulesScope(compiled.content, scope)
      : compiled.content;

    process.stderr.write(`[deploy] ${meta.id}@${canonical.metadata?.version || '?'} -> ${mcpUrl} via ${mcpTool} ` +
      `(${product} ${version}, target=${target}, scope=${scope || '—'}, env=${env || 'none'}, ${payload.length}b)\n`);

    const { rpc, callTool } = createMcpClient({ mcpUrl, mcpAuth });
    await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'observabilitypack-studio-deploy', version: '0.3.0' },
    }).catch(() => {});

    const args = {
      payload,
      content_type: compiled.contentType,
      environment: env || undefined,
      filename: compiled.filename,
      pack_source: `${meta.id}@${canonical.metadata?.version || '?'}`,
      target,
      target_product: product,
      target_version: version,
      scope: scope || undefined,
    };
    const result = await callTool(mcpTool, args);

    const tookMs = Date.now() - t0;
    process.stderr.write(`[deploy]   ok in ${tookMs}ms\n`);
    res.json({
      ok: true,
      target, env, tool: mcpTool, mcpUrl,
      targetProduct: product, targetVersion: version, scope: scope || null,
      filename: compiled.filename,
      bytes: payload.length,
      tookMs,
      result,
    });
  } catch (e) {
    const tookMs = Date.now() - t0;
    process.stderr.write(`[deploy]   error in ${tookMs}ms: ${e.message}\n`);
    res.status(502).json({ ok: false, error: e.message, tool: mcpTool, target,
      targetProduct: product, targetVersion: version, scope: scope || null, env, tookMs });
  }
});

app.get('/api/packs/:id/compile/:target', (req, res) => {
  const meta = PACK_CATALOG.find(p => p.id === req.params.id);
  if (!meta) return res.status(404).json({ error: `unknown pack: ${req.params.id}` });
  try {
    const canonical = loadPackFile(meta.path);
    const env = readEnv(req.query);
    const { canonical: overlaid } = overlaidCanonical(canonical, env);
    const opts = {
      dashboardId: typeof req.query.dashboardId === 'string' && req.query.dashboardId
        ? req.query.dashboardId : undefined,
    };
    const out = compile(overlaid, req.params.target, opts);
    const isDownload = req.query.download === '1';
    res.setHeader('Content-Type', out.contentType + '; charset=utf-8');
    if (isDownload) {
      res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    } else {
      res.setHeader('Content-Disposition', `inline; filename="${out.filename}"`);
    }
    res.setHeader('X-Pack-Source', `${meta.id}@${canonical?.metadata?.version || '?'}`);
    res.setHeader('X-Compile-Target', req.params.target);
    res.send(out.content);
  } catch (e) {
    res.status(400).json({ error: e.message });
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

// ----------------------------------------------------------------
// POST /api/crawl — Path A of the pack-creation user journey.
//
// Accepts an in-memory file map (the client uploads or drags in
// files; the server never touches disk) and returns a draft
// canonical pack plus the validation + conformance reports.
//
// Body: {
//   files: { [relPath]: contentString },
//   repoName?: string,
//   environment?: string,
//   criticality?: 'tier-1'|'tier-2'|'tier-3',
//   binding?: string,
//   owners?: string[]
// }
//
// Response: { ok, canonical, canonicalYaml, summary, evidence,
//             validation: { ok, errors }, conformance }
//
// The crawler library is shared with tools/crawl-repo.mjs (the
// CLI form); both feed crawlFiles() the same in-memory map shape.
// ----------------------------------------------------------------
app.post('/api/crawl', (req, res) => {
  const body = req.body || {};
  const files = body.files;
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    return res.status(400).json({ ok: false, error: 'expected JSON body { files: { <relPath>: <content> } }' });
  }
  const entries = Object.entries(files);
  if (entries.length === 0) {
    return res.status(400).json({ ok: false, error: 'no files provided' });
  }
  for (const [k, v] of entries) {
    if (typeof k !== 'string' || typeof v !== 'string') {
      return res.status(400).json({ ok: false, error: `each file entry must be string→string (offending key: ${JSON.stringify(k)})` });
    }
  }
  // Cap total payload to 16 MB so a runaway repo can't OOM the server.
  let total = 0;
  for (const [_, v] of entries) total += v.length;
  if (total > 16 * 1024 * 1024) {
    return res.status(413).json({ ok: false, error: `payload too large (${total} bytes; cap is 16MB). Drop large files like build artefacts or vendored binaries.` });
  }

  const opts = {
    repoName: typeof body.repoName === 'string' ? body.repoName : undefined,
    environment: typeof body.environment === 'string' ? body.environment : undefined,
    criticality: typeof body.criticality === 'string' ? body.criticality : undefined,
    binding: typeof body.binding === 'string' ? body.binding : undefined,
    owners: Array.isArray(body.owners) ? body.owners.map(String) : undefined,
  };

  const t0 = Date.now();
  try {
    const { yaml, summary, evidence } = crawlToYaml(files, opts);
    const { canonical } = crawlFiles(files, opts);
    const validationErrors = validateCanonical(canonical, SCHEMA);
    const conformance = evaluateConformance(canonical);
    process.stderr.write(`[crawl] ${entries.length} files, ${summary.files.classified} classified, ${Object.keys(evidence).length} evidence, tier=${summary.inferred.tier}, valid=${validationErrors.length === 0}, ${Date.now() - t0}ms\n`);
    res.json({
      ok: true,
      canonical,
      canonicalYaml: yaml,
      summary,
      evidence,
      validation: { ok: validationErrors.length === 0, errors: validationErrors },
      conformance,
      tookMs: Date.now() - t0,
    });
  } catch (e) {
    process.stderr.write(`[crawl] error: ${e.message}\n`);
    res.status(500).json({ ok: false, error: e.message });
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
