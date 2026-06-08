# Version-Aware Compilation — Product Profiles

> The compiler used to be version-blind. It hard-coded one shape per target —
> Grafana `schemaVersion: 41`, the OTel `logging` exporter, a fixed Alertmanager
> receiver — and emitted it no matter what version the pack declared. That makes
> the output a *heuristic*, not a faithful artefact: a dashboard compiled for
> "Grafana 9" came out identical to one for "Grafana 13", and a rule file with
> `keep_firing_for` would fail to load on a Prometheus older than 2.42 or on
> VictoriaMetrics. This document describes the profile system that fixes it.

## The two concerns, kept separate

There are two different jobs and they must not be conflated:

1. **Equality / drift** — *do two packs describe the same behaviour?* This is
   anchored on the **canonical spec**, which is version-independent. It lives in
   [`tools/lib/artefact-model.mjs`](../tools/lib/artefact-model.mjs) and is
   documented in [DIFF.md](DIFF.md). It deliberately does **not** call the
   compiler, so a compiler heuristic can never launder its way into the
   equality check.

2. **Deployment fidelity** — *will the emitted artefact actually load and behave
   on the target product+version?* This is the **compiler's** job, and it is
   what profiles add. A profile is the canon for one product at one version
   range.

`artefact-model.mjs` has no import of `compile.mjs`, and `profiles.mjs` has no
import of `artefact-model.mjs`. The two stay decoupled on purpose.

## The profile registry

[`tools/lib/profiles.mjs`](../tools/lib/profiles.mjs) is a registry keyed by
product. Each product lists **version bands** newest-first; each band carries a
semver `range` and a set of **knobs** — the things that genuinely differ across
versions and change what the running system accepts or does. Nothing cosmetic
goes in a knob.

`resolveProfile(product, version)` returns the first band whose range matches
the declared version; if none match (or no version is declared) it returns the
band flagged `default: true` and sets `matched: false` so the caller can surface
*"emitted for &lt;default&gt; because the declared version isn't profiled."*

A small pure-JS semver matcher (`satisfies`, `parseVersion`) drives selection so
the module stays browser-importable with zero dependencies — it never pulls in
the Node-only `semver` package.

### What each profile encodes (real, documented differences)

| Product | Version knob | Why it matters |
| --- | --- | --- |
| **Grafana** | `schemaVersion` (37 → 42), `datasourceForm` (`string` &lt; v10, `object` ≥ v10), `panelTargetDatasource` | Pre-v10 referenced datasources by bare uid string; v10+ requires `{type, uid}`. Emit the wrong form and panels fail to bind. |
| **Prometheus** | `keep_firing_for` (added in 2.42), `rule_query_offset` (3.x) | A rule file using `keep_firing_for` is rejected by Prometheus &lt; 2.42 and by VictoriaMetrics/vmalert. |
| **VictoriaMetrics** | `keep_firing_for: false` always | vmalert consumes Prometheus rule format but never supports `keep_firing_for`. |
| **OTel Collector** | `debugExporter` (`logging` → `debug` rename in 0.86), `telemetryMetricsReaders` (`address` deprecated for `readers`) | A config naming the wrong exporter fails to start on the target version. |
| **Alertmanager** | `msteamsV2` (`msteamsv2_configs` in 0.28), `msteams` (`msteams_configs` in 0.26) | Routing a Teams channel to a receiver the version doesn't have breaks the config. |
| **Grafana-managed rules** | `recordBlock`, `keepFiringFor`, `notificationSettings` | Unified-alerting rule shape evolved across Grafana 9 → 12. |

## How the compiler selects a version

The compiler reads the declared version straight from the pack — it does not
guess:

- **Grafana dashboard** → `spec.dashboards[].provider.version` (and `kind`).
- **Prometheus rules** → the `version.declared` of the backend serving the
  `metrics` signal (`spec.telemetry.backends[]` where `signal: metrics`).
- **Alertmanager** → the backend whose `product` matches `alertmanager`.
- **OTel Collector** → `spec.otel.collector.version` when present.

Any of these can be overridden explicitly with `compile(canonical, target,
{ product, version })` — e.g. a deploy UI that lets the engineer target a
specific install. The override always wins.

`compile()` returns the resolved profile alongside the output so callers can
show *which* product+version the artefact was shaped for:

```js
const out = compile(pack, 'grafana-dashboard');
// out.profile = { product:'grafana', version:'12.3', band:'grafana-12',
//                 label:'Grafana 12.x', tractability:'native', matched:true }
```

## Tractability — JS vs vendored Go schemas

This repo's hard constraint is that everything under `tools/lib/` is **pure ESM,
browser-importable, deps = `express` only**. The studio imports the compiler
directly in the browser. That bounds how faithfully each family can be modelled,
so every profile carries an honest `tractability` marker:

| Marker | Meaning | Families |
| --- | --- | --- |
| `native` | The version-determining shape is small and fully expressible in JS — we implement it faithfully. | Grafana dashboard (schemaVersion + datasource form) |
| `partial` | We model the high-impact knobs; the product's full schema is larger than we encode, and unmodelled fields pass through. | OTel Collector, Alertmanager, Grafana-managed rules |
| `vendored-go-needed` | **Faithful validation** requires the product's own Go schema/parser. We emit best-effort and flag it; we do **not** claim canonical fidelity. | Prometheus rules (`promtool`/`rulefmt`) |

### Why some families need vendored Go schemas

The observability canon is Go-first. The authoritative validators are:

- **Prometheus** — `rulefmt` / `promtool` parse and check rule files. There is
  no official JS port; PromQL parsing alone is a large grammar.
- **Grafana** — `@grafana/schema` is the dashboard schema, but it is heavyweight
  and churns release-to-release; vendoring it would break the no-deps /
  browser-importable constraint.
- **OTel Collector** — the config is validated by the Collector's own Go
  `confmap` unmarshaller against each component's struct tags.

We **shape** these artefacts correctly per version (the knobs above), which is
the part that determines whether they load. We do **not** claim to *validate*
them the way the vendored Go tool would. When that level of fidelity is needed,
it must run **server-side and be optional** — never imported into the browser
bundle. The `tractability` marker is the contract that keeps us honest about the
difference between "shaped for the version" and "validated by the canon."

## Adding a product or version band

1. Add a band to the product's `bands` array in `profiles.mjs`, newest-first,
   with a semver `range` and only behaviour-determining `knobs`.
2. If the product is new, register it under a new key and add aliases to
   `normalizeProduct`.
3. Thread any new knob into the relevant `compile*` function — gate the
   version-specific output on `profile.knobs.<knob>`.
4. Add an assertion to [`tools/test-profiles.mjs`](../tools/test-profiles.mjs)
   proving the compiler emits *differently* across the new boundary. A profile
   with no observable effect on the output is not a profile.

## Public API

From `tools/lib/profiles.mjs` (also re-exported from `compile.mjs`):

- `resolveProfile(product, version)` → frozen `{ product, family, tractability,
  version, band, label, knobs, matched }`.
- `listProfiles()` → every product and its version bands (for UIs / docs).
- `satisfies(version, range)`, `parseVersion(v)` → the semver primitives.

From `tools/lib/compile.mjs`:

- `compile(canonical, target, opts)` now accepts `opts.product` / `opts.version`
  overrides and returns `out.profile`.
- Every `compile*` function accepts an `opts` object and honours
  `opts.profile` (a pre-resolved profile) or resolves one from the pack.
- `listTargets()` entries now include `family`, the registry key used for
  profile resolution.
