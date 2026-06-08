// tools/lib/diff.mjs
//
// Pack arithmetic — set operations on the artefact symbols of two adapted
// layered packs. Pure ESM, no Node APIs, so the client could (and may, in
// a future restoration) call it directly.
//
// MATCHING
//   Two artefacts "are the same" when they share a canonical key. The key
//   is derived from the canonical content (not from the positional ID the
//   adapter assigns, which is pack-local). `keyOf(artefact)` is the
//   single source of truth — extend it as the adapter grows.
//
// SET OPS
//   For each layer we produce three buckets:
//     - onlyInA  artefacts present in A but not B
//     - onlyInB  artefacts present in B but not A
//     - inBoth   matched pairs, with both A's and B's projection so the
//                  caller can show spec differences side-by-side
//
//   The classic operations follow:
//     A ∪ B  = onlyInA ∪ inBoth ∪ onlyInB
//     A ∩ B  = inBoth
//     A − B  = onlyInA
//     B − A  = onlyInB

const LAYER_ORDER = ['L1', 'L2', 'L2X', 'L3', 'L4', 'L5', 'GOV'];

// Per-family key derivation. For artefacts the adapter already gave a
// `defines` symbol (SLIs, SLOs, backends, dashboards, derived views) we
// reuse it. For the rest we synthesise from the canonical spec fields
// the adapter preserved on `artefact.spec`.
export function keyOf(artefact) {
  if (!artefact) return null;
  if (artefact.defines) return artefact.defines;

  const id = artefact.id || '';
  const s = artefact.spec || {};

  if (id === 'OTEL-01')          return 'otel';
  if (id.startsWith('PIP-RCV-')) return `pipeline.receiver:${s.name || '_'}`;
  if (id.startsWith('PIP-PRC-')) return `pipeline.processor:${s.name || '_'}`;
  if (id === 'PIP-EXP-MET')      return `pipeline.exporter.metrics:${s.kind || '_'}`;
  if (id === 'PIP-EXP-LOG')      return `pipeline.exporter.logs:${s.kind || '_'}`;
  if (id === 'PIP-EXP-TRC')      return `pipeline.exporter.traces:${s.kind || '_'}`;
  if (id === 'STO-MET-01')       return `storage.metrics:${s.backend || '_'}`;
  if (id === 'STO-LOG-01')       return `storage.logs:${s.backend || '_'}`;
  if (id === 'STO-TRC-01')       return `storage.traces:${s.backend || '_'}`;
  if (id === 'PROF-01')          return `profiling:${s.product || '_'}`;
  if (id === 'NET-01')           return `network:${s.product || '_'}`;
  if (id === 'POE-01')           return `policy_engine:${s.product || '_'}`;
  if (id.startsWith('MESH-'))    return `mesh:${s.product || '_'}:${s.role || '_'}`;
  if (id.startsWith('COL-'))     return `collection:${s.product || '_'}:${s.role || '_'}`;
  if (id.startsWith('QRY-'))     return `recording_rule:${s.name || '_'}`;
  if (id.startsWith('POL-'))     return `policy.burn_rate:${stripRef(s.slo)}`;
  if (id.startsWith('FCST-'))    return `policy.forecast:${stripRef(s.slo)}`;
  if (id.startsWith('ALR-'))     return `alerting.route:${s.severity || '_'}`;
  if (id.startsWith('HEAL-'))    return `remediation:${s.trigger || '_'}`;
  if (id === 'BASE-01')          return 'baselines';
  if (id.startsWith('CHAOS-'))   return `chaos:${s.id || '_'}`;
  if (id.startsWith('SYN-'))     return `synthetic:${s.id || '_'}`;
  if (id.startsWith('IMP-'))     return `imports:${s.ref || '_'}`;

  // Fallback — anything unrecognised stays pack-local so it always
  // appears in onlyInA / onlyInB rather than crashing the comparison.
  return `_unknown:${id}`;
}

function stripRef(s) {
  if (typeof s !== 'string') return s ?? '';
  return s.replace(/^ref:/, '').replace(/^slos\./, '');
}

// ============================================================
// STRUCTURAL MATCHING
//
// A shared key (keyOf) establishes that two artefacts are the SAME
// artefact — same identity. It does NOT establish that they AGREE.
// Two SLOs both named `slos.api_availability_99` are the same contract;
// whether they're *aligned* depends on whether their objective, window
// and SLI binding actually match. Identity is the name on the door;
// alignment is the contents of the room.
//
// `projectOf(artefact)` reifies an artefact into its canonical comparable
// object — the semantic spec definition with volatile, environment-specific
// wiring removed. Two artefacts are aligned only when their projections are
// structurally equal; otherwise they're drifted, and `deltasOf` reports
// exactly which fields diverged.
// ============================================================

// Fields that legitimately differ between a repo manifest and a live
// reconstruction of the same artefact — deployment coordinates and
// presentation, not the contract. Stripped before comparison so "aligned"
// means the SEMANTIC definition matches, not that the URLs happen to agree.
const VOLATILE_SPEC_KEYS = new Set([
  'endpoints', 'endpoint', 'url', 'address', 'host', 'auth',
  'description', 'desc', 'title', 'summary', 'annotations',
  'source', 'evidence', 'mcp', 'default',
]);

// Recursively normalise a value for order-independent structural equality:
// sort object keys, drop volatile/empty fields, and collapse a version block
// to its declared contract (gating is an operational toggle, not the
// contract). Arrays are normalised element-wise then sorted so declaration
// order doesn't masquerade as drift.
function canonicalize(value, keyName) {
  if (Array.isArray(value)) {
    return value
      .map((v) => canonicalize(v))
      .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
  }
  if (value && typeof value === 'object') {
    if (keyName === 'version') {
      return value.declared !== undefined ? { declared: value.declared } : sortedObject(value);
    }
    const out = {};
    for (const k of Object.keys(value).sort()) {
      if (VOLATILE_SPEC_KEYS.has(k)) continue;
      const cv = canonicalize(value[k], k);
      if (cv === undefined || cv === null || cv === '') continue;
      if (typeof cv === 'object' && !Array.isArray(cv) && Object.keys(cv).length === 0) continue;
      out[k] = cv;
    }
    return out;
  }
  return value;
}

function sortedObject(value) {
  const out = {};
  for (const k of Object.keys(value).sort()) out[k] = value[k];
  return out;
}

// The structured comparable projection of an artefact: its canonical spec
// definition with volatile deployment fields removed. This is the object
// that "matching" actually compares.
export function projectOf(artefact) {
  return canonicalize(artefact?.spec ?? {});
}

// Top-level spec fields whose canonical projections differ between two
// matched artefacts. Powers the per-pair "what drifted" detail.
export function deltasOf(a, b) {
  const pa = projectOf(a);
  const pb = projectOf(b);
  const fields = new Set([...Object.keys(pa), ...Object.keys(pb)]);
  const deltas = [];
  for (const f of [...fields].sort()) {
    const sa = JSON.stringify(pa[f] ?? null);
    const sb = JSON.stringify(pb[f] ?? null);
    if (sa !== sb) deltas.push({ field: f, a: pa[f] ?? null, b: pb[f] ?? null });
  }
  return deltas;
}


function layerArtefacts(layered, layerId) {
  const ls = layered?.layers || {};
  if (layerId === 'L4') {
    return [
      ...(ls.L4?.policy   || []),
      ...(ls.L4?.alerting || []),
      ...(ls.L4?.healing  || []),
    ];
  }
  return ls[layerId] || [];
}

function packMeta(layered) {
  return {
    id: layered?.id,
    name: layered?.name,
    criticality: layered?.meta?.criticality,
    environment: layered?.meta?.environment,
    version: layered?.meta?.version,
    binding: layered?.meta?.binding,
  };
}

export function diffPacks(aLayered, bLayered) {
  if (!aLayered || !bLayered) throw new Error('diffPacks: both packs required');

  const layers = {};
  let onlyInA = 0, onlyInB = 0, inBoth = 0, aligned = 0, drifted = 0;

  for (const layerId of LAYER_ORDER) {
    const aItems = layerArtefacts(aLayered, layerId);
    const bItems = layerArtefacts(bLayered, layerId);

    const aByKey = new Map();
    const bByKey = new Map();
    for (const a of aItems) aByKey.set(keyOf(a), a);
    for (const b of bItems) bByKey.set(keyOf(b), b);

    const bucket = { onlyInA: [], onlyInB: [], inBoth: [] };

    for (const [k, a] of aByKey) {
      if (bByKey.has(k)) {
        // Same identity — now compare the reified objects to decide
        // whether they actually AGREE. Aligned only when the canonical
        // projections match; otherwise drifted, with field-level deltas.
        const b = bByKey.get(k);
        const deltas = deltasOf(a, b);
        const match = deltas.length === 0 ? 'aligned' : 'drifted';
        bucket.inBoth.push({ key: k, a, b, match, deltas });
      } else {
        bucket.onlyInA.push({ key: k, artefact: a });
      }
    }
    for (const [k, b] of bByKey) {
      if (!aByKey.has(k)) bucket.onlyInB.push({ key: k, artefact: b });
    }

    // Stable order — alphabetical by key — so the UI doesn't reshuffle on
    // every load.
    bucket.onlyInA.sort((x, y) => x.key.localeCompare(y.key));
    bucket.onlyInB.sort((x, y) => x.key.localeCompare(y.key));
    bucket.inBoth.sort ((x, y) => x.key.localeCompare(y.key));

    // Per-layer aligned/drifted split of the matched pairs.
    bucket.aligned = bucket.inBoth.filter((e) => e.match === 'aligned').length;
    bucket.drifted = bucket.inBoth.filter((e) => e.match === 'drifted').length;

    layers[layerId] = bucket;
    onlyInA += bucket.onlyInA.length;
    onlyInB += bucket.onlyInB.length;
    inBoth  += bucket.inBoth.length;
    aligned += bucket.aligned;
    drifted += bucket.drifted;
  }

  return {
    a: packMeta(aLayered),
    b: packMeta(bLayered),
    summary: {
      onlyInA,
      onlyInB,
      inBoth,
      aligned,
      drifted,
      union: onlyInA + onlyInB + inBoth,
      aTotal: onlyInA + inBoth,
      bTotal: onlyInB + inBoth,
      jaccard: (onlyInA + onlyInB + inBoth) === 0
        ? 1
        : Math.round((inBoth / (onlyInA + onlyInB + inBoth)) * 100) / 100,
      // True alignment ratio: only structurally-equal matches count, over
      // the full union. Identity-only matches that drifted are excluded.
      alignment: (onlyInA + onlyInB + inBoth) === 0
        ? 1
        : Math.round((aligned / (onlyInA + onlyInB + inBoth)) * 100) / 100,
    },
    layers,
  };
}
