# Adapter — canonical → layered

The adapter (`tools/lib/adapter.mjs`) projects a canonical ObservabilityPack v1.2 manifest into the studio's layered display object. Pure ESM, no Node APIs — the Express server, the `npm run adapt` CLI, and (potentially) browser-side consumers all import the same module.

## Public API

```js
import { adapt, listEnvironments, applyEnvironmentOverlay } from './tools/lib/adapter.mjs';

const layered = adapt(canonical, { environment: 'staging' });
// layered = { id, name, badge, description, meta, layers: { L1, L2, L2X, L3, L4: {policy,alerting,healing}, L5, GOV } }

const envs = listEnvironments(canonical);
// e.g. ['prod', 'staging']

const { spec, effective } = applyEnvironmentOverlay(canonical.spec, 'staging');
// spec = deep-cloned spec with dotted-path overrides applied
// effective = { target, criticality, backendWiring }
```

## Layered output shape

```
{
  id: string,
  name: string,
  badge: string | undefined,            // e.g. "TIER-1"
  description: string,
  meta: {
    apiVersion, kind, binding, version,
    owners: string[],
    criticality, target,
    environment, environments,          // current + all
    backendWiring,                      // { signal-class: backend-id } from env
  },
  layers: {
    L1: artefact[],
    L2: artefact[],
    L2X: artefact[],                     // extended surfaces
    L3: artefact[],
    L4: { policy: artefact[], alerting: artefact[], healing: artefact[] },
    L5: artefact[],
    GOV: artefact[],
  },
}
```

Each `artefact` is:

```
{
  id: string,                            // family + index, e.g. "SLI-01"
  title: string,
  desc: string,                          // one-line summary
  tool: string,                          // implementation tool/family
  tags: string[],
  source: 'Declared' | 'Verified',       // 'Missing' added by Phase 3b conformance pass
  defines?: string,                      // symbol it defines, e.g. "slis.api_availability"
  refs?: string[],                       // symbols it references (for cross-ref checker)
  spec: object,                          // raw canonical section/item (drawer detail)
  mcp?: string,                          // verification timestamp from metadata.annotations.mcp.verified.<id>
}
```

## Mapping table

The adapter walks each top-level spec section into a deterministic family of layered artefacts:

| Canonical location | Layer | ID family | Notes |
|---|---|---|---|
| `spec.slis[]` | L1 | `SLI-{NN}` | `defines` = `slis.<id>` |
| `spec.slos[]` | L1 | `SLO-{NN}` | `refs` includes the SLI's symbol |
| `spec.otel` | L2 | `OTEL-01` | Single artefact summarising the OTel contract |
| `spec.telemetry.backends[]` | L2 | `BAK-{NN}` | `tags` include `signal`, `gating-{off\|warn\|enforce}`, `default` from `VersionSpec` |
| `spec.pipelines.receivers[]` | L2 | `PIP-RCV-{NN}` | |
| `spec.pipelines.processors[]` | L2 | `PIP-PRC-{NN}` | |
| `spec.pipelines.exporters.{metrics\|logs\|traces}` | L2 | `PIP-EXP-{MET\|LOG\|TRC}` | |
| `spec.storage.{metrics\|logs\|traces}` | L2 | `STO-{MET\|LOG\|TRC}-01` | |
| `spec.profiling` | **L2X** | `PROF-01` | RFC-0001 sibling layer |
| `spec.network` | **L2X** | `NET-01` | |
| `spec.policy_engine` | **L2X** | `POE-01` | |
| `spec.mesh[]` | **L2X** | `MESH-{NN}` | |
| `spec.collection[]` | **L2X** | `COL-{NN}` | |
| `spec.queries.recording_rules[]` | L3 | `QRY-{NN}` | `refs` extracted from `expr` via `ref:slis.X` regex |
| `spec.queries.derived_views[]` | L3 | `VIEW-{NN}` | |
| `spec.dashboards[]` | L3 | `DASH-{NN}` | `refs` from `panel_bindings.binds_to` (clickable in drawer) |
| `spec.policy.burn_rate_alerts[]` | L4 . policy | `POL-{NN}` | `refs` includes the bound SLO |
| `spec.policy.forecasts[]` | L4 . policy | `FCST-{NN}` | |
| `spec.alerting.routes[]` | L4 . alerting | `ALR-{NN}` | One per severity route |
| `spec.remediation[]` | L4 . healing | `HEAL-{NN}` | `refs` includes the trigger alert |
| `spec.baselines` | L5 | `BASE-01` | |
| `spec.validation.chaos_experiments[]` | L5 | `CHAOS-{NN}` | `refs` = steady-state SLO + each `expected_alerts` entry |
| `spec.validation.synthetic_checks[]` | L5 | `SYN-{NN}` | |
| `metadata.imports[]` | GOV | `IMP-{NN}` | |

## Cross-references and the symbol table

The client builds a symbol table from every artefact's `defines`. Each artefact's `refs` is classified:

- **Internal** (`slis.X`, `slos.Y`, `telemetry.backends.Z`, `dashboards.W`, …) — must resolve against the symbol table. Unresolved → red outline on the card + drawer warning + ⚠ marker.
- **External imports** (`ref:platform/...`, `ref:something/...@version`) — accepted without resolving.
- **Alert references** (`alert:<name>`) — accepted. Alerts aren't first-class symbols in v1.2 (alerting routes don't `defines:` anything); a future spec rev could change this.

`ref-link`s in drawer panels are clickable — clicking jumps to the defining artefact's drawer (switches active layer tab, opens it, scrolls into view).

## Environment overlay

When `spec.environments` is non-empty, `applyEnvironmentOverlay(spec, envName)`:

1. Deep-clones the spec (adapter is pure — no shared mutable state across env switches).
2. Applies `env.overrides` as **dotted-path writes** — `storage.metrics.retention: 13mo` rewrites `spec.storage.metrics.retention`.
3. Surfaces the env's `target`, `criticality`, and `backends` wiring as `effective`.

Downstream consumers (adapter + conformance scorer) read the env-overlaid spec, so `metadata.bindings.criticality` reflects the env's declared tier. A tier-1 service on its staging overlay is scored against tier-2 clauses.

## CLI form

```bash
node tools/adapt-spec-pack.mjs <pack.yaml> [--env <name>] [--pretty]
```

Outputs the layered JSON to stdout. Same module that the server and the studio use.

## Regression suite

`tools/test-adapt.mjs` exercises 41 assertions against the vendored canonical example — layer counts, `defines`/`refs` shape, gating tags, env overlay, adapter purity (no mutation across calls).

`tools/test-packs.mjs` runs the adapter against every `packs/*.pack.yaml`, validates schema + asserts pack-specific conformance bands.
