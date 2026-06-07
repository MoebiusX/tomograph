#!/usr/bin/env node
/**
 * server/index.mjs
 *
 * Express server for Tomograph v0.3+.
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
import { createHash } from 'node:crypto';
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
//
// The studio boots EMPTY by design (Phase 7q). No packs are auto-loaded.
// The user opens a pack from disk via:
//   - Upload (drag-drop or file picker)
//   - "New from repo" (Path A — crawler)
//   - "New from live" (Path B — MCP draft)
//   - GET /api/examples to browse archived reference packs in examples/
//
// The five previously bundled packs (Payment service, Target advanced,
// Production curated, Production live, Demo skeleton) now live under
// examples/ as reference material, surfaced via /api/examples but not
// auto-loaded into the catalog.

const PACK_CATALOG = [];

// Examples directory — archived reference packs. Browsed on demand via
// the home screen's "Browse examples" link. Each entry mirrors the
// catalog shape so the existing /api/packs/:id paths keep working when
// the user opens an example.
const EXAMPLE_PACKS = [
  {
    id: 'kafka-reference',
    label: 'Kafka (catalogue reference · tier-2)',
    path: 'examples/kafka.pack.yaml',
    description: 'State-of-the-art reference pack for Apache Kafka 3.x. Five operational vital signs, multi-window burn-rate alerts, 4 chaos experiments. Every section evidence-cited in docs/catalogue-evidence/kafka.md.',
    catalogue: true,
  },
  {
    id: 'prometheus-reference',
    label: 'Prometheus (catalogue reference · tier-2)',
    path: 'examples/prometheus.pack.yaml',
    description: 'State-of-the-art reference pack for Prometheus 2.45+ self-monitoring (via Meta-Prometheus pattern). Eight operational vital signs, 4 chaos experiments. Every section evidence-cited in docs/catalogue-evidence/prometheus.md.',
    catalogue: true,
  },
  {
    id: 'grafana-reference',
    label: 'Grafana (catalogue reference · tier-2)',
    path: 'examples/grafana.pack.yaml',
    description: 'State-of-the-art reference pack for Grafana 11.x including unified alerting. Eight operational vital signs (HTTP, datasource proxy, database, alerting evaluation, plugins, login), 4 chaos experiments, 3-layer synthetic checks. Paired with the Prometheus reference pack. Every section evidence-cited in docs/catalogue-evidence/grafana.md.',
    catalogue: true,
  },
  {
    id: 'payment-service',
    label: 'Payment service (canonical example)',
    path: 'examples/payment-service.pack.yaml',
    description: "The spec repo's reference tier-1 pack — HTTP API + Kafka consumer.",
  },
  {
    id: 'target-advanced',
    label: 'Target advanced (tier-1 reference)',
    path: 'examples/target-advanced.pack.yaml',
    description: 'Aspirational tier-1 — 100% MUST conformance, all 5 SHOULDs pass.',
  },
  {
    id: 'production-curated',
    label: 'Production curated (tier-2 BAU)',
    path: 'examples/production-curated.pack.yaml',
    description: 'Hand-curated tier-2 baseline with intentional gaps the conformance panel surfaces.',
  },
  {
    id: 'production-live',
    label: 'Production live (MCP fetcher)',
    path: 'examples/production-live.pack.yaml',
    description: 'Refreshed by the refresh-live-pack workflow. Reflects MCP-verifiable state.',
  },
  {
    id: 'demo-skeleton',
    label: 'Demo skeleton (tier-3 minimum)',
    path: 'examples/demo-skeleton.pack.yaml',
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

// ---------- uploaded / crawled / drafted packs registry ----------
//
// In-memory registry for packs that didn't come from disk (uploaded via
// /api/validate, crawled via /api/crawl, drafted via /api/draft-from-mcp).
// Demoing — and any per-artefact compile, conformance score, deploy or
// diff against a freshly-created pack — needs those packs to be addressable
// by an id under /api/packs/:id/*. Without this they'd be opaque blobs the
// server can't refer back to.
//
// Capped at MAX_UPLOADS to bound memory; oldest entry evicted on overflow.
// Process-scoped — restart clears the map. Persistence on the client side
// gracefully drops unknown ids on rehydrate (rehydrateFromPersistence
// validates against catalog ∪ examples ∪ uploads).
const UPLOADED_PACKS = new Map();   // id → { canonical, source, createdAt }
const MAX_UPLOADS = 20;

function slugify(s) {
  return String(s || 'pack')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'pack';
}

// Deterministic content hash — same canonical → same id across restarts,
// engineers, and environments. The first 8 hex chars of SHA-256 over the
// JSON.stringify of the canonical pack object. 8 chars = 32 bits = ~4B
// slots, comfortably collision-free for the demo's 20-pack cap. Run-time
// annotations (metadata.annotations.mcp.refreshedAt etc.) ARE included in
// the hash on purpose — two packs that differ only in their refreshedAt
// timestamp are genuinely different snapshots and deserve distinct ids.
function contentHash(canonical) {
  const json = JSON.stringify(canonical || {});
  return createHash('sha256').update(json).digest('hex').slice(0, 8);
}

function registerUploadedPack(canonical, source) {
  const slug = slugify(canonical?.metadata?.name || source || 'pack');
  const id = `uploaded-${slug}-${contentHash(canonical)}`;
  // Idempotent: if the same canonical content was already registered,
  // delete + re-insert refreshes its LRU position without minting a new
  // id. That makes re-upload safe (no duplicate entries) AND keeps the
  // user's pick alive when they're actively working with that pack.
  if (UPLOADED_PACKS.has(id)) UPLOADED_PACKS.delete(id);
  UPLOADED_PACKS.set(id, { canonical, source: source || 'upload', createdAt: Date.now() });
  // Evict the oldest if we've blown the cap.
  while (UPLOADED_PACKS.size > MAX_UPLOADS) {
    const oldestKey = UPLOADED_PACKS.keys().next().value;
    UPLOADED_PACKS.delete(oldestKey);
  }
  return id;
}

function uploadedMeta(id) {
  const upl = UPLOADED_PACKS.get(id);
  if (!upl) return null;
  return {
    id,
    path: null,        // signal: not file-backed
    canonical: upl.canonical,
    label: upl.canonical?.metadata?.name || id,
    description: `Uploaded pack — ${upl.source}`,
    source: upl.source,
    uploaded: true,
  };
}

// Resolve a canonical pack object regardless of where it came from. Used
// by every /api/packs/:id/* handler so uploaded packs are treated the
// same as catalog or example packs.
function loadPackCanonical(meta) {
  if (meta?.canonical) return meta.canonical;
  if (meta?.path)      return loadPackFile(meta.path);
  throw new Error(`pack meta has neither canonical nor path: ${meta?.id}`);
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

// Express's PayloadTooLargeError is thrown by the body parsers BEFORE
// any of our handlers run, and the default error path returns HTML.
// /api/* always wants JSON so the client can show a clean error and
// hint the user toward client-side filtering instead of dumping a stack
// trace into the dropzone.
app.use((err, req, res, next) => {
  if (err?.type === 'entity.too.large' || err?.status === 413) {
    if ((req.path || '').startsWith('/api/')) {
      const limit = err.limit ? Math.round(err.limit / 1024 / 1024) + 'MB' : '16MB';
      return res.status(413).json({
        ok: false,
        error: `Request body too large (cap ${limit}). The crawler should filter to observability artefacts only — drop a large repo and the client will pre-classify; if you're hitting this you may have an in-flight build.`,
      });
    }
  }
  return next(err);
});

app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    specVersion: SPEC_VERSION,
    schemaPath: `vendor/observability-pack-spec/v${SPEC_VERSION}/observability-pack.schema.json`,
  });
});

// Wipe in-memory uploaded / crawled / drafted packs. Used by the
// studio's RESET button so the user can start truly fresh — the client
// pairs this with a localStorage.clear() + reload. No body, no params.
// Returns the number of entries dropped so the client can echo it.
app.delete('/api/uploads', (req, res) => {
  const dropped = UPLOADED_PACKS.size;
  UPLOADED_PACKS.clear();
  res.json({ ok: true, dropped });
});

app.get('/api/packs', (req, res) => {
  // Catalog + in-memory uploads. Uploaded packs lead the list so the
  // picker surfaces them at the top — they're the user's just-created
  // work and most likely what they want to interact with next.
  const uploads = [...UPLOADED_PACKS.keys()].map(id => catalogEntryForUpload(id)).filter(Boolean);
  res.json({ packs: [...uploads, ...PACK_CATALOG.map(catalogEntry)] });
});

function catalogEntryForUpload(id) {
  const meta = uploadedMeta(id);
  if (!meta) return null;
  const c = meta.canonical;
  return {
    id,
    label: meta.label,
    description: meta.description,
    name: c?.metadata?.name,
    version: c?.metadata?.version,
    binding: c?.metadata?.binding,
    criticality: c?.metadata?.bindings?.criticality,
    environments: listEnvironments(c),
    source: 'uploaded',
    ok: true,
  };
}

// Opt-in lookup across uploads + catalog + examples — used by every
// /api/packs/:id/* route so uploaded / crawled / drafted packs work the
// same as file-backed packs (compile, conformance, diff, deploy etc).
function findPackMeta(id) {
  const upl = uploadedMeta(id);
  if (upl) return upl;
  return PACK_CATALOG.find(p => p.id === id)
      || EXAMPLE_PACKS.find(p => p.id === id);
}

// Browse the archived reference packs without auto-loading them. The
// home screen renders these as a small "Browse examples" affordance.
app.get('/api/examples', (req, res) => {
  res.json({ examples: EXAMPLE_PACKS.map(catalogEntry) });
});

app.get('/api/packs/:id', (req, res) => {
  const meta = findPackMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: `unknown pack: ${req.params.id}` });
  try {
    const canonical = loadPackCanonical(meta);
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
  const meta = findPackMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: `unknown pack: ${req.params.id}` });
  try {
    const canonical = loadPackCanonical(meta);
    const env = readEnv(req.query);
    const { canonical: overlaid, effective } = overlaidCanonical(canonical, env);
    res.json({ ...overlaid, __effectiveEnvironment: env, __effective: effective });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/packs/:id/conformance', (req, res) => {
  const meta = findPackMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: `unknown pack: ${req.params.id}` });
  try {
    const canonical = loadPackCanonical(meta);
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
  const aMeta = findPackMeta(aId);
  const bMeta = findPackMeta(bId);
  if (!aMeta) return res.status(404).json({ error: `unknown pack: ${aId}` });
  if (!bMeta) return res.status(404).json({ error: `unknown pack: ${bId}` });
  const aEnv = typeof req.query.aEnv === 'string' && req.query.aEnv ? req.query.aEnv : null;
  const bEnv = typeof req.query.bEnv === 'string' && req.query.bEnv ? req.query.bEnv : null;
  try {
    const aCanonical = loadPackCanonical(aMeta);
    const bCanonical = loadPackCanonical(bMeta);
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
  const meta = findPackMeta(req.params.id);
  if (!meta) return res.status(404).json({ ok: false, error: `unknown pack: ${req.params.id}` });
  try {
    const canonical = loadPackCanonical(meta);
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
  const meta = findPackMeta(req.params.id);
  if (!meta) return res.status(404).json({ ok: false, error: `unknown pack: ${req.params.id}` });
  const group = String(req.query.group || '');
  const flavor = req.query.flavor ? String(req.query.flavor) : undefined;
  const artifact = req.query.artifact ? String(req.query.artifact) : 'all';
  if (!group) return res.status(400).json({ ok: false, error: 'group query param required' });
  try {
    const canonical = loadPackCanonical(meta);
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

// ----------------------------------------------------------------
// POST /api/packs/:id/deploy-bulk — multi-artefact deploy.
// Body: {
//   mcpUrl, mcpAuth?,
//   targetProduct, targetVersion, targetFolder?,
//   items: [{ group, flavor?, artifact?, dashboardId?, scope? }, ...]
// }
// Iterates items, compiling each via compileArtifact() and pushing
// to the MCP tool the dispatcher chooses based on group + flavor.
// Returns per-item ok/error so the UI can show partial success
// instead of failing the whole batch.
// ----------------------------------------------------------------
app.post('/api/packs/:id/deploy-bulk', async (req, res) => {
  const meta = findPackMeta(req.params.id);
  if (!meta) return res.status(404).json({ ok: false, error: `unknown pack: ${req.params.id}` });
  const body = req.body || {};
  const mcpUrl  = typeof body.mcpUrl  === 'string' ? body.mcpUrl.trim() : '';
  const mcpAuth = typeof body.mcpAuth === 'string' ? body.mcpAuth : null;
  const product = (typeof body.targetProduct === 'string' && body.targetProduct.trim()) ? body.targetProduct.trim() : 'grafana';
  const version = (typeof body.targetVersion === 'string' && body.targetVersion.trim()) ? body.targetVersion.trim() : '12';
  const folder  = typeof body.targetFolder === 'string' ? body.targetFolder.trim() : '';
  const items = Array.isArray(body.items) ? body.items : null;
  const env = readEnv(req.query);

  if (!mcpUrl) return res.status(400).json({ ok: false, error: 'mcpUrl required in JSON body' });
  if (!items || items.length === 0) return res.status(400).json({ ok: false, error: 'items array required and must be non-empty' });
  if (!DEPLOY_PRODUCTS.includes(product)) return res.status(400).json({ ok: false, error: `unsupported target product: ${product}` });
  if (!DEPLOY_VERSIONS[product]?.includes(version)) return res.status(400).json({ ok: false, error: `unsupported ${product} version: ${version}` });

  const t0 = Date.now();
  const canonical = loadPackCanonical(meta);
  const { canonical: overlaid } = overlaidCanonical(canonical, env);

  // Map item.group → legacy target id used by defaultDeployTool.
  const targetFor = (group) => {
    if (group === 'rules') return 'prometheus-rules';
    if (group === 'dashboards') return 'grafana-dashboard';
    return group;
  };

  const { rpc, callTool } = createMcpClient({ mcpUrl, mcpAuth });
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'observabilitypack-studio-deploy-bulk', version: '0.3.0' },
  }).catch(() => {});

  const results = [];
  process.stderr.write(`[deploy-bulk] ${meta.id} -> ${mcpUrl} (${items.length} item${items.length === 1 ? '' : 's'}, ${product} ${version})\n`);

  for (const item of items) {
    const itStart = Date.now();
    const itemTarget = targetFor(item.group);
    try {
      const compiled = compileArtifact(overlaid, {
        group: item.group,
        flavor: item.flavor,
        artifact: item.artifact || 'all',
        dashboardId: item.dashboardId,
      });
      const scope = item.scope || (itemTarget === 'prometheus-rules' ? 'both' : undefined);
      const tool = defaultDeployTool({ product, target: itemTarget, scope });
      if (!tool) {
        results.push({ item, ok: false, error: `no default deploy tool for (${product}, ${itemTarget})`, tookMs: Date.now() - itStart });
        continue;
      }
      // Filter rules to scope if applicable.
      const payload = (itemTarget === 'prometheus-rules' && scope && scope !== 'both')
        ? filterPromRulesScope(compiled.content, scope)
        : compiled.content;
      const result = await callTool(tool, {
        payload,
        content_type: compiled.contentType,
        environment: env || undefined,
        filename: compiled.filename,
        pack_source: `${meta.id}@${overlaid?.metadata?.version || '?'}`,
        target: itemTarget,
        target_product: product,
        target_version: version,
        scope,
        folder: folder || undefined,
        artifact_group: item.group,
        artifact_flavor: item.flavor,
        artifact_id: item.artifact,
      });
      results.push({ item, ok: true, tool, bytes: payload.length, tookMs: Date.now() - itStart, result });
    } catch (e) {
      results.push({ item, ok: false, error: e.message, tookMs: Date.now() - itStart });
    }
  }
  const totalMs = Date.now() - t0;
  const okCount = results.filter(r => r.ok).length;
  const failCount = results.length - okCount;
  process.stderr.write(`[deploy-bulk]   done in ${totalMs}ms: ${okCount} ok / ${failCount} failed\n`);
  res.status(failCount > 0 && okCount === 0 ? 502 : 200).json({
    ok: failCount === 0,
    results,
    summary: { total: results.length, ok: okCount, failed: failCount },
    targetProduct: product,
    targetVersion: version,
    targetFolder: folder || null,
    env,
    tookMs: totalMs,
  });
});

app.post('/api/packs/:id/deploy/:target', async (req, res) => {
  const meta = findPackMeta(req.params.id);
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
    const canonical = loadPackCanonical(meta);
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
  const meta = findPackMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: `unknown pack: ${req.params.id}` });
  try {
    const canonical = loadPackCanonical(meta);
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

// Phase 7q archived the bundled packs to examples/; the cron-driven
// refresh-live-pack workflow writes there too. Keep this aligned so the
// live-status badge actually finds the file.
const LIVE_PACK_PATH = 'examples/production-live.pack.yaml';

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

// ----------------------------------------------------------------
// POST /api/draft-from-mcp — Path B of the pack-creation journey.
//
// Parallel to POST /api/crawl, but the source is a live MCP server
// instead of a repo file map. Builds a canonical v1.2 pack from what
// the MCP can attest to (system_health, system_topology, baselines,
// active anomalies) and returns it for review WITHOUT writing it to
// disk. The studio shows the preview + summary; "use this pack"
// round-trips it through /api/validate just like the crawler flow.
//
// Body: { mcpUrl, mcpAuth?, packName? }
// Response: { ok, canonical, canonicalYaml, summary, validation,
//             conformance, annotations, tookMs }
// ----------------------------------------------------------------
app.post('/api/draft-from-mcp', async (req, res) => {
  const body = req.body || {};
  const mcpUrl  = typeof body.mcpUrl  === 'string' && body.mcpUrl.trim() ? body.mcpUrl.trim() : null;
  const mcpAuth = typeof body.mcpAuth === 'string' && body.mcpAuth ? body.mcpAuth : null;
  const packName = typeof body.packName === 'string' && body.packName.trim()
    ? body.packName.trim()
    : null;
  if (!mcpUrl) return res.status(400).json({ ok: false, error: 'mcpUrl required in JSON body' });

  const t0 = Date.now();
  try {
    process.stderr.write(`[draft-from-mcp] POST -> ${mcpUrl}\n`);
    const fetched = await fetchMcp({ mcpUrl, mcpAuth });
    const refreshedAt = new Date().toISOString();
    const pack = buildCanonicalPack({ refreshedAt, mcpUrl, packName, ...fetched });
    const errors = validateCanonical(pack, SCHEMA);

    // Build a discovery summary in the same shape the crawler returns,
    // so the client can render BOTH path A and path B drafts with the
    // same review component.
    const ann = pack.metadata?.annotations || {};
    const probesAttempted = (ann['mcp.probesAttempted'] || '').split(',').filter(Boolean);
    const probesSucceeded = (ann['mcp.probesSucceeded'] || '').split(',').filter(Boolean);

    // Parse the capability inventory (skill → backend → product → versions)
    // out of the flat annotation set the fetcher stamped. The studio's
    // connect screen reads this directly to render the version-gating
    // story up-front, before the user even commits to drafting a pack.
    const inventoryRaw = ann['mcp.capabilities.inventory'] || '';
    const inventory = inventoryRaw.split('|').filter(Boolean).map(row => {
      const [skill, backend, product, mustCsv] = row.split(':');
      return {
        skill, backend,
        product: product === '-' ? null : product,
        versions: { must: (mustCsv || '').split(';').filter(Boolean) },
      };
    });
    const capabilities = ann['mcp.capabilities.skillCount']
      ? {
          gatingMode:    ann['mcp.capabilities.gatingMode'] || 'warn',
          protocolModel: ann['mcp.capabilities.protocolModel'] || null,
          skillCount:    Number(ann['mcp.capabilities.skillCount'] || 0),
          backendCount:  Number(ann['mcp.capabilities.backendCount'] || 0),
          skills:        (ann['mcp.capabilities.skills'] || '').split(',').filter(Boolean),
          inventory,
        }
      : null;

    const summary = {
      source: 'mcp',
      mcpUrl,
      refreshedAt,
      discovered: {
        backends:        (pack.spec?.telemetry?.backends || []).length,
        servicesDiscovered: (ann['mcp.servicesDiscovered'] || '').split(',').filter(Boolean),
        toolsCalled:    (ann['mcp.toolsCalled']    || '').split(',').filter(Boolean),
        toolsFailed:    (ann['mcp.toolsFailed']    || '').split(',').filter(Boolean),
        activeAnomalies: Number(ann['mcp.activeAnomalies'] || 0),
        // Probe-discovered facts — counts only, full data lives in the
        // pack itself (spec.queries.recording_rules etc.)
        recordingRules:  Number(ann['mcp.discovered.recording_rules'] || (pack.spec?.queries?.recording_rules || []).length),
        alertRules:      Number(ann['mcp.discovered.alert_rules'] || 0),
        dashboards:      Number(ann['mcp.discovered.dashboards'] || (pack.spec?.dashboards || []).length),
        scrapeJobs:     (ann['mcp.discovered.scrape_jobs'] || '').split(',').filter(Boolean),
        metricNamesCount: Number(ann['mcp.discovered.metric_names_count'] || 0),
        // tools/list inventory — what the MCP advertised vs what we matched
        toolsExposed:    (ann['mcp.toolsExposed']    || '').split(',').filter(Boolean),
        toolsUnmatched:  (ann['mcp.toolsUnmatched']  || '').split(',').filter(Boolean),
        probesAttempted, probesSucceeded,
      },
      // Full backend_capabilities inventory — the version-gating contract.
      // When null, the MCP didn't expose backend_capabilities (older
      // server). When set, the studio renders the full skill → backend →
      // product → version matrix on connect.
      capabilities,
      warnings: [],
      tier: pack.metadata?.bindings?.criticality || 'tier-3',
    };

    // Warnings — only flag a gap when we ASKED and got nothing, never
    // when we never asked. The MCP probe table is the contract for
    // "what we tried."
    if ((summary.discovered.toolsFailed || []).length) {
      summary.warnings.push(`MCP tools that failed: ${summary.discovered.toolsFailed.join(', ')}`);
    }
    const attemptedNothing = (k) => probesAttempted.includes(k) && !probesSucceeded.includes(k);
    if (attemptedNothing('recording_rules')) {
      summary.warnings.push('Recording-rule probes returned empty. The SLI/SLO sections were synthesised from system_health — if your platform has Prometheus/Mimir rules, the MCP isn\'t exposing them yet.');
    }
    if (attemptedNothing('alert_rules')) {
      summary.warnings.push('Alert-rule probes returned empty. Burn-rate alerts are synthesized from SLOs; existing fired alerts couldn\'t be surfaced.');
    }
    if (attemptedNothing('dashboards')) {
      summary.warnings.push('Dashboard probes returned empty. The dashboards section is a stub — point the MCP at Grafana\'s /api/search to populate it.');
    }
    if (attemptedNothing('scrape_configs')) {
      summary.warnings.push('Scrape-config probes returned empty. spec.telemetry.scrape_evidence is unknown — declare scrape jobs in the pack by hand if you can.');
    }
    if (attemptedNothing('metric_names')) {
      summary.warnings.push('Metric-inventory probes returned empty. The metrics actually exported by the platform couldn\'t be enumerated.');
    }
    // Hard guards regardless of probes (the live state has to satisfy SOMETHING).
    if ((pack.spec?.slis || []).length === 0) {
      summary.warnings.push('No SLIs at all — recording rules + system_health both came up empty.');
    }

    const conformance = evaluateConformance(pack);
    const canonicalYaml = banner(pack) + emitYaml(pack);
    // Register only if validation passes; bad packs aren't addressable.
    const registered = errors.length === 0
      ? { id: registerUploadedPack(pack, `${pack.metadata?.name || 'mcp-draft'} (live draft)`) }
      : null;
    process.stderr.write(`[draft-from-mcp]   ok in ${Date.now() - t0}ms; ` +
      `valid=${errors.length === 0}; ` +
      `services=${summary.discovered.backends}; ` +
      `registered=${registered?.id || '-'}; ` +
      `failed=${summary.discovered.toolsFailed.join(',') || 'none'}\n`);

    res.json({
      ok: true,
      canonical: pack,
      canonicalYaml,
      summary,
      annotations: ann,
      validation: { ok: errors.length === 0, errors },
      conformance,
      registered,
      tookMs: Date.now() - t0,
    });
  } catch (e) {
    process.stderr.write(`[draft-from-mcp]   error in ${Date.now() - t0}ms: ${e.message}\n`);
    res.status(502).json({ ok: false, error: e.message, tookMs: Date.now() - t0 });
  }
});

function banner(pack) {
  return [
    `# =============================================================================`,
    `# ObservabilityPack: ${pack.metadata?.name || 'unnamed'}  (drafted from live MCP)`,
    `# Source         : ${pack.metadata?.annotations?.['mcp.url'] || 'unknown'}`,
    `# Drafted at     : ${pack.metadata?.annotations?.['mcp.refreshedAt'] || new Date().toISOString()}`,
    `# Tools called   : ${pack.metadata?.annotations?.['mcp.toolsCalled']    || '(none)'}`,
    `# Tools failed   : ${pack.metadata?.annotations?.['mcp.toolsFailed']    || 'none'}`,
    `# Services found : ${pack.metadata?.annotations?.['mcp.servicesDiscovered'] || 0}`,
    `# -----------------------------------------------------------------------------`,
    `# This is a DRAFT. The MCP can attest to what's live (backends, topology,`,
    `# baselines, active anomalies). It CANNOT supply your declared SLIs/SLOs,`,
    `# dashboards, policy, or remediation — those belong in the pack you author or`,
    `# crawl from the repo. Merge this draft with a repo-derived draft to get a`,
    `# tier-2-complete pack.`,
    `# =============================================================================`,
    '',
  ].join('\n');
}

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
    // Register the crawled canonical only if it validates. Bad packs
    // shouldn't pollute the catalog under an addressable id.
    const registered = validationErrors.length === 0
      ? { id: registerUploadedPack(canonical, `${opts.repoName || canonical.metadata?.name || 'crawl'} (crawled)`) }
      : null;
    process.stderr.write(`[crawl] ${entries.length} files, ${summary.files.classified} classified, ${Object.keys(evidence).length} evidence, tier=${summary.inferred.tier}, valid=${validationErrors.length === 0}, registered=${registered?.id || '-'}, ${Date.now() - t0}ms\n`);
    res.json({
      ok: true,
      canonical,
      canonicalYaml: yaml,
      summary,
      evidence,
      validation: { ok: validationErrors.length === 0, errors: validationErrors },
      conformance,
      registered,
      tookMs: Date.now() - t0,
    });
  } catch (e) {
    process.stderr.write(`[crawl] error: ${e.message}\n`);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ----------------------------------------------------------------
// POST /api/crawl-github — Path A extension. Same crawler, different
// source: a public GitHub repo URL instead of an uploaded folder.
//
// The server fetches the repo's file tree via the GitHub Tree API,
// downloads just the files the crawler cares about (docker-compose,
// Prometheus rules, OTel configs, dashboards), and feeds them into
// the same crawlFiles() pipeline as /api/crawl. Returns the same
// response shape.
//
// Body: {
//   url:         'https://github.com/owner/repo' | 'owner/repo',
//   ref?:        'main' | 'develop' | <sha>,   // default: repo default branch
//   environment?, criticality?, binding?, owners?  // same as /api/crawl
// }
//
// Auth: respects GITHUB_TOKEN env var for higher rate limits + private
// repos. Without it: public-only, 60 req/hr per IP.
//
// Bandwidth guards: max 50 files, max 16 MB total, max 1 MB per file.
// ----------------------------------------------------------------
function parseGithubUrl(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  const cleaned = input.trim().replace(/\.git$/, '').replace(/\/$/, '');
  // owner/repo bare form
  const bare = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(cleaned);
  if (bare) return { owner: bare[1], repo: bare[2] };
  // Full URL form
  const url = /github\.com[/:]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)(?:\/tree\/([A-Za-z0-9._\/-]+))?/.exec(cleaned);
  if (url) return { owner: url[1], repo: url[2], ref: url[3] };
  return null;
}

// Files the crawler will actually look at — keep the network round
// trips down by filtering BEFORE downloading.
function isCrawlerFile(path) {
  if (typeof path !== 'string') return false;
  const p = path.toLowerCase();
  if (p.includes('node_modules/') || p.includes('.git/') || p.startsWith('.git/')) return false;
  return (
    /(^|\/)docker[-_]compose[a-z0-9._-]*\.(ya?ml)$/.test(p) ||
    /(^|\/)compose[a-z0-9._-]*\.(ya?ml)$/.test(p) ||
    /\.rules\.(ya?ml)$/.test(p) ||
    /(^|\/)prometheus[a-z0-9._-]*\.(ya?ml)$/.test(p) ||
    /(^|\/)alertmanager[a-z0-9._-]*\.(ya?ml)$/.test(p) ||
    /(^|\/)otel[a-z0-9._-]*config[a-z0-9._-]*\.(ya?ml)$/.test(p) ||
    /(^|\/)otelcol[a-z0-9._-]*\.(ya?ml)$/.test(p) ||
    /(^|\/)collector[a-z0-9._-]*\.(ya?ml)$/.test(p) ||
    /(^|\/)dashboards?\/.*\.json$/.test(p) ||
    /(^|\/)grafana\/.*\.json$/.test(p) ||
    /\.dashboard\.json$/.test(p) ||
    /(^|\/)kustomization\.(ya?ml)$/.test(p)
  );
}

async function ghFetch(path, init = {}) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'tomograph-crawler/1.0',
    ...(init.headers || {}),
  };
  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetch(`https://api.github.com${path}`, { ...init, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`GitHub ${res.status} on ${path}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

app.post('/api/crawl-github', async (req, res) => {
  const body = req.body || {};
  const parsed = parseGithubUrl(body.url);
  if (!parsed) {
    return res.status(400).json({
      ok: false,
      error: 'expected `url` like https://github.com/owner/repo or owner/repo',
    });
  }
  const { owner, repo } = parsed;
  const explicitRef = (typeof body.ref === 'string' && body.ref.trim()) ? body.ref.trim() : parsed.ref || null;
  const t0 = Date.now();

  try {
    // 1. Resolve default branch when no ref given.
    let ref = explicitRef;
    if (!ref) {
      const repoMeta = await ghFetch(`/repos/${owner}/${repo}`).then(r => r.json());
      ref = repoMeta.default_branch || 'main';
    }

    // 2. List the full tree at that ref.
    const treeResp = await ghFetch(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`)
      .then(r => r.json());
    if (treeResp.truncated) {
      process.stderr.write(`[crawl-github] tree truncated for ${owner}/${repo}@${ref}; some files may be missing\n`);
    }

    // 3. Filter to crawler-relevant blobs.
    const FILE_CAP_BYTES = 1 * 1024 * 1024;        // 1 MB / file
    const TOTAL_CAP_BYTES = 16 * 1024 * 1024;      // 16 MB total
    const MAX_FILES = 50;
    const candidates = (treeResp.tree || [])
      .filter(node => node.type === 'blob' && isCrawlerFile(node.path))
      .filter(node => !node.size || node.size <= FILE_CAP_BYTES)
      .slice(0, MAX_FILES);

    if (candidates.length === 0) {
      return res.json({
        ok: true,
        canonical: null,
        canonicalYaml: '',
        summary: { source: 'github', repo: `${owner}/${repo}`, ref, files: { total: 0, classified: 0 } },
        validation: { ok: false, errors: ['no crawler-relevant files found in repo'] },
        registered: null,
        tookMs: Date.now() - t0,
        notes: ['Repo had no docker-compose, prometheus rules, otel collector configs, alertmanager configs, or Grafana dashboards.'],
      });
    }

    // 4. Download contents in parallel (raw content endpoint).
    let totalBytes = 0;
    const files = {};
    const skipped = [];
    await Promise.all(candidates.map(async (node) => {
      try {
        const contentRes = await ghFetch(`/repos/${owner}/${repo}/contents/${encodeURIComponent(node.path).replace(/%2F/g, '/')}?ref=${encodeURIComponent(ref)}`, {
          headers: { Accept: 'application/vnd.github.raw+json' },
        });
        const text = await contentRes.text();
        if (text.length > FILE_CAP_BYTES) { skipped.push(`${node.path} (size ${text.length})`); return; }
        if (totalBytes + text.length > TOTAL_CAP_BYTES) { skipped.push(`${node.path} (total cap)`); return; }
        files[node.path] = text;
        totalBytes += text.length;
      } catch (e) {
        skipped.push(`${node.path} (${e.message})`);
      }
    }));

    if (Object.keys(files).length === 0) {
      return res.json({
        ok: true, canonical: null, canonicalYaml: '',
        summary: { source: 'github', repo: `${owner}/${repo}`, ref, files: { total: candidates.length, classified: 0 } },
        validation: { ok: false, errors: ['all candidate files were skipped (size caps or download errors)'] },
        registered: null, tookMs: Date.now() - t0, notes: skipped,
      });
    }

    // 5. Run the SAME crawler the upload path uses.
    // Default the repoName to a Slug-pattern-compliant variant of the
    // repo path (owner-repo, lowercase, slashes → hyphens, dots
    // collapsed) so the canonical pack's metadata.name validates against
    // the spec's `^[a-z][a-z0-9_-]*[a-z0-9]$` pattern.
    const defaultRepoName = `${owner}-${repo}`
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
    const opts = {
      repoName: typeof body.repoName === 'string' && body.repoName.trim()
        ? body.repoName.trim() : defaultRepoName,
      environment: typeof body.environment === 'string' ? body.environment : undefined,
      criticality: typeof body.criticality === 'string' ? body.criticality : undefined,
      binding: typeof body.binding === 'string' ? body.binding : undefined,
      owners: Array.isArray(body.owners) ? body.owners.map(String) : undefined,
    };
    const { yaml, summary, evidence } = crawlToYaml(files, opts);
    const { canonical } = crawlFiles(files, opts);
    const validationErrors = validateCanonical(canonical, SCHEMA);
    const conformance = evaluateConformance(canonical);
    const registered = validationErrors.length === 0
      ? { id: registerUploadedPack(canonical, `${opts.repoName} (github)`) }
      : null;

    summary.source = 'github';
    summary.repo   = `${owner}/${repo}`;
    summary.ref    = ref;
    if (skipped.length) summary.skipped = skipped;

    process.stderr.write(`[crawl-github] ${owner}/${repo}@${ref} → ${Object.keys(files).length} files, ${summary.files.classified} classified, valid=${validationErrors.length === 0}, registered=${registered?.id || '-'}, ${Date.now() - t0}ms\n`);
    res.json({
      ok: true,
      canonical,
      canonicalYaml: yaml,
      summary,
      evidence,
      validation: { ok: validationErrors.length === 0, errors: validationErrors },
      conformance,
      registered,
      tookMs: Date.now() - t0,
    });
  } catch (e) {
    process.stderr.write(`[crawl-github] error: ${e.message}\n`);
    const status = e.status === 404 ? 404 : (e.status === 403 ? 403 : 500);
    res.status(status).json({
      ok: false,
      error: e.message,
      hint: e.status === 403
        ? 'GitHub rate limit. Set GITHUB_TOKEN in the server env for higher quotas.'
        : e.status === 404 ? 'Repo not found or private. Set GITHUB_TOKEN to access private repos.' : undefined,
    });
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
    // Register the canonical so the rest of the API can refer to it by
    // id. The client uses `registered.id` as the new state.selectedPackId
    // — that unlocks per-artefact Compile, Deploy, Conformance, diff
    // against this pack as Pack A or Pack B, etc. ?source= lets the
    // client describe where the pack came from (file name, crawl target,
    // mcp URL); falls back to the canonical's metadata.name.
    const sourceHint = typeof req.query.source === 'string' && req.query.source ? req.query.source : null;
    const id = registerUploadedPack(canonical, sourceHint || canonical.metadata?.name || 'upload');
    res.json({ ok: true, adapted, conformance, registered: { id, source: sourceHint || null } });
  } catch (e) {
    res.status(400).json({ ok: false, errors: [e.message] });
  }
});

// Static studio shell + assets.
// Expose the shared crawler + YAML libraries so the browser can do
// client-side artefact detection (filtering the staged file map BEFORE
// posting to /api/crawl). Single source of truth — same module the
// CLI and the server use.
app.use('/lib', express.static(resolve(ROOT, 'tools/lib'), {
  extensions: ['mjs', 'js'],
  setHeaders: (res) => {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.use(express.static(STUDIO_DIR, { extensions: ['html'], index: 'index.html' }));

// SPA-style fallback: any unknown GET returns the studio shell so the client
// can route. The /api/* paths above already handled JSON requests.
app.get(/^(?!\/api\/).*/, (req, res, next) => {
  if (req.method !== 'GET') return next();
  res.sendFile(resolve(STUDIO_DIR, 'index.html'));
});

// ---------- entrypoint ----------

const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '0.0.0.0';

export { app };
export function start({ port = PORT, host = HOST, silent = false } = {}) {
  return new Promise((resolveListen, reject) => {
    const srv = app.listen(port, host, () => {
      // When bind fails the listening callback can still fire with the
      // address being null (race between EADDRINUSE and 'listening').
      // Bail here so the error handler below resolves the promise; the
      // call site will format a friendly message.
      const addr = srv.address();
      if (!addr) return;
      if (!silent) process.stdout.write(`[studio] listening on http://${addr.address}:${addr.port}\n`);
      resolveListen(srv);
    });
    srv.on('error', reject);
  });
}

const invokedDirectly = resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  start().catch(e => {
    // EADDRINUSE is the common case — give a clear, actionable hint
    // instead of a generic stack trace.
    if (e && e.code === 'EADDRINUSE') {
      process.stderr.write(
        `[studio] port ${PORT} is already in use.\n` +
        `         Another Tomograph instance is probably running. Stop it, or:\n` +
        `           PORT=8001 npm run dev\n`
      );
    } else {
      process.stderr.write(`[studio] failed to start: ${e.message}\n`);
    }
    process.exit(1);
  });
}
