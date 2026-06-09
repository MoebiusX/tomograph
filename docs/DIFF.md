# Diff — Behavioural Artefact Matching

`tools/lib/diff.mjs` compares two adapted, layered packs and powers the
drift/gap view exposed by `GET /api/diff?a=<packId>&b=<packId>`.

The comparison is directional: **A is the declared pack under review, B is the
reference or live pack**. Tomograph reports in-scope drift for A against B and
keeps unrelated live inventory in a separate `outOfScope` bucket.

## The Claim

Tomograph separates two questions:

1. **Identity:** is this the same control?
2. **Agreement:** do both sides declare the same contract for that control?

This is the core matcher claim that is safe to repeat: a shared identity does
not receive credit unless the comparable contract also aligns.

## Identity

`keyOf(artefact)` delegates to `tools/lib/artefact-model.mjs`, which classifies
each artefact family and builds a behavioural identity object. The adapter's
positional ids (`SLI-01`, `BAK-03`, `ALR-02`) are never identity.

Representative identities:

| Family | Identity |
|---|---|
| SLI / SLO | declared contract id, because other controls bind to it |
| Backend | `product + signal` |
| Metric | series name |
| Recording rule | output series name |
| Dashboard | declared dashboard id |
| Panel | dashboard parent + `binds_to` target |
| Pipeline receiver/processor | stage name |
| Pipeline exporter | signal + exporter kind |
| Alert route | severity, with duplicate identities preserved |
| L2X profiling/network/policy | product |
| L2X mesh/collection | product + role |

The precise phrasing matters: Tomograph matches on behaviour. For reliability
contract artefacts, the declared id is the behavioural handle by design.

## Collision Handling

Multiple artefacts in one pack can share the same identity key: multiple SEV2
routes, duplicate dashboard ids, or more than one Prometheus metrics backend.
`diffPacks` groups by identity instead of using a last-write-wins `Map`.

Within each identity group it:

1. Pairs exact behavioural matches first.
2. Pairs remaining same-identity artefacts as drifted, choosing the closest
   remaining contract.
3. Leaves surplus controls visible as `onlyInA` or `onlyInB`.

Duplicate entries receive stable occurrence suffixes such as
`alert_route::{"severity":"sev2"}#02`, so counts preserve artefacts instead of
collapsing them to identity classes.

## Agreement

`projectOf(artefact)` returns the canonical comparable contract, and
`deltasOf(a, b)` reports top-level fields that differ. A matched pair is:

```js
{ key, a, b, match: 'aligned' | 'drifted', deltas }
```

`aligned` means the declared contract matches after normalisation. It does not
mean byte-identical source.

Normalisation rules:

- Object keys are sorted.
- Arrays are normalised element-wise, sorted, and empty arrays are treated like
  absent fields.
- Empty `null`, `undefined`, `''`, `{}`, and `[]` values are dropped.
- Expressions in `expr`, `query`, `promql`, and `expression` collapse
  whitespace only. Tomograph does not do semantic PromQL equivalence.
- `version` blocks compare by `declared` when present.
- Deployment/presentation fields are stripped:

```text
endpoints, endpoint, url, address, host, auth,
description, desc, title, summary, annotations,
source, evidence, mcp, default, folder, provider
```

## Buckets

Each layer (`L1`, `L2`, `L2X`, `L3`, `L4`, `L5`, `GOV`) contains:

| Bucket | Meaning |
|---|---|
| `onlyInA` | A declares it; B does not have an in-scope counterpart |
| `onlyInB` | B has it in a family A participates in; A does not |
| `inBoth` | same identity on both sides, with `aligned` or `drifted` verdict |
| `outOfScope` | B has it, but A declares nothing in that artefact family |

`outOfScope` prevents a single-service drift view from being flooded by the
rest of a platform's live inventory. It is reported, but excluded from the
in-scope ratios.

## Summary Ratios

`union = onlyInA + onlyInB + inBoth` is the **in-scope** union. `outOfScope` is
reported separately.

- `jaccard = inBoth / union`: identity overlap.
- `alignment = aligned / union`: true agreement ratio.

The strongest diagnostic signal is the gap between them: high Jaccard and low
alignment means Tomograph found the same controls, but their definitions drift.

## Public API

```js
import { keyOf, projectOf, deltasOf, diffPacks } from './tools/lib/diff.mjs';

keyOf(artefact);              // behavioural identity key
projectOf(artefact);          // comparable contract projection
deltasOf(a, b);               // top-level contract deltas
diffPacks(aLayered, bLayered); // directional drift report
```

## Regression Coverage

`tools/test-diff.mjs` verifies:

- pack-vs-self preserves every artefact, including duplicate identity keys;
- duplicate SEV2 routes survive as distinct controls;
- surplus duplicate controls are reported as drift rather than dropped;
- empty arrays normalise like absent fields.
