# otel-observability-pack-studio

> Engineering studio for **ObservabilityPack spec v1.2** manifests. Express
> server + thin vanilla-JS client. Renders the canonical spec into a layered
> view (L1 → L2 / L2X → L3 → L4 → L5 + GOV) for engineering buy-in and
> architectural review.

**Status:** v0.3 in progress. The spec v1.2 migration is happening in
phases — Phase 0–2 are merged (vendored spec, canonical validator, layered
adapter); Phase 3a (this) refreshes the studio onto a Node/Express
foundation. Phase 3b adds the drawer enrichment, ref checker, and
conformance panel. See `~/.claude/plans/hello-the-observabilitypack-spec-jolly-kahan.md` for the full plan.

---

## Architecture

```
server/index.mjs                          → Express server: validator + adapter + API
studio/{index.html, app.css, app.mjs}     → thin client; fetches /api/packs
tools/lib/{mini-yaml, adapter}.mjs        → shared ESM modules (also used by CLIs)
tools/{validate,adapt-spec,fetch-live,sync-spec}-pack.mjs  → CLIs
vendor/observability-pack-spec/v1.2/      → pinned canonical spec
```

## Quickstart

```bash
git clone <this repo>
cd otel-observability-pack-studio
npm install        # one dep: express
npm run dev        # serves http://127.0.0.1:8000
```

Open the URL. The studio loads the canonical example pack
(`vendor/observability-pack-spec/v1.2/examples/payment-service.pack.yaml`)
from the server and renders its 60+ artefacts across the layered model.

### API endpoints

| Method | Path | What it returns |
|---|---|---|
| `GET`  | `/healthz` | `{ ok, specVersion, schemaPath }` |
| `GET`  | `/api/packs` | Pack catalog (`id`, `name`, `version`, `criticality`, `environments`) |
| `GET`  | `/api/packs/:id?env=<name>` | Adapted layered display pack |
| `GET`  | `/api/packs/:id/canonical?env=<name>` | Raw canonical manifest with env overlay applied |
| `POST` | `/api/validate` | Validate uploaded JSON/YAML; returns errors or adapted pack |

---

## The 5-layer model

The studio is built around an **ObservabilityPack** — a structured inventory
of every artefact a production observability platform must own:

| Layer | What it answers | Example artefacts |
|---|---|---|
| **L1 · Contract** | "What does good look like?" | SLIs · SLOs · error-budget policy |
| **L2 · Telemetry** | "Produce, collect, persist." | scrapers · OTel collector · log shipping · retention |
| **L3 · Insight** | "Turn signal into understanding." | recording rules · dashboards · topology |
| **L4 · Action** | "When / where / what to do." | policy · alerting · self-healing |
| **L5 · Validation** | "Prove the loop." | chaos · synthetic · MTTD/MTTR · conformance |
| **Governance** | "Evidence everything above is working." | conformance score · audit trail · postmortems |

Each artefact carries a `source` tag — what kind of "fact" it represents:

| Source | Meaning |
|---|---|
| `BAU` | Claimed in the telemetry repo today |
| `SLA` | Externally driven — contractual reporting or audit evidence |
| `NEW` | On the target list to deploy |
| `GAP` | Required but not present |
| `PLANNED` | On the roadmap |
| `LIVE` | **Verified by MCP at refresh time** |

See [`docs/MODEL.md`](docs/MODEL.md) for the model in detail.

---

## What the studio shows

Four primary views in the top bar:

- **Current** — full inventory of the present state
- **Target** — the target end-state pack
- **Compare** — side-by-side diff with `added / gaps / retained` counts
- **Atlas** — four visualisations of the same comparison, four arguments:
  - **Stratigraphy** — geological cross-section. Jagged silhouette = present;
    clean parallelograms = target. Borrowed from USGS strata columns.
  - **Periodic Table** — Mendeleev's gaps. Every artefact gets a cell;
    empty dashed cells are *predicted gaps*.
  - **Constellation** — celestial atlas. Bright stars = running in production;
    dim stars = gaps. Slider morphs current sky → target sky.
  - **Skyline** — Tufte slopegraph. Each line is a layer; steepest line is
    the biggest delta.

See [`docs/ATLAS.md`](docs/ATLAS.md) for inspiration and design notes.

A fifth view, **Schema**, explains the layered model itself.

---

## Quickstart

```bash
git clone <this repo>
cd otel-observability-pack-studio

# Option A — just open the studio
python3 -m http.server 8000
open http://localhost:8000/studio/observabilitypack-studio.html

# Option B — also wire to a live MCP server
MCP_URL=https://your-mcp.example.com/observability \
OUTPUT=packs/production-live.json \
node tools/fetch-live-pack.mjs
# … then reload the studio. The header badge flips from
# "embedded snapshot" to "live · 0s ago".
```

Node 18+ for the fetcher (uses global `fetch`). Any modern browser for the
studio.

---

## Loading your own packs

Three ways:

1. **File picker (in-app).** Click `+ Load pack…` next to the dropdowns,
   pick one or more JSON files. Loaded packs replace embedded ones by `id`
   or get appended.
2. **Drag and drop.** Drop JSON files anywhere on the studio window.
3. **Pre-baked.** Drop pack files into `packs/`. The studio's loader tries
   `packs/production-live.json` at boot (configurable — see
   [`docs/MCP_INTEGRATION.md`](docs/MCP_INTEGRATION.md)).

Schema for valid packs: [`schema/pack.schema.json`](schema/pack.schema.json).
A minimal example: [`packs/demo-skeleton.json`](packs/demo-skeleton.json).

---

## Live wire-up — what the fetcher does

`tools/fetch-live-pack.mjs` talks to an MCP-exposed observability surface
via JSON-RPC over Streamable HTTP, maps the responses to ObservabilityPack
artefacts, and writes a single JSON file.

Tools it expects (best-effort):

| MCP tool | Populates |
|---|---|
| `system_health` | L2 collection · per-service liveness · health probes |
| `system_topology` | L3 topology · service inventory · Jaeger ingestion |
| `anomalies_active` | L4 anomaly alerting |
| `anomalies_baselines` | L5 validation (the partial anomaly coverage) |

Artefacts confirmed by MCP flip to `source: LIVE` and carry an `mcp` block
with refresh timestamp + evidence dict. Artefacts MCP cannot inspect stay
`BAU` with an `unverified` tag. Artefacts MCP confirms are *broken* (404,
isError) drop to `GAP` with the error captured.

See [`docs/MCP_INTEGRATION.md`](docs/MCP_INTEGRATION.md) for the wire details,
cron/CI recipes, and the per-environment override mechanism.

---

## Project layout

```
.
├── README.md                        ← you are here
├── LICENSE                          ← MIT
├── package.json
├── studio/
│   └── observabilitypack-studio.html   ← the single-file app
├── packs/
│   ├── production-curated.json         ← sample: hand-curated baseline
│   ├── production-live.json            ← sample: produced by the fetcher
│   ├── target-advanced.json            ← sample: target end-state
│   ├── demo-skeleton.json              ← minimal template
│   └── README.md
├── schema/
│   └── pack.schema.json
├── tools/
│   ├── fetch-live-pack.mjs
│   └── README.md
├── docs/
│   ├── MODEL.md            ← the 5-layer model
│   ├── ATLAS.md            ← the four visualisations
│   └── MCP_INTEGRATION.md  ← the live wire-up
└── .github/
    └── workflows/
        └── refresh-live-pack.yml   ← CI cron example
```

---

## Browser support

- Tested on current Chromium, Firefox, Safari.
- Requires SVG, CSS variables, ES2020.
- Google Fonts (IBM Plex Sans/Mono + Newsreader) load over the network;
  the studio is fully usable with system fonts if the network is offline.
- Works over `file://` for the embedded packs. Loading
  `packs/production-live.json` requires HTTP serving (any static server
  will do).

---

## License

MIT — see [LICENSE](LICENSE).

The 5-layer model is unencumbered and derives from publicly available
SRE / observability practice (Google SRE Workbook, OpenTelemetry, etc.).
The visual metaphors borrow from public-domain references: 19th-century
geological cross-sections (Cuvier, Lyell, USGS), Mendeleev's periodic
table, Cellarius/Hevelius celestial atlases, and Tufte slopegraphs.
