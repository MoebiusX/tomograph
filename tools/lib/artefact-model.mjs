// tools/lib/artefact-model.mjs
//
// BEHAVIORAL ARTEFACT MODEL
//
// The thesis: two artefacts are "the same" when they represent the same
// deployed control. For telemetry artefacts that means product+signal, output
// series, binding target, etc. For contract artefacts (SLIs, SLOs, dashboards,
// derived views), the declared id is itself the handle other controls bind to,
// so the id is part of the behaviour on purpose. Positional adapter ids such as
// `SLI-01` or `BAK-03` are never behavioural identity.
//
// For every artefact family we construct a typed object with two faces:
//
//   identity  — the behaviour-determining handle used to PAIR an A artefact
//               with its B counterpart. Derived from content (series name,
//               product+signal, output series, binding target), never from the
//               positional `XXX-NN` id the adapter assigns or a cosmetic label.
//
//   behavior  — the full behavioural contract used to decide whether a matched
//               pair is ALIGNED (identical deployed behaviour) or DRIFTED (same
//               artefact, divergent behaviour). Compares ALL content so nothing
//               that affects the running system is silently ignored, with
//               volatile wiring (endpoints, auth, descriptions, annotations)
//               and cosmetic formatting (PromQL whitespace) normalised away.
//
// Pure ESM, no Node APIs — the studio imports this same file in the browser.

// ---------------------------------------------------------------------------
// Normalisation primitives
// ---------------------------------------------------------------------------

// Fields that legitimately differ between a repo manifest and a live
// reconstruction of the same artefact: deployment coordinates and presentation,
// not the contract. Stripped before comparison so "aligned" reflects the
// SEMANTIC definition, not whether the URLs or prose happen to agree.
//
// `folder` and `provider` are dashboard placement/deployment coordinates: which
// Grafana folder a dashboard files under, and which provisioning provider (and
// its version/schemaVersion) renders it. Two packs that file the same dashboard
// in different folders, or reconstruct it under a different provider version,
// describe the SAME dashboard — the contract is its panels/bindings, not where
// it's filed. The compiler still reads `provider.version` straight from the raw
// pack for emission fidelity, so dropping it here only affects EQUALITY, never
// what gets compiled.
const VOLATILE_SPEC_KEYS = new Set([
  'endpoints', 'endpoint', 'url', 'address', 'host', 'auth',
  'description', 'desc', 'title', 'summary', 'annotations',
  'source', 'evidence', 'mcp', 'default',
  'folder', 'provider',
]);

// Spec fields that carry an executable expression. Whitespace and surrounding
// blanks are cosmetic — `rate(x[5m])` and `rate( x[5m] )` deploy identically —
// so they're collapsed before comparison.
const EXPR_KEYS = new Set(['expr', 'query', 'promql', 'expression']);

function normalizeExpr(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

function stripRef(s) {
  if (typeof s !== 'string') return s ?? '';
  return s.replace(/^ref:/, '').replace(/^slos\./, '').replace(/^slis\./, '');
}

// Recursively normalise a value for order-independent structural equality:
// sort object keys, drop volatile/empty fields, normalise expressions, and
// collapse a version block to its declared contract (gating is an operational
// toggle, not the contract). Arrays are normalised element-wise then sorted so
// declaration order can't masquerade as drift.
export function canonicalize(value, keyName) {
  if (typeof value === 'string' && EXPR_KEYS.has(keyName)) {
    return normalizeExpr(value);
  }
  if (Array.isArray(value)) {
    const out = value
      .map((v) => canonicalize(v))
      .filter((v) => !isEmptyComparable(v))
      .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
    return out.length ? out : undefined;
  }
  if (value && typeof value === 'object') {
    if (keyName === 'version') {
      return value.declared !== undefined ? { declared: value.declared } : sortedObject(value);
    }
    const out = {};
    for (const k of Object.keys(value).sort()) {
      if (VOLATILE_SPEC_KEYS.has(k)) continue;
      const cv = canonicalize(value[k], k);
      if (isEmptyComparable(cv)) continue;
      out[k] = cv;
    }
    return out;
  }
  return value;
}

function isEmptyComparable(value) {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
}

function sortedObject(value) {
  const out = {};
  for (const k of Object.keys(value).sort()) out[k] = value[k];
  return out;
}

// ---------------------------------------------------------------------------
// Family classification
// ---------------------------------------------------------------------------

// Resolve an artefact to its behavioural family. Prefers the canonical
// `defines` symbol the adapter attaches; otherwise reads the id prefix. The
// positional number in the id is never used as identity — only as a family
// discriminator here.
export function classify(artefact) {
  if (!artefact) return 'unknown';
  const defines = artefact.defines || '';
  if (defines.startsWith('slis.'))               return 'sli';
  if (defines.startsWith('slos.'))               return 'slo';
  if (defines.startsWith('telemetry.backends.')) return 'backend';
  if (defines.startsWith('queries.derived_views.')) return 'derived_view';
  if (defines.startsWith('dashboards.'))         return 'dashboard';

  const id = artefact.id || '';
  if (id === 'OTEL-01')          return 'otel';
  if (id.startsWith('PIP-RCV-')) return 'pipeline_receiver';
  if (id.startsWith('PIP-PRC-')) return 'pipeline_processor';
  if (id === 'PIP-EXP-MET')      return 'pipeline_exporter_metrics';
  if (id === 'PIP-EXP-LOG')      return 'pipeline_exporter_logs';
  if (id === 'PIP-EXP-TRC')      return 'pipeline_exporter_traces';
  if (id === 'STO-MET-01')       return 'storage_metrics';
  if (id === 'STO-LOG-01')       return 'storage_logs';
  if (id === 'STO-TRC-01')       return 'storage_traces';
  if (id.startsWith('METRIC-'))  return 'metric';
  if (id === 'PROF-01')          return 'profiling';
  if (id === 'NET-01')           return 'network';
  if (id === 'POE-01')           return 'policy_engine';
  if (id.startsWith('MESH-'))    return 'mesh';
  if (id.startsWith('COL-'))     return 'collection';
  if (id.startsWith('QRY-'))     return 'recording_rule';
  if (id.startsWith('PANEL-'))   return 'panel';
  if (id.startsWith('POL-'))     return 'burn_rate';
  if (id.startsWith('FCST-'))    return 'forecast';
  if (id.startsWith('ALR-'))     return 'alert_route';
  if (id.startsWith('HEAL-'))    return 'remediation';
  if (id === 'BASE-01')          return 'baselines';
  if (id.startsWith('CHAOS-'))   return 'chaos';
  if (id.startsWith('SYN-'))     return 'synthetic';
  if (id.startsWith('IMP-'))     return 'imports';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Per-family identity
//
// Each entry returns the behaviour-determining identity object for its family.
// `s` is artefact.spec, `a` is the whole artefact (for the few cases that need
// the parent pointer, e.g. panels). The positional id is deliberately absent.
// ---------------------------------------------------------------------------

const IDENTITY = {
  // Contract handles. SLI/SLO ids ARE the contract — other artefacts bind to
  // them by id, so a rename is a genuine behavioural change, not cosmetic.
  sli:          (s, a) => ({ id: definedId(a, 'slis.') }),
  slo:          (s, a) => ({ id: definedId(a, 'slos.') }),
  derived_view: (s, a) => ({ id: definedId(a, 'queries.derived_views.') }),
  dashboard:    (s, a) => ({ id: definedId(a, 'dashboards.') }),

  // A backend's behaviour is "this product serving this signal". The id is a
  // cosmetic label — two packs naming the same backend differently still
  // deploy the same collector wiring.
  backend:      (s) => ({ product: low(s.product), signal: low(s.signal) }),

  otel:         () => ({}),

  // Pipeline stages identify by what they do, not by position.
  pipeline_receiver:          (s) => ({ name: low(s.name) }),
  pipeline_processor:         (s) => ({ name: low(s.name) }),
  pipeline_exporter_metrics:  (s) => ({ signal: 'metrics', target: low(s.kind) }),
  pipeline_exporter_logs:     (s) => ({ signal: 'logs',    target: low(s.kind) }),
  pipeline_exporter_traces:   (s) => ({ signal: 'traces',  target: low(s.kind) }),

  storage_metrics: (s) => ({ signal: 'metrics', backend: low(s.backend) }),
  storage_logs:    (s) => ({ signal: 'logs',    backend: low(s.backend) }),
  storage_traces:  (s) => ({ signal: 'traces',  backend: low(s.backend) }),

  // A metric IS its series name — that's the handle every query targets.
  // Never the positional METRIC-NN index.
  metric:       (s) => ({ name: low(s.name) }),

  profiling:    (s) => ({ product: low(s.product) }),
  network:      (s) => ({ product: low(s.product) }),
  policy_engine:(s) => ({ product: low(s.product) }),
  mesh:         (s) => ({ product: low(s.product), role: low(s.role) }),
  collection:   (s) => ({ product: low(s.product), role: low(s.role) }),

  // A recording rule's deployed contract is the output series it produces.
  recording_rule: (s) => ({ record: low(s.name) }),

  // A panel's behaviour is what it visualises — the binding target, scoped to
  // its dashboard. Never the positional PANEL-NN index.
  panel:        (s, a) => ({ parent: a.parent || '', binds_to: low(s.binds_to) }),

  burn_rate:    (s) => ({ slo: stripRef(s.slo) }),
  forecast:     (s) => ({ slo: stripRef(s.slo) }),
  alert_route:  (s) => ({ severity: low(s.severity) }),
  remediation:  (s) => ({ trigger: low(s.trigger) }),
  baselines:    () => ({}),
  chaos:        (s) => ({ id: low(s.id) }),
  synthetic:    (s) => ({ id: low(s.id) }),
  imports:      (s) => ({ ref: stripRef(s.ref) }),
  unknown:      (s, a) => ({ id: a.id || '' }),
};

function definedId(artefact, prefix) {
  const d = artefact.defines || '';
  return d.startsWith(prefix) ? d.slice(prefix.length) : d || artefact.id || '';
}

function low(v) {
  return typeof v === 'string' ? v.toLowerCase() : (v ?? '');
}

// ---------------------------------------------------------------------------
// Public model API
// ---------------------------------------------------------------------------

// Build the behavioural model object for an artefact:
//   { kind, identity, behavior }
// `identity` pairs A↔B; `behavior` decides aligned vs drifted.
export function modelOf(artefact) {
  const kind = classify(artefact);
  const idFn = IDENTITY[kind] || IDENTITY.unknown;
  const identity = idFn(artefact?.spec || {}, artefact || {});
  const behavior = canonicalize(artefact?.spec ?? {});
  return { kind, identity, behavior };
}

// Stable primitive key for pairing. A Map needs a string key, so we serialise
// the {kind, identity} object — but the key is DERIVED FROM the behavioural
// identity object, not from a name. Two artefacts collide here iff they are the
// same behavioural artefact.
export function identityKeyOf(artefact) {
  if (!artefact) return null;
  const { kind, identity } = modelOf(artefact);
  return `${kind}::${stableStringify(identity)}`;
}

// The full behavioural contract object — what "compare the contents" compares.
export function behaviorOf(artefact) {
  return modelOf(artefact).behavior;
}

// Top-level behavioural fields whose values differ between two matched
// artefacts. Empty array ⇒ identical deployed behaviour (aligned).
export function deltasOf(a, b) {
  const ba = behaviorOf(a);
  const bb = behaviorOf(b);
  const fields = new Set([...Object.keys(ba), ...Object.keys(bb)]);
  const deltas = [];
  for (const f of [...fields].sort()) {
    const sa = JSON.stringify(ba[f] ?? null);
    const sb = JSON.stringify(bb[f] ?? null);
    if (sa !== sb) deltas.push({ field: f, a: ba[f] ?? null, b: bb[f] ?? null });
  }
  return deltas;
}

// True when two artefacts deploy to identical behaviour.
export function behaviorEqual(a, b) {
  return stableStringify(behaviorOf(a)) === stableStringify(behaviorOf(b));
}

// Deterministic JSON: object keys are already sorted by canonicalize, but
// identity objects are small hand-built maps — sort their keys too so key order
// never changes the serialisation.
function stableStringify(value) {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = v[k];
      return out;
    }
    return v;
  });
}
