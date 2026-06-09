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
//   For each layer we produce these buckets:
//     - onlyInA  artefacts present in A but not B
//     - onlyInB  artefacts present in B but not A, in a family A also declares
//     - inBoth   matched pairs, with both A's and B's projection so the
//                  caller can show spec differences side-by-side
//     - outOfScope  present in B, in a family A declares NOTHING of — the rest
//                  of the platform's inventory, kept out of the drift headline
//
//   The classic operations follow:
//     A ∪ B  = onlyInA ∪ inBoth ∪ onlyInB
//     A ∩ B  = inBoth
//     A − B  = onlyInA
//     B − A  = onlyInB ∪ outOfScope

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
  let onlyInA = 0, onlyInB = 0, inBoth = 0, aligned = 0, drifted = 0, outOfScope = 0;

  for (const layerId of LAYER_ORDER) {
    const aItems = layerArtefacts(aLayered, layerId);
    const bItems = layerArtefacts(bLayered, layerId);

    const aByKey = groupByKey(aItems);
    const bByKey = groupByKey(bItems);

    // Kinds (artefact families) the declared side (A) actually participates in
    // for this layer. The behavioural key is `${kind}::${identity}`, so the
    // prefix is the family. When A contributes ZERO artefacts of a family, B's
    // artefacts of that family are out of the declared pack's SCOPE, not
    // actionable drift: comparing one service's declaration against a
    // whole-platform live inventory would otherwise flood "live, not declared"
    // with the entire fleet. Declare even one artefact of a family and the rest
    // of that family's live members become in-scope (genuine shadow signal).
    const aKinds = new Set();
    for (const k of aByKey.keys()) aKinds.add(k.slice(0, k.indexOf('::')));

    const bucket = { onlyInA: [], onlyInB: [], inBoth: [], outOfScope: [] };

    for (const [k, aGroup] of aByKey) {
      if (bByKey.has(k)) {
        matchGroups(k, aGroup, bByKey.get(k), bucket);
      } else {
        pushUnmatched(bucket.onlyInA, k, aGroup);
      }
    }
    for (const [k, bGroup] of bByKey) {
      if (aByKey.has(k)) continue;
      const kind = k.slice(0, k.indexOf('::'));
      if (aKinds.has(kind)) pushUnmatched(bucket.onlyInB, k, bGroup);
      else pushUnmatched(bucket.outOfScope, k, bGroup);
    }

    // Stable order — alphabetical by key — so the UI doesn't reshuffle on
    // every load.
    bucket.onlyInA.sort((x, y) => x.key.localeCompare(y.key));
    bucket.onlyInB.sort((x, y) => x.key.localeCompare(y.key));
    bucket.inBoth.sort ((x, y) => x.key.localeCompare(y.key));
    bucket.outOfScope.sort((x, y) => x.key.localeCompare(y.key));

    // Per-layer aligned/drifted split of the matched pairs.
    bucket.aligned = bucket.inBoth.filter((e) => e.match === 'aligned').length;
    bucket.drifted = bucket.inBoth.filter((e) => e.match === 'drifted').length;

    layers[layerId] = bucket;
    onlyInA += bucket.onlyInA.length;
    onlyInB += bucket.onlyInB.length;
    inBoth  += bucket.inBoth.length;
    aligned += bucket.aligned;
    drifted += bucket.drifted;
    outOfScope += bucket.outOfScope.length;
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
      // Live artefacts whose whole family the declared pack never mentions —
      // surfaced separately so the headline drift count isn't dominated by the
      // rest of the platform's inventory.
      outOfScope,
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

function groupByKey(items) {
  const out = new Map();
  for (const item of items) {
    const k = keyOf(item);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(item);
  }
  return out;
}

function matchGroups(baseKey, aGroup, bGroup, bucket) {
  const suffix = Math.max(aGroup.length, bGroup.length) > 1;
  let seq = 0;
  const unusedB = bGroup.map((b, i) => ({ b, i }));
  const usedA = new Set();

  // Pair exact behavioural matches first so a self-diff remains fully aligned
  // even when one pack contains duplicate identity keys.
  for (let ai = 0; ai < aGroup.length; ai++) {
    const bi = unusedB.findIndex(({ b }) => deltasOf(aGroup[ai], b).length === 0);
    if (bi === -1) continue;
    const [{ b }] = unusedB.splice(bi, 1);
    bucket.inBoth.push({
      key: occurrenceKey(baseKey, seq++, suffix),
      a: aGroup[ai],
      b,
      match: 'aligned',
      deltas: [],
    });
    usedA.add(ai);
  }

  const unusedA = aGroup
    .map((a, i) => ({ a, i }))
    .filter(({ i }) => !usedA.has(i));

  // Remaining items share identity but not the same contract. Pair each A with
  // the closest remaining B, then leave surplus controls visible as onlyInA/B.
  while (unusedA.length && unusedB.length) {
    const { a } = unusedA.shift();
    let best = 0;
    let bestDeltas = deltasOf(a, unusedB[0].b);
    for (let i = 1; i < unusedB.length; i++) {
      const d = deltasOf(a, unusedB[i].b);
      if (d.length < bestDeltas.length) {
        best = i;
        bestDeltas = d;
      }
    }
    const [{ b }] = unusedB.splice(best, 1);
    bucket.inBoth.push({
      key: occurrenceKey(baseKey, seq++, suffix),
      a,
      b,
      match: 'drifted',
      deltas: bestDeltas,
    });
  }

  for (const { a } of unusedA) {
    bucket.onlyInA.push({ key: occurrenceKey(baseKey, seq++, suffix), artefact: a });
  }
  for (const { b } of unusedB) {
    bucket.onlyInB.push({ key: occurrenceKey(baseKey, seq++, suffix), artefact: b });
  }
}

function pushUnmatched(target, baseKey, group) {
  const suffix = group.length > 1;
  group.forEach((artefact, i) => {
    target.push({ key: occurrenceKey(baseKey, i, suffix), artefact });
  });
}

function occurrenceKey(baseKey, index, suffix) {
  return suffix ? `${baseKey}#${String(index + 1).padStart(2, '0')}` : baseKey;
}
