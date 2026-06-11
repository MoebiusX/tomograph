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
import { resolve, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
import { parse as parseYaml, emit as emitYaml } from '../tools/lib/mini-yaml.mjs';
import { adapt, listEnvironments, applyEnvironmentOverlay } from '../tools/lib/adapter.mjs';
import { validateCanonical, SPEC_VERSION } from '../tools/lib/validator.mjs';
import { evaluateConformance, RUBRIC } from '../tools/lib/conformance.mjs';
import { crawlFiles, crawlToYaml } from '../tools/lib/crawler.mjs';
import { fetchMcp, buildCanonicalPack, createMcpClient } from '../tools/fetch-live-pack.mjs';
import { diffPacks } from '../tools/lib/diff.mjs';
import { comparePackBranches } from '../tools/lib/traceability-graph.mjs';
import { compile, listTargets, compileCatalog, compileArtifact } from '../tools/lib/compile.mjs';
import { makeZip } from '../tools/lib/zip.mjs';
import {
  saveWorkspacePack, deleteWorkspacePack, touchWorkspacePack,
  loadWorkspacePacks, clearWorkspacePacks,
  appendDeployRecord, appendDeployVerify, readDeployRecords,
  saveDeploySnapshot, readDeploySnapshot, workspaceInfo,
} from './workspace.mjs';
import {
  listJourneys, loadJourneyDef, runJourney, readJourneyRuns, saveJourneyDef,
} from '../tools/lib/journey.mjs';
import { retrofeedShadowSignals } from '../tools/lib/retrofeed.mjs';
import { initAuth, authEnabled, readSession } from './auth.mjs';

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
// Labels intentionally omit the tier — it renders as a separate badge
// in the picker, so duplicating it in the name reads as noise.
const EXAMPLE_PACKS = [
  {
    id: 'payment-service',
    label: 'Payment service (canonical example)',
    path: 'vendor/observability-pack-spec/v1.2/examples/payment-service.pack.yaml',
    description: "The spec repo's reference tier-1 pack — HTTP API + Kafka consumer.",
  },
  {
    id: 'target-advanced',
    label: 'Target advanced (aspirational reference)',
    path: 'examples/target-advanced.pack.yaml',
    description: 'Aspirational tier-1 — 100% MUST conformance, all 5 SHOULDs pass.',
  },
  {
    id: 'production-curated',
    label: 'Production curated (hand-authored baseline)',
    path: 'examples/production-curated.pack.yaml',
    description: 'Hand-curated baseline with intentional gaps the conformance panel surfaces.',
  },
];

// Catalogue reference packs — the curated, evidence-cited "state of the
// art" packs for well-known observability components (Kafka, Prometheus,
// Grafana). These are NOT example packs: they live under reference-packs/
// and are surfaced through the studio's Advanced → References view (the
// reference component analysis), where the user benchmarks their own pack
// against best practice. Browsed via GET /api/references; loaded as Pack B
// via /api/packs/:id. Keep in sync with LENS_PRODUCTS in studio/app.mjs.
const REFERENCE_PACKS = [
  {
    id: 'kafka-reference',
    label: 'Kafka (catalogue reference)',
    path: 'reference-packs/kafka.pack.yaml',
    description: 'State-of-the-art reference pack for Apache Kafka 3.x. Five operational vital signs, multi-window burn-rate alerts, 4 chaos experiments. Every section evidence-cited in docs/catalogue-evidence/kafka.md.',
    catalogue: true,
  },
  {
    id: 'prometheus-reference',
    label: 'Prometheus (catalogue reference)',
    path: 'reference-packs/prometheus.pack.yaml',
    description: 'State-of-the-art reference pack for Prometheus 2.45+ self-monitoring (via Meta-Prometheus pattern). Eight operational vital signs, 4 chaos experiments. Every section evidence-cited in docs/catalogue-evidence/prometheus.md.',
    catalogue: true,
  },
  {
    id: 'grafana-reference',
    label: 'Grafana (catalogue reference)',
    path: 'reference-packs/grafana.pack.yaml',
    description: 'State-of-the-art reference pack for Grafana 11.x including unified alerting. Eight operational vital signs (HTTP, datasource proxy, database, alerting evaluation, plugins, login), 4 chaos experiments, 3-layer synthetic checks. Paired with the Prometheus reference pack. Every section evidence-cited in docs/catalogue-evidence/grafana.md.',
    catalogue: true,
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
// Backed by the .tomograph/ workspace (server/workspace.mjs): every
// registration writes through to disk and start() rehydrates the map, so
// crawled / drafted / uploaded packs survive restarts. Eviction at the cap
// prunes both the map and the disk copy (retention by least-recently-used).
const UPLOADED_PACKS = new Map();   // id → { canonical, source, createdAt }
const MAX_UPLOADS = 200;

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

function registerUploadedPack(canonical, source, label) {
  const slug = slugify(canonical?.metadata?.name || source || 'pack');
  const id = `uploaded-${slug}-${contentHash(canonical)}`;
  // Idempotent: if the same canonical content was already registered,
  // delete + re-insert refreshes its LRU position without minting a new
  // id. That makes re-upload safe (no duplicate entries) AND keeps the
  // user's pick alive when they're actively working with that pack.
  if (UPLOADED_PACKS.has(id)) UPLOADED_PACKS.delete(id);
  // ALSO drop any older entry whose friendly label collides with the
  // new one. This is how the quick-start cases stay deduplicated:
  // a second "KrystalineX (repo scan)" replaces the first instead of
  // accumulating clones in the picker.
  if (label) {
    for (const [otherId, rec] of [...UPLOADED_PACKS.entries()]) {
      if (rec.label === label && otherId !== id) {
        UPLOADED_PACKS.delete(otherId);
        deleteWorkspacePack(otherId);
      }
    }
  }
  const rec = { canonical, source: source || 'upload', label, createdAt: Date.now() };
  UPLOADED_PACKS.set(id, rec);
  saveWorkspacePack(id, rec);
  // Evict the oldest if we've blown the cap — disk copy goes with it.
  while (UPLOADED_PACKS.size > MAX_UPLOADS) {
    const oldestKey = UPLOADED_PACKS.keys().next().value;
    UPLOADED_PACKS.delete(oldestKey);
    deleteWorkspacePack(oldestKey);
  }
  return id;
}

function uploadedMeta(id) {
  const upl = UPLOADED_PACKS.get(id);
  if (!upl) return null;
  touchWorkspacePack(id);   // keeps lastUsedAt-based retention honest (debounced)
  return {
    id,
    path: null,        // signal: not file-backed
    canonical: upl.canonical,
    // Prefer the explicit friendly label when present, fall back to
    // the canonical pack name. This is what the picker dropdown reads.
    label: upl.label || upl.canonical?.metadata?.name || id,
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
    const svc = serviceMetadata(c);
    return {
      id: meta.id,
      label: meta.label,
      description: meta.description,
      name: c.metadata?.name,
      version: c.metadata?.version,
      binding: c.metadata?.binding,
      criticality: c.metadata?.bindings?.criticality,
      service: svc.service,
      namespace: svc.namespace,
      services: svc.services,
      environments: listEnvironments(c),
      ok: true,
    };
  } catch (e) {
    return { id: meta.id, label: meta.label, ok: false, error: e.message };
  }
}

function serviceMetadata(canonical) {
  const bindings = canonical?.metadata?.bindings || {};
  const annotations = canonical?.metadata?.annotations || {};
  const services = new Set();
  const add = (value) => {
    for (const part of String(value || '').split(',')) {
      const service = part.trim();
      if (service) services.add(service);
    }
  };
  add(bindings.service);
  add(bindings.namespace);
  add(annotations['mcp.servicesDiscovered']);
  add(annotations['tomograph.services']);
  return {
    service: bindings.service || canonical?.metadata?.name || '',
    namespace: bindings.namespace || bindings.service || canonical?.metadata?.name || '',
    services: [...services].sort(),
  };
}

function readEnv(query) {
  return typeof query.env === 'string' && query.env ? query.env : null;
}

// ---------- MCP URL validation (SSRF guard) ----------
//
// Every deploy / draft / refresh endpoint fetches a caller-supplied mcpUrl
// server-side, which is a server-side request forgery vector if the URL is
// taken on faith. validateMcpUrl() is the single gate:
//   - only http(s) is accepted (no file:, ftp:, gopher:, ...);
//   - localhost / private / link-local addresses are allowed by default
//     (a local MCP server is the normal dev setup) but logged per use;
//     set TOMOGRAPH_ALLOW_LOCAL_MCP=0 to turn them into 400s when the
//     studio is exposed beyond the developer's own machine;
//   - the returned safeUrl has credentials stripped — stderr logs must use
//     it (or redactCredentials), never the raw URL.
// Hostnames that RESOLVE to private addresses are not caught (no DNS
// lookup here); the literal-IP check covers hex/decimal/octal IPv4 forms
// because the WHATWG URL parser normalises those to dotted-decimal.

const PRIVATE_V4 = [
  /^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^0\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];

function isLocalOrPrivateHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (PRIVATE_V4.some(re => re.test(host))) return true;
  // IPv6: loopback/unspecified, unique-local fc00::/7, link-local fe80::/10,
  // and IPv4-mapped forms of any of the above.
  if (host === '::1' || host === '::') return true;
  if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return true;
  if (host.startsWith('::ffff:')) return isLocalOrPrivateHost(host.slice(7));
  return false;
}

function redactCredentials(text) {
  return String(text).replace(/\/\/[^/\s@]+@/g, '//***@');
}

// Returns { safeUrl } when the URL is fetchable, { error } when it must be
// rejected with a 400. safeUrl is the parsed URL with credentials removed.
function validateMcpUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { error: `mcpUrl is not a valid URL: ${redactCredentials(raw)}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: `mcpUrl must be http or https; got scheme '${url.protocol.replace(/:$/, '')}'` };
  }
  url.username = '';
  url.password = '';
  const safeUrl = url.href;
  if (isLocalOrPrivateHost(url.hostname)) {
    if (process.env.TOMOGRAPH_ALLOW_LOCAL_MCP === '0') {
      return { error: `mcpUrl targets a local/private address (${url.hostname}), which TOMOGRAPH_ALLOW_LOCAL_MCP=0 forbids` };
    }
    process.stderr.write(`[mcp-url] note: ${safeUrl} targets a local/private address; set TOMOGRAPH_ALLOW_LOCAL_MCP=0 to refuse these\n`);
  }
  return { safeUrl };
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

// ---------- write-route auth (VALUE_BACKLOG item 10B) ----------
//
// One token, three postures:
//   1. Local (default): loopback bind, no token, no auth — zero friction.
//   2. Exposed + TOMOGRAPH_API_TOKEN set: mutating /api/* routes require
//      `Authorization: Bearer <token>`. Reads stay open. Once a token is
//      set it is enforced regardless of bind address — a reverse proxy
//      makes everything look local, so a loopback bypass would undermine
//      the token exactly when it matters.
//   3. Exposed + no token: the server REFUSES TO START (fail closed; see
//      start()). TOMOGRAPH_INSECURE_NO_AUTH=1 is the explicit, loudly
//      logged override for trusted-network demos.
// MCP write tokens are unrelated and never stored here — they pass
// through per request. The audit log records the token's ownership label
// (TOMOGRAPH_API_TOKEN_LABEL), never the secret.

function apiToken() { return (process.env.TOMOGRAPH_API_TOKEN || '').trim(); }
function apiTokenLabel() { return (process.env.TOMOGRAPH_API_TOKEN_LABEL || '').trim() || 'token'; }

function tokenEquals(candidate, token) {
  // Constant-time compare over digests so length differences leak nothing.
  const a = createHash('sha256').update(String(candidate)).digest();
  const b = createHash('sha256').update(String(token)).digest();
  return timingSafeEqual(a, b);
}

// Who performed a mutating request — the audit log's actor field.
function actorForRequest(req) { return req?.tomographActor || 'local'; }

app.use((req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();   // the login flow itself
  const token = apiToken();
  const identity = authEnabled();                     // OIDC or stand-alone users
  if (!token && !identity) return next();             // posture 1/3 — local, no friction
  const isApi = req.path.startsWith('/api/');
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);

  // Bearer token: the service-account / CI path — works in every posture.
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (m && token && tokenEquals(m[1].trim(), token)) {
    req.tomographActor = apiTokenLabel();
    return next();
  }

  if (identity) {
    const session = readSession(req);
    if (session) {
      // Cookie-authenticated mutations require the custom header —
      // cross-origin pages can't set one without a CORS preflight, so
      // SameSite=Lax + this check closes the CSRF window.
      if (mutating && isApi && req.headers['x-tomograph-csrf'] !== '1') {
        return res.status(403).json({ ok: false, error: 'missing X-Tomograph-CSRF header on a session-authenticated mutation' });
      }
      req.tomographActor = session.email || session.sub;
      return next();
    }
    // Identity mode protects ALL /api data (reads included) — "your
    // services" is enforced server-side. The static studio shell stays
    // open so the client can land and redirect to the login page.
    if (isApi) {
      return res.status(401).json({ ok: false, error: 'unauthorized: sign in required', login: '/auth/login' });
    }
    return next();
  }

  // Token-only posture (no identity configured): original 10B contract —
  // mutating /api routes require the bearer, reads stay open.
  if (!mutating || !isApi) return next();
  res.set('WWW-Authenticate', 'Bearer realm="tomograph"');
  return res.status(401).json({
    ok: false,
    error: 'unauthorized: mutating /api routes require `Authorization: Bearer <TOMOGRAPH_API_TOKEN>`',
  });
});

app.use(express.json({ limit: '16mb' }));   // /api/crawl can carry a whole repo's worth of YAML
app.use(express.text({ type: ['application/x-yaml', 'text/yaml', 'text/plain'], limit: '4mb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));   // /auth/login form

// Identity routes (/auth/*) — inert in local mode; throws fail-closed at
// boot when OIDC is configured incompletely. See server/auth.mjs.
initAuth(app);

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
  clearWorkspacePacks();   // reset means reset — the disk copies go too
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
  const svc = serviceMetadata(c);
  return {
    id,
    label: meta.label,
    description: meta.description,
    name: c?.metadata?.name,
    version: c?.metadata?.version,
    binding: c?.metadata?.binding,
    criticality: c?.metadata?.bindings?.criticality,
    service: svc.service,
    namespace: svc.namespace,
    services: svc.services,
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
      || EXAMPLE_PACKS.find(p => p.id === id)
      || REFERENCE_PACKS.find(p => p.id === id);
}

// Browse the archived reference packs without auto-loading them. The
// home screen renders these as a small "Browse examples" affordance.
app.get('/api/examples', (req, res) => {
  res.json({ examples: EXAMPLE_PACKS.map(catalogEntry) });
});

// Catalogue reference packs — the curated best-practice packs surfaced in
// the studio's Advanced → References view (reference component analysis).
// Kept separate from /api/examples so they no longer appear in the
// example-pack list, only under References.
app.get('/api/references', (req, res) => {
  res.json({ references: REFERENCE_PACKS.map(catalogEntry) });
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
    // Allow ?format=yaml to return the manifest as text/yaml for the
    // Schema view's canonical-source pane (saves a round-trip + an
    // ESM YAML emitter on the client).
    if (req.query.format === 'yaml' || req.query.format === 'yml') {
      res.set('Content-Type', 'application/x-yaml; charset=utf-8');
      res.send(emitYaml(overlaid));
      return;
    }
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
  const requestedScopeMode = typeof req.query.scopeMode === 'string' ? req.query.scopeMode : undefined;
  const requestedService = typeof req.query.service === 'string' && req.query.service ? req.query.service : undefined;
  try {
    const aCanonical = loadPackCanonical(aMeta);
    const bCanonical = loadPackCanonical(bMeta);
    const annotatedScopeMode = aCanonical.metadata?.annotations?.['tomograph.diff.scopeMode'];
    const scopeMode = requestedScopeMode || annotatedScopeMode;
    const aLayered = adapt(aCanonical, { environment: aEnv });
    const bLayered = adapt(bCanonical, { environment: bEnv });
    res.json({
      ...diffPacks(aLayered, bLayered, { scopeMode, service: requestedService }),
      traceabilityGraph: comparePackBranches(aLayered, bLayered),
    });
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

// GET /api/packs/:id/export.zip — the whole pack as one download: the
// canonical pack.yaml plus every compiled artefact (the 'all' bundle of each
// compile group × flavor) under artefacts/. Hand-rolled ZIP, no zip dep.
app.get('/api/packs/:id/export.zip', (req, res) => {
  const meta = findPackMeta(req.params.id);
  if (!meta) return res.status(404).json({ error: `unknown pack: ${req.params.id}` });
  try {
    const canonical = loadPackCanonical(meta);
    const env = readEnv(req.query);
    const { canonical: overlaid } = overlaidCanonical(canonical, env);
    const name = slugify(overlaid?.metadata?.name || meta.id || 'pack');

    // The source of truth first, then the compiled outputs beside it.
    const files = [{ name: `${name}.pack.yaml`, data: emitYaml(overlaid) }];

    const catalog = compileCatalog(overlaid);
    for (const g of catalog.groups || []) {
      const flavors = g.flavors?.length ? g.flavors : [{ id: undefined }];
      for (const fl of flavors) {
        try {
          const out = compileArtifact(overlaid, { group: g.id, flavor: fl.id, artifact: 'all' });
          files.push({ name: `artefacts/${g.id}/${out.filename}`, data: out.content });
        } catch (_) { /* a flavor that can't compile for this pack — skip it */ }
      }
    }

    const zip = makeZip(files);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.bundle.zip"`);
    res.setHeader('X-Pack-Source', `${meta.id}@${overlaid?.metadata?.version || '?'}`);
    res.setHeader('X-Bundle-Files', String(files.length));
    res.send(Buffer.from(zip));
  } catch (e) {
    res.status(500).json({ error: e.message });
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
const GRAFANA_ALERT_RULE_TOOL = 'grafana_create_alert_rule';
const GRAFANA_DASHBOARD_TOOL = 'grafana_create_dashboard';
const GRAFANA_FOLDER_DEFAULT = 'observability-pack';

// (product, target) → default MCP tool name. The server lets the client
// override via body.mcpTool; this dispatch supplies the convention.
function defaultDeployTool({ product, target, scope }) {
  if (product === 'grafana') {
    if (target === 'prometheus-rules') {
      return GRAFANA_ALERT_RULE_TOOL;
    }
    if (target === 'grafana-dashboard') return GRAFANA_DASHBOARD_TOOL;
  }
  return null;   // not deployable
}

async function discoverMcpToolNames(rpc) {
  try {
    const out = await rpc('tools/list');
    return (out?.tools || []).map(t => t?.name).filter(Boolean).sort();
  } catch (_) {
    return null;
  }
}

function deployToolMissingError(tool, availableTools) {
  const related = (availableTools || [])
    .filter(t => /apply|deploy|create|upsert|write|provision|grafana|rule|dashboard/i.test(t))
    .slice(0, 18);
  let hint = 'Configure a Grafana write-capable MCP gateway, or add a compatible deploy adapter before retrying.';
  if (tool === GRAFANA_ALERT_RULE_TOOL) {
    hint = 'For otel-mcp-server, set MCP_ENABLE_WRITES=true, configure GRAFANA_URL and GRAFANA_AUTH_TOKEN with alert.provisioning:write on the MCP server, and pass a valid MCP client key in Tomograph when MCP_AUTH_KEYS is configured.';
  } else if (tool === GRAFANA_DASHBOARD_TOOL) {
    hint = 'For otel-mcp-server, set MCP_ENABLE_WRITES=true, configure GRAFANA_URL and GRAFANA_AUTH_TOKEN with dashboards:write on the MCP server, and pass a valid MCP client key in Tomograph when MCP_AUTH_KEYS is configured.';
  }
  const suffix = related.length
    ? ` Advertised related tools: ${related.join(', ')}.`
    : ' No related write-capable tools were advertised.';
  return `MCP endpoint does not expose required deploy tool '${tool}'.${suffix} ${hint}`;
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

function scopeMatchesGrafanaRule(rule, scope) {
  if (!scope || scope === 'both') return true;
  const isRecording = !!rule?.record;
  return scope === 'recording' ? isRecording : !isRecording;
}

function normalizeGrafanaProvisioningRule(rule, group = {}, folder = '') {
  const out = { ...(rule || {}) };
  if (out.noDataState === undefined && out.no_data_state !== undefined) {
    out.noDataState = out.no_data_state;
    delete out.no_data_state;
  }
  if (out.execErrState === undefined && out.exec_err_state !== undefined) {
    out.execErrState = out.exec_err_state;
    delete out.exec_err_state;
  }
  if (out.isPaused === undefined && out.is_paused !== undefined) {
    out.isPaused = out.is_paused;
    delete out.is_paused;
  }
  if (out.folderUID === undefined) {
    out.folderUID = folder || group.folderUID || group.folderUid || group.folder || GRAFANA_FOLDER_DEFAULT;
  }
  if (out.ruleGroup === undefined) {
    out.ruleGroup = group.name || 'observability-pack';
  }
  return out;
}

function grafanaRulesFromProvisioningYaml(yamlText, { scope = 'both', folder = '' } = {}) {
  const obj = parseYaml(String(yamlText || '').replace(/^(\s*#[^\n]*\n)+/, ''));
  const groups = Array.isArray(obj?.groups) ? obj.groups : [];
  const rules = [];
  for (const group of groups) {
    for (const rule of (Array.isArray(group?.rules) ? group.rules : [])) {
      if (!scopeMatchesGrafanaRule(rule, scope)) continue;
      rules.push(normalizeGrafanaProvisioningRule(rule, group, folder));
    }
  }
  return rules;
}

function dashboardFromCompiledJson(jsonText) {
  const dashboard = JSON.parse(jsonText);
  if (!dashboard || typeof dashboard !== 'object' || Array.isArray(dashboard)) {
    throw new Error('compiled dashboard did not produce a Grafana dashboard object');
  }
  return dashboard;
}

function buildNativeDeployCalls({ target, compiled, scope, folder, tool, mode = 'upsert', dryRun = false, message }) {
  if (tool === GRAFANA_ALERT_RULE_TOOL) {
    const rules = grafanaRulesFromProvisioningYaml(compiled.content, { scope, folder });
    if (!rules.length) {
      throw new Error(`no Grafana-managed ${scope && scope !== 'both' ? scope + ' ' : ''}rules found in compiled artefact`);
    }
    return rules.map(rule => ({
      tool,
      args: { rule, mode, dry_run: dryRun },
      bytes: JSON.stringify(rule).length,
      name: rule.title || rule.uid || rule.record?.metric || 'rule',
      kind: rule.record ? 'recording' : 'alerting',
    }));
  }
  if (tool === GRAFANA_DASHBOARD_TOOL) {
    const dashboard = dashboardFromCompiledJson(compiled.content);
    return [{
      tool,
      args: {
        dashboard,
        folder_uid: folder || undefined,
        message: message || undefined,
        mode,
        dry_run: dryRun,
      },
      bytes: JSON.stringify(dashboard).length,
      name: dashboard.title || dashboard.uid || compiled.filename,
      kind: 'dashboard',
    }];
  }
  return null;
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
// Deploy ids — sortable, unique-enough handles for the audit log and the
// post-deploy verify write-back. Not a secret, not a content hash.
function newDeployId() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `dep_${ts}_${Math.random().toString(36).slice(2, 6)}`;
}

// Pre-deploy snapshot capture (10D). Reads the live state of everything the
// deploy is about to touch, through the SAME MCP session that will write:
//   - dashboards: grafana_dashboard_get per uid — fully restorable later
//     (restore = upsert the captured JSON back). A read error most likely
//     means the dashboard doesn't exist yet (this deploy CREATES it), whose
//     rollback is a delete — recorded honestly, never guessed.
//   - rules: one grafana_alert_rules listing as evidence. Per-rule restore
//     is not yet automated (the listing shape isn't contractual across
//     backends), so rules roll back manually WITH receipts.
// Snapshot problems never block the deploy unless strictSnapshot is on.
async function captureDeploySnapshot({ deployId, callTool, availableTools, items, dryRun, folder, safeMcpUrl }) {
  if (dryRun) return { status: 'skipped', itemCount: 0 };
  const meta = { deployId, at: new Date().toISOString(), mcpUrl: safeMcpUrl, folder: folder || null, items: [] };
  const files = {};
  let captured = 0, problems = 0;

  if (items.some(i => i.group === 'rules')) {
    if (availableTools && availableTools.includes('grafana_alert_rules')) {
      try {
        files['alert-rules'] = await callTool('grafana_alert_rules', {});
        meta.items.push({ ref: 'rules', kind: 'rules-listing', preState: 'captured', file: 'alert-rules', restore: 'manual' });
        captured++;
      } catch (e) {
        meta.items.push({ ref: 'rules', kind: 'rules-listing', preState: 'error', error: redactCredentials(String(e.message)), restore: 'manual' });
        problems++;
      }
    } else {
      meta.items.push({ ref: 'rules', kind: 'rules-listing', preState: 'unavailable', restore: 'manual' });
      problems++;
    }
  }

  for (const item of items.filter(i => i.group === 'dashboards' && i.dashboardId)) {
    const uid = String(item.dashboardId);
    if (!(availableTools && availableTools.includes('grafana_dashboard_get'))) {
      meta.items.push({ ref: uid, kind: 'dashboard', preState: 'unavailable', restore: 'manual' });
      problems++;
      continue;
    }
    try {
      files[`dashboard-${uid}`] = await callTool('grafana_dashboard_get', { uid, include_json: true });
      meta.items.push({ ref: uid, kind: 'dashboard', preState: 'captured', file: `dashboard-${uid}`, restore: 'redeploy' });
      captured++;
    } catch (e) {
      // A create, not a capture failure: rollback of a create is a delete.
      meta.items.push({ ref: uid, kind: 'dashboard', preState: 'absent', error: redactCredentials(String(e.message)), restore: 'delete' });
    }
  }

  meta.status = meta.items.length === 0 ? 'empty'
    : problems === 0 ? 'captured'
    : captured > 0 ? 'partial'
    : 'unavailable';
  try { saveDeploySnapshot(deployId, meta, files); }
  catch (e) {
    meta.status = 'failed';
    process.stderr.write(`[deploy-bulk]   snapshot write failed: ${e.message}\n`);
  }
  return { status: meta.status, itemCount: meta.items.length };
}

// GET /api/deploys — the audit trail (VALUE_BACKLOG 10C). Newest first;
// ?pack=<id> filters, ?limit=N caps (default 50). Records include the
// post-deploy verify outcome once item 9 writes it back.
app.get('/api/deploys', (req, res) => {
  const packId = typeof req.query.pack === 'string' && req.query.pack ? req.query.pack : undefined;
  const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 50));
  try {
    res.json({ deploys: readDeployRecords({ packId, limit }) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/deploys/:deployId/verify — the post-deploy re-verify outcome
// (VALUE_BACKLOG item 9) written back into the audit trail. Appended as its
// own record and merged at read time; the original deploy line is never
// rewritten. A verify outcome is read-path evidence — "deployed" stays
// distinct from "verified live" (Phase 1 language contract).
app.post('/api/deploys/:deployId/verify', (req, res) => {
  const deployId = String(req.params.deployId || '');
  if (!/^dep_[A-Za-z0-9_-]+$/.test(deployId)) {
    return res.status(400).json({ ok: false, error: 'malformed deployId' });
  }
  const known = readDeployRecords({ limit: 0 }).some(d => d.deployId === deployId);
  if (!known) return res.status(404).json({ ok: false, error: `unknown deployId: ${deployId}` });
  const b = req.body || {};
  try {
    appendDeployVerify(deployId, {
      outcome: typeof b.outcome === 'string' ? b.outcome : 'unknown',
      summary: (b.summary && typeof b.summary === 'object') ? b.summary : null,
      transitions: Array.isArray(b.transitions) ? b.transitions.slice(0, 200) : null,
      packB: typeof b.packB === 'string' ? b.packB : null,
      refreshedAt: typeof b.refreshedAt === 'string' ? b.refreshedAt : null,
      attempts: Number.isFinite(b.attempts) ? b.attempts : null,
      alignment: Number.isFinite(b.alignment) ? b.alignment : null,
    });
    res.json({ ok: true, deployId });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- saved journeys (VALUE_BACKLOG item 11, studio surface) ----------

// GET /api/journeys — every saved journey with its definition summary and
// last-run outcome, for the studio panel.
// POST /api/packs/:id/retrofeed — the reverse remediation arrow
// (VALUE_BACKLOG item 4): adopt live shadow signals (the diff's onlyInB)
// back into the declared pack. Recomputes the diff server-side (never
// trusts client-supplied artefacts), returns the additions as a fragment,
// the full updated pack YAML, and an honest skipped-list. The updated pack
// is schema-validated before it leaves — retrofeed must never hand out a
// pack that fails its own spec.
app.post('/api/packs/:id/retrofeed', (req, res) => {
  const metaA = findPackMeta(req.params.id);
  if (!metaA) return res.status(404).json({ ok: false, error: `unknown pack: ${req.params.id}` });
  const b = req.body || {};
  const metaB = findPackMeta(String(b.packBId || ''));
  if (!metaB) return res.status(404).json({ ok: false, error: `unknown pack B: ${b.packBId}` });
  try {
    const canonicalA = loadPackCanonical(metaA);
    const canonicalB = loadPackCanonical(metaB);
    const aEnv = typeof b.aEnv === 'string' && b.aEnv ? b.aEnv : null;
    const bEnv = typeof b.bEnv === 'string' && b.bEnv ? b.bEnv : null;
    const diff = diffPacks(
      adapt(canonicalA, { environment: aEnv }),
      adapt(canonicalB, { environment: bEnv }),
      { scopeMode: typeof b.scopeMode === 'string' ? b.scopeMode : undefined,
        service: typeof b.service === 'string' ? b.service : undefined },
    );
    let entries = Object.values(diff.layers || {}).flatMap(l => l.onlyInB || []);
    if (Array.isArray(b.keys) && b.keys.length) {
      // Suffix-tolerant: diff entries and traceability-branch nodes both use
      // identity keys, but each applies its own `#NN` occurrence suffixing —
      // match on the base identity so branch-scoped retrofeed always finds
      // its entries.
      const baseOf = (k) => String(k).replace(/#\d+$/, '');
      const want = new Set(b.keys.map(baseOf));
      entries = entries.filter(e => want.has(baseOf(e.key)));
    }
    const { adopted, skipped, updatedCanonical, fragment } =
      retrofeedShadowSignals(canonicalA, entries, { now: new Date().toISOString() });
    // Tripwire (the crawler incident's law, applied here too).
    const errs = validateCanonical(updatedCanonical, SCHEMA);
    if (errs.length) {
      return res.status(500).json({ ok: false, error: 'retrofeed produced a pack that fails the schema — this is a bug, please report it', details: errs.slice(0, 5) });
    }
    res.json({
      ok: true,
      summary: { candidates: entries.length, adopted: adopted.length, skipped: skipped.length },
      adopted, skipped,
      fragmentYaml: fragment ? emitYaml(fragment) : null,
      updatedPackYaml: emitYaml(updatedCanonical),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/journeys', (req, res) => {
  try {
    const journeys = listJourneys().map(name => {
      let def = null;
      try { def = loadJourneyDef(name); } catch (_) {}
      const lastRun = readJourneyRuns(name, { limit: 1 })[0] || null;
      return {
        name,
        packA: def?.packA?.crawl ? `crawl: ${def.packA.crawl.path}` : (def?.packA?.file || null),
        packB: def?.packB?.mcp ? `mcp: ${def.packB.mcp.url}` : (def?.packB?.file || null),
        gate: def?.gate || {},
        scope: { env: def?.env || null, service: def?.service || null, scopeMode: def?.scopeMode || null },
        lastRun: lastRun && {
          startedAt: lastRun.startedAt,
          outcome: lastRun.outcome,
          alignmentPct: lastRun.drift?.alignmentPct ?? null,
          gradeScore: lastRun.grade?.score ?? null,
          breaches: lastRun.gate?.breaches?.length ?? 0,
        },
      };
    });
    res.json({ journeys });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/journeys/:name/runs — run history newest first (the
// drift-over-time series behind the panel's trend sparkline).
app.get('/api/journeys/:name/runs', (req, res) => {
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 30));
  try {
    res.json({ runs: readJourneyRuns(req.params.name, { limit }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/journeys/:name/run — execute now. HTTP 200 even when the gate
// fails: the run succeeded, the outcome is data. 404 for unknown names,
// 502 when a pack source can't be resolved (live MCP down etc.).
app.post('/api/journeys/:name/run', async (req, res) => {
  let def;
  try { def = loadJourneyDef(req.params.name); }
  catch (e) { return res.status(404).json({ ok: false, error: e.message }); }
  try {
    const record = await runJourney(def);
    res.json({ ok: true, record });
  } catch (e) {
    res.status(502).json({ ok: false, error: redactCredentials(String(e.message)) });
  }
});

// POST /api/journeys/capture — "save this comparison as a journey". The
// server resolves the session's pack ids to durable sources: file-backed
// packs keep their path; uploaded/crawled/drafted packs point at their
// persisted workspace copy (10A); a Pack B that came from a live MCP draft
// is saved as a live mcp: source via its mcp.url annotation, so re-runs
// re-draft instead of comparing against a frozen snapshot.
app.post('/api/journeys/capture', (req, res) => {
  const b = req.body || {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return res.status(400).json({ ok: false, error: 'name required' });
  const metaA = findPackMeta(String(b.packAId || ''));
  const metaB = findPackMeta(String(b.packBId || ''));
  if (!metaA) return res.status(404).json({ ok: false, error: `unknown pack A: ${b.packAId}` });
  if (!metaB) return res.status(404).json({ ok: false, error: `unknown pack B: ${b.packBId}` });

  const sourceFor = (meta) => {
    // Journey-relative paths resolve against the journeys/ dir, so the
    // captured definition always stores absolute paths: catalog packs'
    // repo-relative meta.path is absolutized, and uploaded packs point at
    // their persisted workspace copy (10A).
    if (meta.path) return { file: resolve(meta.path).replaceAll('\\', '/') };
    return { file: join(workspaceInfo().packs, `${meta.id}.pack.yaml`).replaceAll('\\', '/') };
  };
  const packA = sourceFor(metaA);
  let packB;
  let bAnn = {};
  try { bAnn = loadPackCanonical(metaB)?.metadata?.annotations || {}; } catch (_) {}
  if (bAnn['mcp.url']) {
    packB = { mcp: { url: bAnn['mcp.url'] } };
  } else {
    packB = sourceFor(metaB);
  }

  const def = {
    packA, packB,
    ...(b.env ? { env: String(b.env) } : {}),
    ...(b.service ? { service: String(b.service) } : {}),
    ...(b.scopeMode ? { scopeMode: String(b.scopeMode) } : {}),
    gate: (b.gate && typeof b.gate === 'object') ? b.gate : { minAlignmentPct: 85 },
  };
  try {
    const saved = saveJourneyDef(name, def, {
      banner: [
        `Captured from a studio session on ${new Date().toISOString()}.`,
        `Pack A: ${metaA.label || metaA.id} · Pack B: ${metaB.label || metaB.id}`,
        `Edit freely — e.g. swap a frozen pack file for a crawl: source,`,
        `or add authEnv under packB.mcp for authenticated MCPs.`,
      ],
    });
    res.json({ ok: true, name: saved.name });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// GET /api/deploys/:deployId/rollback-plan — what a rollback WOULD do
// (10D). No MCP contact: derived from the snapshot taken at deploy time.
app.get('/api/deploys/:deployId/rollback-plan', (req, res) => {
  const deployId = String(req.params.deployId || '');
  if (!/^dep_[A-Za-z0-9_-]+$/.test(deployId)) return res.status(400).json({ ok: false, error: 'malformed deployId' });
  const snap = readDeploySnapshot(deployId);
  if (!snap) return res.json({ ok: true, deployId, canRollback: false, reason: 'no snapshot was taken for this deploy (dry run, or pre-10D record)', plan: [] });
  const plan = (snap.meta.items || []).map(it => {
    if (it.kind === 'dashboard' && it.preState === 'captured') {
      return { ref: it.ref, kind: it.kind, action: 'restore', detail: 'upsert the captured pre-deploy dashboard JSON' };
    }
    if (it.kind === 'dashboard' && it.restore === 'delete') {
      return { ref: it.ref, kind: it.kind, action: 'delete', detail: 'created by this deploy — removed via grafana_delete_dashboard when the MCP advertises it, manual otherwise' };
    }
    return { ref: it.ref, kind: it.kind, action: 'manual', detail: it.kind === 'rules-listing' ? 'pre-deploy rule listing saved as evidence; per-rule restore is not yet automated' : `pre-state ${it.preState}` };
  });
  res.json({ ok: true, deployId, canRollback: plan.some(p => p.action === 'restore'), snapshotStatus: snap.meta.status, plan });
});

// POST /api/deploys/:deployId/rollback — restore the pre-deploy snapshot
// (10D). Updates restore by re-upserting captured state through the same
// write tools; creates need delete tools the MCP doesn't expose yet and are
// returned as manual steps with exact identities. The rollback is itself a
// deploy-shaped act and lands in the audit log with `rollbackOf`.
app.post('/api/deploys/:deployId/rollback', async (req, res) => {
  const rollbackOf = String(req.params.deployId || '');
  if (!/^dep_[A-Za-z0-9_-]+$/.test(rollbackOf)) return res.status(400).json({ ok: false, error: 'malformed deployId' });
  const original = readDeployRecords({ limit: 0 }).find(d => d.deployId === rollbackOf);
  if (!original) return res.status(404).json({ ok: false, error: `unknown deployId: ${rollbackOf}` });
  const snap = readDeploySnapshot(rollbackOf);
  if (!snap || !['captured', 'partial'].includes(snap.meta.status)) {
    return res.status(409).json({ ok: false, error: `no usable snapshot for ${rollbackOf} (status: ${snap?.meta?.status || 'none'}) — nothing to restore from` });
  }
  const b = req.body || {};
  const mcpUrl = typeof b.mcpUrl === 'string' ? b.mcpUrl.trim() : '';
  if (!mcpUrl) return res.status(400).json({ ok: false, error: 'mcpUrl required in JSON body' });
  const { error: mcpUrlError, safeUrl: safeMcpUrl } = validateMcpUrl(mcpUrl);
  if (mcpUrlError) return res.status(400).json({ ok: false, error: mcpUrlError });
  const dryRun = b.dryRun === true || b.dry_run === true;

  const t0 = Date.now();
  const { rpc, callTool } = createMcpClient({ mcpUrl, mcpAuth: typeof b.mcpAuth === 'string' ? b.mcpAuth : null });
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'observabilitypack-studio-rollback', version: '0.4.0' },
  }).catch(() => {});
  const availableTools = await discoverMcpToolNames(rpc);

  const results = [];
  const manual = [];
  for (const it of snap.meta.items || []) {
    if (it.kind === 'dashboard' && it.preState === 'captured') {
      const itStart = Date.now();
      const raw = snap.readFile(it.file);
      // Defensive unwrap: tools differ in whether they wrap the dashboard.
      const dashboard = raw?.dashboard || raw?.json || raw;
      if (!dashboard || typeof dashboard !== 'object') {
        results.push({ ref: it.ref, action: 'restore', ok: false, error: 'snapshot file unreadable' });
        continue;
      }
      try {
        if (availableTools && !availableTools.includes(GRAFANA_DASHBOARD_TOOL)) throw new Error(`${GRAFANA_DASHBOARD_TOOL} not advertised by this MCP`);
        const result = await callTool(GRAFANA_DASHBOARD_TOOL, {
          dashboard,
          folder_uid: snap.meta.folder || undefined,
          message: `Tomograph rollback of ${rollbackOf}`,
          mode: 'upsert',
          dry_run: dryRun,
        });
        results.push({ ref: it.ref, action: 'restore', ok: true, tookMs: Date.now() - itStart, result });
      } catch (e) {
        results.push({ ref: it.ref, action: 'restore', ok: false, error: redactCredentials(String(e.message)), tookMs: Date.now() - itStart });
      }
    } else if (it.kind === 'dashboard' && it.restore === 'delete') {
      if (availableTools && availableTools.includes('grafana_delete_dashboard')) {
        const itStart = Date.now();
        try {
          const result = await callTool('grafana_delete_dashboard', { uid: it.ref, dry_run: dryRun });
          results.push({ ref: it.ref, action: 'delete', ok: true, tookMs: Date.now() - itStart, result });
        } catch (e) {
          results.push({ ref: it.ref, action: 'delete', ok: false, error: redactCredentials(String(e.message)), tookMs: Date.now() - itStart });
        }
      } else {
        manual.push({ ref: it.ref, kind: it.kind, why: 'created by the deploy; the MCP does not advertise grafana_delete_dashboard — remove it by hand' });
      }
    } else {
      manual.push({ ref: it.ref, kind: it.kind, why: it.kind === 'rules-listing' ? 'per-rule restore is not yet automated — the pre-deploy listing is saved as evidence in the snapshot' : `pre-state ${it.preState}` });
    }
  }

  const okCount = results.filter(r => r.ok).length;
  const failCount = results.length - okCount;
  const deployId = newDeployId();
  try {
    appendDeployRecord({
      deployId,
      at: new Date().toISOString(),
      actor: actorForRequest(req),
      rollbackOf,
      pack: original.pack || null,
      env: original.env || null,
      mcpUrl: safeMcpUrl,
      target: original.target || null,
      mode: 'rollback',
      dryRun,
      items: results.map(r => ({ artifact: r.ref, group: r.action, ok: r.ok, tookMs: r.tookMs || 0, ...(r.error ? { error: r.error } : {}) })),
      summary: { total: results.length, ok: okCount, failed: failCount },
      tookMs: Date.now() - t0,
    });
  } catch (e) {
    process.stderr.write(`[rollback]   audit append failed: ${e.message}\n`);
  }
  res.status(failCount > 0 && okCount === 0 && results.length > 0 ? 502 : 200).json({
    ok: failCount === 0,
    deployId,
    rollbackOf,
    dryRun,
    results,
    manual,
    summary: { total: results.length, ok: okCount, failed: failCount, manual: manual.length },
    tookMs: Date.now() - t0,
  });
});

app.post('/api/packs/:id/deploy-bulk', async (req, res) => {
  const meta = findPackMeta(req.params.id);
  if (!meta) return res.status(404).json({ ok: false, error: `unknown pack: ${req.params.id}` });
  const body = req.body || {};
  const mcpUrl  = typeof body.mcpUrl  === 'string' ? body.mcpUrl.trim() : '';
  const mcpAuth = typeof body.mcpAuth === 'string' ? body.mcpAuth : null;
  const product = (typeof body.targetProduct === 'string' && body.targetProduct.trim()) ? body.targetProduct.trim() : 'grafana';
  const version = (typeof body.targetVersion === 'string' && body.targetVersion.trim()) ? body.targetVersion.trim() : '12';
  const folder  = typeof body.targetFolder === 'string' ? body.targetFolder.trim() : '';
  const mode = ['create', 'upsert', 'update'].includes(body.mode) ? body.mode : 'upsert';
  const dryRun = body.dryRun === true || body.dry_run === true;
  const items = Array.isArray(body.items) ? body.items : null;
  const env = readEnv(req.query);

  if (!mcpUrl) return res.status(400).json({ ok: false, error: 'mcpUrl required in JSON body' });
  const { error: mcpUrlError, safeUrl: safeMcpUrl } = validateMcpUrl(mcpUrl);
  if (mcpUrlError) return res.status(400).json({ ok: false, error: mcpUrlError });
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
    clientInfo: { name: 'observabilitypack-studio-deploy-bulk', version: '0.4.0' },
  }).catch(() => {});
  const availableTools = await discoverMcpToolNames(rpc);
  const missingTools = new Set();

  // Pre-deploy snapshot (10D): capture the live state of everything we are
  // about to overwrite BEFORE the first write, so rollback always has a
  // pre-state — or an honest record that the artefact didn't exist yet.
  const deployId = newDeployId();
  const strictSnapshot = body.strictSnapshot === true || process.env.TOMOGRAPH_STRICT_SNAPSHOT === '1';
  const snapshot = await captureDeploySnapshot({ deployId, callTool, availableTools, items, dryRun, folder, safeMcpUrl });
  if (strictSnapshot && !['captured', 'empty', 'skipped'].includes(snapshot.status)) {
    return res.status(412).json({
      ok: false, deployId,
      error: `pre-deploy snapshot is '${snapshot.status}' and strict snapshot mode is on — refusing to deploy without a rollback point. ` +
             `Fix the read path (grafana_dashboard_get / grafana_alert_rules) or retry without strictSnapshot.`,
      snapshot: { status: snapshot.status, items: snapshot.itemCount },
    });
  }

  const results = [];
  process.stderr.write(`[deploy-bulk] ${meta.id} -> ${safeMcpUrl} (${items.length} item${items.length === 1 ? '' : 's'}, ${product} ${version}, snapshot ${snapshot.status})\n`);

  for (const item of items) {
    const itStart = Date.now();
    const itemTarget = targetFor(item.group);
    try {
      // The deploy modal's dashboard rows carry only dashboardId; the
      // compiler addresses single dashboards as `dash:<id>` (bare 'all'
      // would compile the comment-annotated multi-dashboard bundle, which
      // is not deployable JSON).
      const artifact = item.artifact
        || (item.group === 'dashboards' && item.dashboardId ? `dash:${item.dashboardId}` : 'all');
      const compiled = compileArtifact(overlaid, {
        group: item.group,
        flavor: (product === 'grafana' && item.group === 'rules') ? 'grafana-managed' : item.flavor,
        artifact,
        dashboardId: item.dashboardId,
      });
      const scope = item.scope || (itemTarget === 'prometheus-rules' ? 'both' : undefined);
      const tool = defaultDeployTool({ product, target: itemTarget, scope });
      if (!tool) {
        results.push({ item, ok: false, error: `no default deploy tool for (${product}, ${itemTarget})`, tookMs: Date.now() - itStart });
        continue;
      }
      if (availableTools && !availableTools.includes(tool)) {
        missingTools.add(tool);
        results.push({ item, ok: false, tool, error: deployToolMissingError(tool, availableTools), tookMs: Date.now() - itStart });
        continue;
      }
      const nativeCalls = buildNativeDeployCalls({
        target: itemTarget,
        compiled,
        scope,
        folder,
        tool,
        mode,
        dryRun,
        message: `Tomograph deploy ${meta.id}@${overlaid?.metadata?.version || '?'}`,
      });
      if (!nativeCalls) {
        results.push({ item, ok: false, tool, error: `no native deploy adapter for '${tool}'`, tookMs: Date.now() - itStart });
        continue;
      }
      const callResults = [];
      for (const call of nativeCalls) {
        callResults.push({
          name: call.name,
          kind: call.kind,
          result: await callTool(call.tool, call.args),
        });
      }
      results.push({
        item,
        ok: true,
        tool,
        mode,
        dryRun,
        operations: nativeCalls.length,
        bytes: nativeCalls.reduce((sum, c) => sum + c.bytes, 0),
        tookMs: Date.now() - itStart,
        result: callResults,
      });
    } catch (e) {
      results.push({ item, ok: false, error: e.message, tookMs: Date.now() - itStart });
    }
  }
  const totalMs = Date.now() - t0;
  const okCount = results.filter(r => r.ok).length;
  const failCount = results.length - okCount;
  process.stderr.write(`[deploy-bulk]   done in ${totalMs}ms: ${okCount} ok / ${failCount} failed\n`);
  try {
    appendDeployRecord({
      deployId,
      at: new Date().toISOString(),
      actor: actorForRequest(req),
      pack: { id: meta.id, version: canonical?.metadata?.version || null, contentHash: contentHash(canonical) },
      env: env || null,
      mcpUrl: safeMcpUrl,
      target: { product, version, folder: folder || null },
      mode, dryRun,
      snapshot: { status: snapshot.status, items: snapshot.itemCount },
      items: results.map(r => ({
        ...(r.item || {}),
        ok: !!r.ok,
        tool: r.tool || null,
        operations: r.operations || 0,
        bytes: r.bytes || 0,
        tookMs: r.tookMs || 0,
        ...(r.error ? { error: redactCredentials(String(r.error)) } : {}),
      })),
      summary: { total: results.length, ok: okCount, failed: failCount },
      tookMs: totalMs,
    });
  } catch (e) {
    process.stderr.write(`[deploy-bulk]   audit append failed: ${e.message}\n`);
  }
  res.status(failCount > 0 && okCount === 0 ? 502 : 200).json({
    ok: failCount === 0,
    deployId,
    results,
    summary: { total: results.length, ok: okCount, failed: failCount },
    targetProduct: product,
    targetVersion: version,
    targetFolder: folder || null,
    mode,
    dryRun,
    missingTools: [...missingTools],
    mcpToolsAvailable: availableTools,
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
  const folder = typeof body.targetFolder === 'string' ? body.targetFolder.trim() : '';
  const mode = ['create', 'upsert', 'update'].includes(body.mode) ? body.mode : 'upsert';
  const dryRun = body.dryRun === true || body.dry_run === true;
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
  const { error: mcpUrlError, safeUrl: safeMcpUrl } = validateMcpUrl(mcpUrl);
  if (mcpUrlError) return res.status(400).json({ ok: false, error: mcpUrlError });

  const t0 = Date.now();
  let canonical = null;   // hoisted: the catch-path audit record reads it
  try {
    canonical = loadPackCanonical(meta);
    const { canonical: overlaid } = overlaidCanonical(canonical, env);
    const nativeTool = mcpTool === GRAFANA_ALERT_RULE_TOOL || mcpTool === GRAFANA_DASHBOARD_TOOL;
    const compiled = (mcpTool === GRAFANA_ALERT_RULE_TOOL && product === 'grafana' && target === 'prometheus-rules')
      ? compileArtifact(overlaid, { group: 'rules', flavor: 'grafana-managed', artifact: 'all' })
      : compile(overlaid, target, { dashboardId });

    // For rules deploy, apply the scope filter (recording-only / alerting-only).
    const payload = (target === 'prometheus-rules')
      ? filterPromRulesScope(compiled.content, scope)
      : compiled.content;

    process.stderr.write(`[deploy] ${meta.id}@${canonical.metadata?.version || '?'} -> ${safeMcpUrl} via ${mcpTool} ` +
      `(${product} ${version}, target=${target}, scope=${scope || '—'}, env=${env || 'none'}, mode=${mode}, ${payload.length}b)\n`);

    const { rpc, callTool } = createMcpClient({ mcpUrl, mcpAuth });
    await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'observabilitypack-studio-deploy', version: '0.4.0' },
    }).catch(() => {});

    const availableTools = await discoverMcpToolNames(rpc);
    if (availableTools && !availableTools.includes(mcpTool)) {
      throw new Error(deployToolMissingError(mcpTool, availableTools));
    }

    let result;
    let bytes = payload.length;
    let operations = 1;
    if (nativeTool) {
      const nativeCalls = buildNativeDeployCalls({
        target,
        compiled,
        scope,
        folder,
        tool: mcpTool,
        mode,
        dryRun,
        message: `Tomograph deploy ${meta.id}@${canonical.metadata?.version || '?'}`,
      });
      result = [];
      operations = nativeCalls.length;
      bytes = nativeCalls.reduce((sum, c) => sum + c.bytes, 0);
      for (const call of nativeCalls) {
        result.push({
          name: call.name,
          kind: call.kind,
          result: await callTool(call.tool, call.args),
        });
      }
    } else {
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
        folder: folder || undefined,
      };
      result = await callTool(mcpTool, args);
    }

    const tookMs = Date.now() - t0;
    process.stderr.write(`[deploy]   ok in ${tookMs}ms\n`);
    const deployId = auditSingleDeploy({
      meta, canonical, env, safeMcpUrl, product, version, folder, mode, dryRun,
      actor: actorForRequest(req),
      item: { target, scope: scope || null, ok: true, tool: mcpTool, operations, bytes, tookMs },
    });
    res.json({
      ok: true,
      deployId,
      target, env, tool: mcpTool, mcpUrl,
      targetProduct: product, targetVersion: version, scope: scope || null, targetFolder: folder || null,
      mode, dryRun, operations,
      filename: compiled.filename,
      bytes,
      tookMs,
      result,
    });
  } catch (e) {
    const tookMs = Date.now() - t0;
    process.stderr.write(`[deploy]   error in ${tookMs}ms: ${redactCredentials(e.message)}\n`);
    const deployId = auditSingleDeploy({
      meta, canonical, env, safeMcpUrl, product, version, folder, mode, dryRun,
      actor: actorForRequest(req),
      item: { target, scope: scope || null, ok: false, tool: mcpTool, tookMs, error: redactCredentials(String(e.message)) },
    });
    res.status(502).json({ ok: false, deployId, error: e.message, tool: mcpTool, target,
      targetProduct: product, targetVersion: version, scope: scope || null, targetFolder: folder || null,
      mode, dryRun, env, tookMs });
  }
});

// One audit record for the single-artefact deploy route — same shape as a
// bulk record with exactly one item, so /api/deploys consumers see a
// uniform stream. Audit failures never fail the deploy response.
function auditSingleDeploy({ meta, canonical, env, safeMcpUrl, product, version, folder, mode, dryRun, item, actor }) {
  const deployId = newDeployId();
  try {
    appendDeployRecord({
      deployId,
      at: new Date().toISOString(),
      actor: actor || 'local',
      pack: { id: meta.id, version: canonical?.metadata?.version || null, contentHash: contentHash(canonical) },
      env: env || null,
      mcpUrl: safeMcpUrl,
      target: { product, version, folder: folder || null },
      mode, dryRun,
      items: [item],
      summary: { total: 1, ok: item.ok ? 1 : 0, failed: item.ok ? 0 : 1 },
      tookMs: item.tookMs || 0,
    });
  } catch (err) {
    process.stderr.write(`[deploy]   audit append failed: ${err.message}\n`);
  }
  return deployId;
}

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

// Local live refreshes write this ignored runtime file. It is deliberately not
// a committed example; the live-status badge reports absent until a refresh
// creates it in the working tree.
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
  const { error: mcpUrlError, safeUrl: safeMcpUrl } = validateMcpUrl(mcpUrl);
  if (mcpUrlError) return res.status(400).json({ ok: false, error: mcpUrlError });

  const t0 = Date.now();
  try {
    process.stderr.write(`[draft-from-mcp] POST -> ${safeMcpUrl}\n`);
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
    const probesEmpty     = (ann['mcp.probesEmpty']     || '').split(',').filter(Boolean);
    const probesFailed    = (ann['mcp.probesFailed']    || '').split(',').filter(Boolean);

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
        probesAttempted, probesSucceeded, probesEmpty, probesFailed,
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
    // Prefer the caller-supplied label (the quick-start cases pass
    // something friendlier than the auto-generated metadata name).
    const friendlyLabel = (typeof body.label === 'string' && body.label.trim())
      ? body.label.trim()
      : `${pack.metadata?.name || 'mcp-draft'} (live MCP draft)`;
    const registered = errors.length === 0
      ? { id: registerUploadedPack(pack, friendlyLabel, friendlyLabel) }
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
    process.stderr.write(`[draft-from-mcp]   error in ${Date.now() - t0}ms: ${redactCredentials(e.message)}\n`);
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
  const { error: mcpUrlError, safeUrl: safeMcpUrl } = validateMcpUrl(mcpUrl);
  if (mcpUrlError) return res.status(400).json({ ok: false, error: mcpUrlError });

  const t0 = Date.now();
  try {
    process.stderr.write(`[refresh-live] POST /api/refresh-live -> ${safeMcpUrl}\n`);
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
    process.stderr.write(`[refresh-live]   error in ${Date.now() - t0}ms: ${redactCredentials(e.message)}\n`);
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
    diffScopeMode: typeof body.diffScopeMode === 'string' ? body.diffScopeMode : undefined,
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
    const friendlyLabel = (typeof body.label === 'string' && body.label.trim())
      ? body.label.trim()
      : `${opts.repoName || canonical.metadata?.name || 'crawl'} (scanned)`;
    const registered = validationErrors.length === 0
      ? { id: registerUploadedPack(canonical, friendlyLabel, friendlyLabel) }
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
// Bandwidth guards: max 200 files, max 16 MB total, max 1 MB per file.
// ----------------------------------------------------------------
function parseGithubUrl(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  const cleaned = input.trim().replace(/\.git$/, '').replace(/\/$/, '');
  // owner/repo bare form
  const bare = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(cleaned);
  if (bare) return { owner: bare[1], repo: bare[2] };
  // Full URL form
  const url = /github\.com[/:]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)(?:\/tree\/([A-Za-z0-9._/-]+))?/.exec(cleaned);
  if (url) return { owner: url[1], repo: url[2], ref: url[3] };
  return null;
}

// Files the crawler will actually look at — keep the network round
// trips down by filtering BEFORE downloading.
function isCrawlerFile(path) {
  if (typeof path !== 'string') return false;
  const p = path.toLowerCase();
  if (p.includes('node_modules/') || p.includes('.git/') || p.startsWith('.git/')) return false;
  const sourceMetricCandidate =
    /\.(cjs|mjs|js|jsx|ts|tsx|py|go|java|kt|rs|cs)$/.test(p) &&
    !/(\.test\.|\.spec\.|\.d\.ts$|package-lock|yarn\.lock|pnpm-lock|tokenizer\.json)/.test(p) &&
    /(metrics?|prometheus|observability|telemetry|instrumentation|monitor|otel|mcp|bayesian|processor)/.test(p);
  return (
    sourceMetricCandidate ||
    /(^|\/)(application|bootstrap)[\w.-]*\.ya?ml$/.test(p) ||
    /(^|\/)docker[-_]compose[a-z0-9._-]*\.(ya?ml)$/.test(p) ||
    /(^|\/)compose[a-z0-9._-]*\.(ya?ml)$/.test(p) ||
    /\.rules\.(ya?ml)$/.test(p) ||
    /(^|\/)prometheus[a-z0-9._-]*\.(ya?ml)$/.test(p) ||
    /(^|\/)alertmanager[a-z0-9._-]*\.(ya?ml)$/.test(p) ||
    /(^|\/)otel[a-z0-9._-]*config[a-z0-9._-]*\.(ya?ml)$/.test(p) ||
    /(^|\/)otelcol[a-z0-9._-]*\.(ya?ml)$/.test(p) ||
    /(^|\/)collector[a-z0-9._-]*\.(ya?ml)$/.test(p) ||
    /(^|\/)chart\.(ya?ml)$/.test(p) ||
    /(^|\/)values[\w.-]*\.(ya?ml)$/.test(p) ||
    /(^|\/)templates\/.*\.(ya?ml)$/.test(p) ||
    /(^|\/)k8s\/.*\.(ya?ml)$/.test(p) ||
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
    const MAX_FILES = 200;
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
      diffScopeMode: typeof body.diffScopeMode === 'string' ? body.diffScopeMode : undefined,
      criticality: typeof body.criticality === 'string' ? body.criticality : undefined,
      binding: typeof body.binding === 'string' ? body.binding : undefined,
      owners: Array.isArray(body.owners) ? body.owners.map(String) : undefined,
    };
    const { yaml, summary, evidence } = crawlToYaml(files, opts);
    const { canonical } = crawlFiles(files, opts);
    const validationErrors = validateCanonical(canonical, SCHEMA);
    const conformance = evaluateConformance(canonical);
    const friendlyLabel = (typeof body.label === 'string' && body.label.trim())
      ? body.label.trim()
      : `${owner}/${repo} (repo scan)`;
    const registered = validationErrors.length === 0
      ? { id: registerUploadedPack(canonical, friendlyLabel, friendlyLabel) }
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
// Loopback by default — matching the documented contract. Exposing the
// studio (HOST=0.0.0.0) requires TOMOGRAPH_API_TOKEN; see start().
const HOST = process.env.HOST || '127.0.0.1';

export { app };
// Rehydrate the upload registry from the .tomograph/ workspace. Runs once
// per process, inside start() (not at module load) so tests can point
// TOMOGRAPH_WORKSPACE at a temp dir before booting. Entries arrive oldest
// lastUsedAt first, preserving the map's LRU insertion order.
let workspaceRehydrated = false;
function rehydrateUploadsFromWorkspace(silent) {
  if (workspaceRehydrated) return;
  workspaceRehydrated = true;
  let restored = 0;
  try {
    for (const p of loadWorkspacePacks()) {
      if (UPLOADED_PACKS.has(p.id)) continue;
      UPLOADED_PACKS.set(p.id, { canonical: p.canonical, source: p.source, label: p.label, createdAt: p.createdAt });
      restored++;
    }
  } catch (e) {
    process.stderr.write(`[workspace] rehydrate failed: ${e.message}\n`);
  }
  if (restored && !silent) process.stdout.write(`[studio] restored ${restored} pack${restored === 1 ? '' : 's'} from workspace\n`);
}

function isLoopbackHost(h) {
  const host = String(h || '').toLowerCase();
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

export function start({ port = PORT, host = HOST, silent = false } = {}) {
  // Fail closed (10B): binding beyond loopback with no auth at all would
  // expose every write route — crawl, draft, deploy — to the network.
  // Identity (OIDC or stand-alone users) satisfies the requirement just
  // like the API token does.
  if (!isLoopbackHost(host) && !apiToken() && !authEnabled()) {
    if (process.env.TOMOGRAPH_INSECURE_NO_AUTH === '1') {
      process.stderr.write(
        `[studio] WARNING: bound to ${host} with NO auth (TOMOGRAPH_INSECURE_NO_AUTH=1). ` +
        `Every write route is open to the network. Do not run this posture outside a trusted network.\n`);
    } else {
      return Promise.reject(new Error(
        `refusing to bind to ${host} without auth: mutating /api routes would be open to the network.\n` +
        `  Set TOMOGRAPH_API_TOKEN=<secret> (clients send Authorization: Bearer <secret>),\n` +
        `  or bind to loopback (HOST=127.0.0.1), or set TOMOGRAPH_INSECURE_NO_AUTH=1 to override knowingly.`));
    }
  }
  rehydrateUploadsFromWorkspace(silent);
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
