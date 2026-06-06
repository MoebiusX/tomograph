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
  let onlyInA = 0, onlyInB = 0, inBoth = 0;

  for (const layerId of LAYER_ORDER) {
    const aItems = layerArtefacts(aLayered, layerId);
    const bItems = layerArtefacts(bLayered, layerId);

    const aByKey = new Map();
    const bByKey = new Map();
    for (const a of aItems) aByKey.set(keyOf(a), a);
    for (const b of bItems) bByKey.set(keyOf(b), b);

    const bucket = { onlyInA: [], onlyInB: [], inBoth: [] };

    for (const [k, a] of aByKey) {
      if (bByKey.has(k)) bucket.inBoth.push({ key: k, a, b: bByKey.get(k) });
      else               bucket.onlyInA.push({ key: k, artefact: a });
    }
    for (const [k, b] of bByKey) {
      if (!aByKey.has(k)) bucket.onlyInB.push({ key: k, artefact: b });
    }

    // Stable order — alphabetical by key — so the UI doesn't reshuffle on
    // every load.
    bucket.onlyInA.sort((x, y) => x.key.localeCompare(y.key));
    bucket.onlyInB.sort((x, y) => x.key.localeCompare(y.key));
    bucket.inBoth.sort ((x, y) => x.key.localeCompare(y.key));

    layers[layerId] = bucket;
    onlyInA += bucket.onlyInA.length;
    onlyInB += bucket.onlyInB.length;
    inBoth  += bucket.inBoth.length;
  }

  return {
    a: packMeta(aLayered),
    b: packMeta(bLayered),
    summary: {
      onlyInA,
      onlyInB,
      inBoth,
      union: onlyInA + onlyInB + inBoth,
      aTotal: onlyInA + inBoth,
      bTotal: onlyInB + inBoth,
      jaccard: (onlyInA + onlyInB + inBoth) === 0
        ? 1
        : Math.round((inBoth / (onlyInA + onlyInB + inBoth)) * 100) / 100,
    },
    layers,
  };
}
