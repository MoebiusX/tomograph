# MCP Integration

How the studio talks to `otel-mcp-server` (or any MCP-exposing observability
surface), what the fetcher does, and how to wire it on a cron.

The studio (`../studio/observabilitypack-studio.html`) ships with three embedded packs:
- `production-curated` — curated, hand-edited picture of production
- `production-live`   — live snapshot from `otel-mcp-server`
- `target-advanced` — target end-state

The **live** pack is special: it loads `../packs/production-live.json` at boot,
falling back to the embedded snapshot if the file is absent or unreachable.
The file is produced by `../tools/fetch-live-pack.mjs`, which talks to MCP over
the standard JSON-RPC / Streamable-HTTP wire protocol.

A liveness badge in the header reports the loader state — `live · 3m ago` /
`embedded snapshot` / `stale · 36h ago` / `MCP error`.

---

## Quickstart

```bash
# 1) Refresh the live JSON from the public MCP
node ../tools/fetch-live-pack.mjs

# 2) Serve the studio statically (CORS, file:// won't fetch siblings)
python3 -m http.server 8765
# open http://localhost:8765/../studio/observabilitypack-studio.html
```

Requires Node 18+ (global `fetch`).

---

## Configuration

The script is configured by env vars:

| Var        | Default                                         | Meaning                                  |
| ---------- | ----------------------------------------------- | ---------------------------------------- |
| `MCP_URL`  | `https://mcp.example.com/observability`          | MCP server endpoint                      |
| `OUTPUT`   | `../packs/production-live.json`                   | Where to write the JSON                  |
| `MCP_AUTH` | _(none)_                                        | Bearer token if your MCP requires auth   |

```bash
MCP_URL=https://otel-mcp.internal.kx/mcp \
MCP_AUTH=$KX_MCP_TOKEN \
OUTPUT=public/packs/production-live.json \
node ../tools/fetch-live-pack.mjs
```

The studio side is configured at load time. By precedence:

1. `?live=...` query parameter on the studio URL
   `…/studio.html?live=https://cdn.example.com/packs/production-live.json`
2. `window.OBSPACK_LIVE_URL` set before the inline script runs
3. The default: `../packs/production-live.json` next to the studio

That last one is what makes the file-portable demo work — drop the studio
and the `packs/` folder next to each other, serve them, done.

---

## Cron / CI refresh

The script is idempotent and side-effect-free except for the output file.
Run it on whatever cadence matches your project's appetite for freshness —
every 15 minutes for a war-room dashboard, hourly for a stakeholder portal,
nightly for an audit snapshot.

GitHub Actions example:

```yaml
name: refresh-live-pack
on:
  schedule:
    - cron: '*/15 * * * *'   # every 15 minutes
  workflow_dispatch:
jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - name: Refresh live pack
        env:
          MCP_URL:  ${{ secrets.OTEL_MCP_URL }}
          MCP_AUTH: ${{ secrets.OTEL_MCP_TOKEN }}
        run: node ../tools/fetch-live-pack.mjs
      - name: Commit if changed
        run: |
          git config user.name  github-actions
          git config user.email github-actions@github.com
          git add ../packs/production-live.json
          git diff --quiet --cached || git commit -m "chore(live): refresh $(date -u +%FT%TZ)"
          git push
```

Kubernetes CronJob example:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: refresh-obspack-live
spec:
  schedule: "*/15 * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: fetcher
              image: node:20-alpine
              command: ["node", "/app/tools/fetch-live-pack.mjs"]
              env:
                - name: MCP_URL
                  value: "http://otel-mcp.observability.svc.cluster.local:5000/mcp"
                - { name: OUTPUT, value: "/data/packs/production-live.json" }
              volumeMounts:
                - { name: app,  mountPath: /app, readOnly: true }
                - { name: data, mountPath: /data }
          volumes:
            - { name: app,  configMap: { name: obspack-studio } }
            - { name: data, persistentVolumeClaim: { claimName: obspack-static } }
```

---

## What gets verified, what stays unverified

The script flips selected artefacts from `BAU` → `LIVE` when MCP returns
matching evidence. The mapping (in `buildPack`):

| Artefact ID    | MCP tool              | When marked LIVE                       |
| -------------- | --------------------- | -------------------------------------- |
| `COL-02`       | `system_health`       | At least one service reporting healthy |
| `COL-03`       | `system_topology`     | A `*→jaeger` edge with non-zero calls  |
| `COL-05`       | `system_health`       | `lastPolled` present                   |
| `COL-X1..N`    | `system_health`       | One per discovered service             |
| `TOPO-X1`      | `system_topology`     | Any dependency edges returned          |
| `VAL-01`       | `anomalies_baselines` | One or more baselines computed         |
| `ALR-07`       | `anomalies_active`    | Detector enabled                       |
| `GOV-01`       | mcp.reachable         | Core tools reachable                   |

Artefacts that MCP cannot inspect (Prometheus scrape config, Loki shipping,
Grafana dashboards, Alertmanager rules) stay `BAU` and pick up a
`tags: ['unverified']` marker — the studio shows them in the BAU stripe,
but the drawer reads "claimed in repo but not directly verifiable from
MCP surface". That's the bit that surfaces honest scepticism.

Artefacts that MCP confirms are **broken** (404, isError) drop to `GAP`
with the error captured in `mcp.evidence`. Example: `GOV-02 (ZK proof
verification logs)` reports `httpStatus: 404, endpoint: /api/public/zk/stats`.

---

## Schema

The output JSON is a regular `Pack` object, identical in shape to the
embedded `packCurrent` / `packTarget`, with two additions:

```jsonc
{
  "id": "production-live",
  "name": "Production — Live (MCP)",
  "badge": "LIVE",
  "description": "...",

  // New: top-level metadata block read by the studio's liveness badge
  "liveness": {
    "refreshedAt": "2026-05-15T16:06:56.641Z",
    "mcpUrl":      "https://mcp.example.com/observability",
    "toolsCalled": ["system_health", "system_topology", "anomalies_active", "anomalies_baselines"],
    "toolsFailed": { "zk_stats": "...", "zk_solvency": "..." },
    "servicesDiscovered": ["order-service", "matching-engine", "wallet-service"],
    "baselinesComputed":  32,
    "activeAnomalies":    0,
    "embedded":           false       // true ⇒ this is the fallback baked
                                      //         into the studio file
  },

  "layers": {
    "L1": [ /* ...artefacts... */ ],
    "L2": [
      {
        "id":     "COL-02",
        "source": "LIVE",            // ← new source tag
        "title":  "OTel Collector pipeline",
        "desc":   "...",
        "tool":   "OTel Collector",
        "tags":   ["otel", "pipeline"],

        // New: per-artefact provenance
        "mcp": {
          "verified":    true,
          "source":      "system_health",
          "refreshedAt": "2026-05-15T16:06:56.641Z",
          "evidence":    { "services": 3, "totalSpans": 36, "healthyServices": 3 }
        }
      }
    ],
    /* L3, L4 (split), L5, GOV ... */
  }
}
```

The `mcp` field on individual artefacts feeds the drawer's "MCP EVIDENCE"
block. Anything you want auditable later (sample counts, last-polled
timestamps, derived rates) should go in `evidence`.

---

## Troubleshooting

**Badge stays on `embedded snapshot`.**
The fetch returned 404 or a network error. Common causes:
- Studio opened over `file://` — fetch can't reach sibling files. Serve it.
- `../packs/production-live.json` doesn't exist yet — run the script once.
- CORS — if you host the studio and JSON on different origins, set CORS
  headers on the JSON endpoint or use a same-origin reverse proxy.

**Badge reads `MCP error · <message>`.**
The JSON loaded but its `liveness.error` field is set. The script writes
this when a fatal failure happens. Re-run the script with `--verbose` (any
extra arg) and check stderr.

**Badge reads `stale · 36h ago`.**
The JSON loaded but `refreshedAt` is more than 24h old. Your cron isn't
running. Treat as a P3 — the studio still functions, just on older data.

**Script writes the file but the studio doesn't pick it up.**
Browser cache. The loader uses `cache: 'no-cache'`, but proxies might
still serve stale. Add a cache-busting param: `?live=…/production-live.json?v=<ts>`.
