# Diff — structural artefact matching

`tools/lib/diff.mjs` performs **pack arithmetic**: set operations over the
artefact symbols of two adapted, layered packs. The studio consumes it as the
drift / gap view, and the server exposes it via
`GET /api/diff?a=<packId>&b=<packId>`.

The headline idea: comparing two packs is not "do they share the same names?"
It is "do the artefacts that share a name actually **agree**?" Identity is the
name on the door; **alignment** is the contents of the room. Diff answers both
questions, in that order.

## Two stages: identity, then agreement

### 1. Identity — `keyOf(artefact)`

Two artefacts "are the same artefact" when they share a **canonical key**. The
key is derived from canonical content, **not** from the positional `id` the
adapter assigns (those are pack-local — `SLI-01` in one pack and `SLI-07` in
another can be the same SLI).

- Artefacts the adapter already tagged with a `defines` symbol (SLIs, SLOs,
  backends, dashboards, derived views) reuse it directly.
- The rest synthesise a key from the canonical spec fields the adapter
  preserved on `artefact.spec` — e.g. a recording rule keys on
  `recording_rule:<name>`, an alert route on `alerting.route:<severity>`, a
  backend on `telemetry.backends.<id>`.
- Anything unrecognised falls back to `_unknown:<id>` so it stays pack-local
  and surfaces in `onlyInA` / `onlyInB` rather than crashing the comparison.

`keyOf` is the single source of truth for identity — extend it as the adapter
grows.

### 2. Agreement — `projectOf(artefact)` + `deltasOf(a, b)`

A shared key proves identity, not agreement. Two SLOs both named
`slos.api_availability_99` are the same contract; whether they're *aligned*
depends on whether their `objective`, `window` and SLI binding actually match.

`projectOf(artefact)` reifies an artefact into its **canonical comparable
projection** — the semantic spec definition with volatile, environment-specific
wiring removed. Two artefacts are **aligned** only when their projections are
structurally equal; otherwise they are **drifted**, and `deltasOf(a, b)` reports
exactly which top-level fields diverged, with each side's value.

#### Canonicalisation rules

`projectOf` runs the spec through `canonicalize`, which makes comparison
order-independent and contract-focused:

- **Object keys are sorted** so key order never masquerades as drift.
- **Arrays are normalised element-wise then sorted** so declaration order
  doesn't either.
- **Empty values are dropped** (`null`, `undefined`, `''`, `{}`) so an omitted
  field and an empty field compare equal.
- **`version` blocks collapse to `{ declared }`** — `gating` is an operational
  toggle, not part of the contract.
- **Volatile fields are stripped** before comparison (see below).

#### Volatile fields (`VOLATILE_SPEC_KEYS`)

These legitimately differ between a repo manifest and a live reconstruction of
the same artefact — they are deployment coordinates and presentation, not the
contract — so stripping them means "aligned" reflects the **semantic
definition**, not whether the URLs happen to agree:

```
endpoints, endpoint, url, address, host, auth,
description, desc, title, summary, annotations,
source, evidence, mcp, default
```

## Set operations

For each layer (`L1, L2, L2X, L3, L4, L5, GOV`) diff produces three buckets:

| Bucket     | Meaning                              | Set op  |
| ---------- | ------------------------------------ | ------- |
| `onlyInA`  | present in A, not B                  | A − B   |
| `onlyInB`  | present in B, not A                  | B − A   |
| `inBoth`   | matched pairs (shared key)           | A ∩ B   |

`inBoth` entries carry **both** sides plus the agreement verdict:

```js
{ key, a, b, match: 'aligned' | 'drifted', deltas: [{ field, a, b }] }
```

- `match: 'aligned'` — projections are structurally equal; nothing to do.
- `match: 'drifted'` — same identity, divergent content; `deltas` names the
  diverging fields and shows each side's value.

The classic identities still hold:

```
A ∪ B = onlyInA ∪ inBoth ∪ onlyInB
A ∩ B = inBoth
A − B = onlyInA
B − A = onlyInB
```

## Output shape

Example: `examples/target-advanced.pack.yaml` (A) vs
`examples/production-curated.pack.yaml` (B). Of the 18 artefacts that share a
key, only 3 actually agree — the other 15 carry the same identity but divergent
content, which `jaccard` alone would have hidden.

```jsonc
{
  "a": { /* pack meta */ },
  "b": { /* pack meta */ },
  "summary": {
    "onlyInA":  37,
    "onlyInB":  14,
    "inBoth":   18,    // shared identity (aligned + drifted)
    "aligned":  3,     // structurally equal pairs
    "drifted":  15,    // same identity, divergent content
    "union":    69,
    "aTotal":   55,    // onlyInA + inBoth
    "bTotal":   32,    // onlyInB + inBoth
    "jaccard":  0.26,  // inBoth / union — identity overlap (back-compat)
    "alignment": 0.04  // aligned / union — true agreement ratio
  },
  "layers": {
    "L2": {
      "onlyInA": [ { "key", "artefact" }, ... ],
      "onlyInB": [ { "key", "artefact" }, ... ],
      "inBoth":  [ { "key", "a", "b", "match", "deltas" }, ... ],
      "aligned": 3,    // count of aligned pairs in this layer
      "drifted": 10    // count of drifted pairs in this layer
    },
    // ... one entry per layer
  }
}
```

### `jaccard` vs `alignment`

Both are ratios over the union, and the difference is the whole point:

- **`jaccard` = `inBoth / union`** measures **identity overlap** — how many
  artefacts share a name. It treats a drifted pair as a match.
- **`alignment` = `aligned / union`** measures **true agreement** — how many
  shared artefacts actually have matching definitions.

A pack compared against itself scores `alignment: 1.0`. Two packs that share
many names but few definitions score a high `jaccard` and a low `alignment` —
which is exactly the drift signal you want.

## Backward compatibility

`inBoth` and `summary.jaccard` are unchanged in meaning and retained for
existing consumers (e.g. `server/test-smoke.mjs`). The structural verdict is
**additive**: `match` / `deltas` on each `inBoth` entry, and
`aligned` / `drifted` / `alignment` on the summary and per-layer buckets.

## Studio rendering

The drift view splits the matched column into **Aligned** and **Drifted**. The
Aligned% headline counts only structurally-equal matches, and the Drifted
column names the diverging fields per artefact so a reader sees not just *which*
artefacts drifted but *which fields* diverged.

## Public API

```js
import { keyOf, projectOf, deltasOf, diffPacks } from './tools/lib/diff.mjs';

keyOf(artefact);        // → canonical identity key (or null)
projectOf(artefact);    // → canonical comparable projection of artefact.spec
deltasOf(a, b);         // → [{ field, a, b }] of diverging projection fields
diffPacks(aLayered, bLayered); // → full diff (summary + per-layer buckets)
```
