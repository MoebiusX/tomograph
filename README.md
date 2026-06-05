# otel-observability-pack-studio

> Engineering studio for **ObservabilityPack spec v1.2** manifests. Express
> server + thin vanilla-JS client. Validates canonical packs, projects them
> into a layered display, scores them against the maturity rubric, and
> surfaces broken references — all from a single npm install.

The canonical spec lives at [MoebiusX/otel-observability-pack](https://github.com/MoebiusX/otel-observability-pack);
a checksumed copy is vendored under [`vendor/observability-pack-spec/v1.2/`](vendor/observability-pack-spec/v1.2/).

## Quickstart

```bash
git clone <this repo>
cd otel-observability-pack-studio
npm install            # single runtime dep: express
npm run dev            # http://127.0.0.1:8000
```

Open the URL. The studio loads the five bundled packs (one canonical
example, one tier-1 reference, one tier-2 partial baseline, one tier-3
minimum, plus the cron-managed live snapshot) and renders the first one
across the layered tabs L1 → L2 / L2X → L3 → L4 (policy · alerting ·
healing) → L5 → GOV, plus a **CONF** tab scoring it against the maturity
rubric.

## Architecture

```
vendor/observability-pack-spec/v1.2/           pinned upstream spec (checksumed)
  observability-pack.schema.json
  spec.md
  docs/maturity-model.md
  examples/payment-service.pack.yaml

server/
  index.mjs                                    Express server (validator + adapter + conformance API)
  test-smoke.mjs                               boots on ephemeral port, hits each route, asserts

studio/                                        thin vanilla-JS client
  index.html
  app.css                                      engineering-bench aesthetic, layer palette
  app.mjs                                      fetches /api/packs, renders, drawer + upload + ref checker

tools/lib/                                     shared ESM modules — browser-friendly, no Node APIs
  mini-yaml.mjs                                  parse() + emit() — round-trip verified
  validator.mjs                                  JSON Schema 2020-12 walker + v1.2 gatekeeper
  adapter.mjs                                    canonical → layered display projection + env overlay
  conformance.mjs                                29 rubric clauses from spec §5 + §7

tools/                                         CLIs
  validate-pack.mjs                              `npm run validate`
  adapt-spec-pack.mjs                            `npm run adapt -- <pack.yaml>`
  fetch-live-pack.mjs                            `npm run fetch-live` (cron-driven)
  sync-spec.mjs                                  `npm run sync-spec[:check]`
  test-{adapt,fetch,packs}.mjs                   regression suites

packs/                                         bundled canonical v1.2 manifests
  demo-skeleton.pack.yaml                        tier-3 minimum (100% MUST)
  production-curated.pack.yaml                   tier-2 partial BAU (86% MUST, honest gaps)
  target-advanced.pack.yaml                      tier-1 reference (100% MUST + 100% SHOULD)
  production-live.pack.yaml                      written by the refresh-live-pack cron
```

## API endpoints

| Method | Path | Returns |
|---|---|---|
| `GET`  | `/healthz` | `{ ok, specVersion, schemaPath }` |
| `GET`  | `/api/packs` | Catalog (`id`, `name`, `version`, `criticality`, `environments`) |
| `GET`  | `/api/packs/:id?env=<name>` | Adapted layered display pack |
| `GET`  | `/api/packs/:id/canonical?env=<name>` | Canonical manifest + env overlay applied |
| `GET`  | `/api/packs/:id/conformance?env=<name>` | Maturity-rubric scoring |
| `GET`  | `/api/maturity-rubric` | All 29 clause definitions (with `evaluate` stripped) |
| `POST` | `/api/validate` | Body = JSON or `text/yaml`; returns `{ok, errors[], adapted?, conformance?}` |

## Source tag taxonomy

Each layered artefact carries one of three source tags:

| Tag | Meaning |
|---|---|
| `Declared` | Section is present in the manifest. Default for everything the validator accepts. |
| `Verified` | A `metadata.annotations.mcp.verified.<symbol>` key is set on the canonical pack — i.e. an MCP run attested this artefact within the refresh timestamp. |
| `Missing` | Required for the declared `criticality` per the maturity rubric, but absent. Computed by the conformance pass (Phase 3b). |

`Verified` shows up automatically when the [refresh-live-pack workflow](.github/workflows/refresh-live-pack.yml) runs and writes attested-artefact annotations into `production-live.pack.yaml`.

## What the studio shows

- **Header strip** — `apiVersion · kind · binding · version · criticality · target · owners · environments`.
- **Pack & env selectors** — switching environment re-runs the adapter against the env-overlaid spec (dotted-path `overrides`, `target`, `criticality`).
- **Layer tabs** — L1, L2, L2X (extended surfaces — profiling, network, policy_engine, mesh, collection), L3, L4 (with sub-tabs for policy / alerting / healing), L5, GOV — plus a gold **CONF** tab.
- **Artefact cards** — id, title, source tag pill, version-gating chip on backends, ⚠ marker on cards with unresolved refs.
- **Drawer** — per-artefact-type structured panels (SLI query / SLO objective+window / backend endpoints + auth + version policy / dashboard panel_bindings with click-through / chaos fault + expected_alerts + MTTD / remediation guardrails / …) plus raw canonical YAML.
- **Cross-reference checker** — internal refs (`slis.X`, `slos.Y`, `telemetry.backends.Z`) must resolve. Broken refs render the source card with a red outline and surface in the drawer's *Broken references* section.
- **Conformance tab** — overall MUST% + SHOULD%; per-dimension pass/fail; full clause list with severity + applies-tier + spec section reference.
- **Upload** — drag-and-drop a `.yaml` / `.yml` / `.json` pack onto the studio, or click the **upload** button. Goes to `POST /api/validate`; pass → swap in the adapted result; fail → error panel with the validator findings.

## Loading your own packs

Three ways:

1. **Drop a file.** Drag a canonical `.yaml` / `.yml` / `.json` pack anywhere on the studio window (uses `POST /api/validate`).
2. **Catalog file.** Add to `packs/`, then add an entry to `PACK_CATALOG` in [`server/index.mjs`](server/index.mjs).
3. **API.** Hit `POST /api/validate` directly with the pack body for headless validation + adaptation.

The CLI variants of the same flow:

```bash
npm run validate -- path/to/pack.yaml
npm run adapt    -- path/to/pack.yaml --env staging --pretty
```

## MCP integration

`npm run fetch-live` (and the [refresh-live-pack workflow](.github/workflows/refresh-live-pack.yml) cron) builds a canonical v1.2 manifest from MCP responses, validates it against the vendored schema, and writes it as YAML to `packs/production-live.pack.yaml`. The fetcher is wired up but inert unless `MCP_URL` (and optionally `MCP_AUTH`) point to a real MCP. See [`docs/MCP_INTEGRATION.md`](docs/MCP_INTEGRATION.md) for the wire details, what gets verified, and how to extend it.

## Local development

```bash
npm install
npm run dev                            # serve on 127.0.0.1:8000

# CI parity — run any one or the full suite
npm run lint:fetcher  lint:adapter  lint:server  lint:studio
npm run sync-spec:check
npm run validate                       # canonical example
npm run test:adapt                     # 41 adapter assertions
npm run test:fetch                     # 36 fetcher assertions (offline)
npm run test:packs                     # round-trip for every packs/*.pack.yaml
npm run test:server                    # boots server on ephemeral port

# refresh the vendored spec from upstream main
npm run sync-spec                      # rewrites VERSIONS.json
npm run sync-spec:check                # CI-friendly drift check
```

Browser support: any modern browser (ES2020, CSS variables, SVG). Google Fonts (IBM Plex + Newsreader) load over the network; the studio is usable with system fonts if offline.

## License

MIT — see [LICENSE](LICENSE). The vendored spec content under `vendor/observability-pack-spec/` is upstream from [MoebiusX/otel-observability-pack](https://github.com/MoebiusX/otel-observability-pack).
