// tools/lib/diff.mjs
//
// Pack arithmetic — set operations on the artefact symbols of two adapted
// layered packs. Pure ESM, no Node APIs, so the client could (and may, in
// a future restoration) call it directly.
//
// MATCHING
//   Two artefacts "are the same" when they share a behavioural identity —
//   NOT a name. The behavioural model (tools/lib/artefact-model.mjs) builds a
//   typed object per artefact family: an `identity` derived from what the
//   artefact DOES (a backend's product+signal, a metric's series name, a
//   rule's output series, a panel's binding target) and a `behavior` that
//   captures its full deployed contract. `identityKeyOf` pairs A↔B by
//   behaviour; `behaviorEqual` / `deltasOf` decide aligned vs drifted.
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

import {
  identityKeyOf,
  behaviorOf,
  deltasOf,
} from './artefact-model.mjs';

const LAYER_ORDER = ['L1', 'L2', 'L2X', 'L3', 'L4', 'L5', 'GOV'];

// Behavioural identity key for pairing A↔B. Delegates to the artefact model so
// matching is driven by what an artefact does, never by its name or position.
// Exported under the historical `keyOf` name for backward compatibility.
export function keyOf(artefact) {
  return identityKeyOf(artefact);
}

// The full behavioural contract object of an artefact — what "compare the
// contents" actually compares. Retained under the `projectOf` name for
// backward compatibility; delegates to the artefact model.
export function projectOf(artefact) {
  return behaviorOf(artefact);
}

// Re-export the behavioural delta helper so existing importers keep working.
export { deltasOf };

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
        // Same behavioural identity — now compare the full behavioural
        // contracts to decide whether they actually AGREE. Aligned only when
        // the behaviour objects are equal (no deltas); otherwise drifted, with
        // the diverging behavioural fields attached.
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
