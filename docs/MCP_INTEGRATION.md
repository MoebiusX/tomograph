# MCP Integration

How the studio talks to `otel-mcp-server` (or any MCP-exposing
observability surface), what the fetcher builds, and how to wire it on a
cron.

## What the fetcher produces

`tools/fetch-live-pack.mjs` builds a **canonical ObservabilityPack v1.2
manifest** from MCP responses, validates it against the vendored schema,
and writes it as YAML to `examples/production-live.pack.yaml`. The same path
shows up in the studio's pack catalog (`/api/packs`) under the id
`production-live`, so a refreshed pack is immediately visible to anyone
hitting the studio.

Phase 4 of the migration consolidated the output. There's no
`EMIT_FORMAT`, no studio-shape JSON. One file, one format, validated
before write.

## What lands as real content

| Pack section | Source from MCP |
|---|---|
| `spec.slis` / `spec.slos` | One ratio SLI + 99% / 30d SLO per service discovered by `system_health` |
| `spec.telemetry.backends` | `metrics-prom` + `logs-elastic` always; `traces-jaeger` marked verified when `system_topology` shows a jaeger edge |
| `spec.queries.recording_rules` | Discovered recording rules from MCP probes or metric inventory; a minimal synthesized fallback only when no rules are visible |
| `spec.policy.burn_rate_alerts` | `5m/1h@14x SEV1` + `30m/6h@6x SEV2` per SLO |
| `spec.baselines` | MTTD derived from `anomalies_baselines`' smallest threshold; MTTR from criticality default; `measurement_source: mcp.anomalies_baselines` |

## What stays minimum-viable

The schema requires all ten spec dimensions (`otel`, `slis`, `slos`,
`pipelines`, `queries`, `dashboards`, `policy`, `alerting`, `baselines`,
`validation`). Sections MCP cannot directly attest are populated with
the leanest stubs that still pass the validator — `otel.semconv` set to
the floor `1.26.0+`, `pipelines` with otlp receiver + batch processor +
three exporters, one stub dashboard, one stub SEV1 route.

The conformance scorer then surfaces what's NOT attested as honest
missing-MUST findings rather than the fetcher pretending compliance.

## Verification markers

`metadata.annotations` is `{string: string}` per the schema, so per-
artefact attestation lives as **flat keys**:

```yaml
metadata:
  annotations:
    mcp.refreshedAt: "2026-06-06T00:00:00Z"
    mcp.url: "https://mcp.example.com/observability"
    mcp.toolsCalled: "system_health,system_topology,anomalies_active,anomalies_baselines"
    mcp.toolsFailed: ""
    mcp.servicesDiscovered: "svc-checkout,svc-settler,svc-fraud"
    mcp.baselinesComputed: "2"
    mcp.activeAnomalies: "1"

    # per-artefact verification — adapter promotes these to source: Verified
    mcp.verified.otel: "2026-06-06T00:00:00Z"
    mcp.verified.slis.svc_checkout_availability: "2026-06-06T00:00:00Z"
    mcp.verified.telemetry.backends.metrics-prom: "2026-06-06T00:00:00Z"
    mcp.verified.telemetry.backends.traces-jaeger: "2026-06-06T00:00:00Z"
    mcp.verified.baselines: "2026-06-06T00:00:00Z"
```

The adapter checks for `mcp.verified.<symbol>` on each artefact's defining symbol and flips its source tag from `Declared` to `Verified` when present.

## Configuration

Env vars:

| Var | Default | Meaning |
|---|---|---|
| `MCP_URL` | `https://mcp.example.com/observability` | MCP server endpoint |
| `OUTPUT` | `examples/production-live.pack.yaml` | Where to write the YAML pack |
| `MCP_AUTH` | _(none)_ | Bearer token if your MCP requires auth |
| `PACK_NAME` | `production-live` | `metadata.name` of the produced pack |

```bash
MCP_URL=https://otel-mcp.internal/mcp \
MCP_AUTH=$MCP_TOKEN \
node tools/fetch-live-pack.mjs
```

## Deploying Back Through MCP

The Remediate deploy flow targets the `otel-mcp-server` Grafana write
tools directly:

| Tomograph artefact | MCP tool |
|---|---|
| Grafana-managed recording rules | `grafana_create_alert_rule` |
| Grafana-managed alerting rules | `grafana_create_alert_rule` |
| Grafana dashboards | `grafana_create_dashboard` |

Tomograph compiles rule artefacts to Grafana-managed provisioning YAML,
then converts each rule into the JSON model expected by
`grafana_create_alert_rule`. Deploy mode defaults to `upsert`, so retrying
a remediation is idempotent by UID.

For `otel-mcp-server`, writes require three separate pieces:

```bash
# On the MCP server:
MCP_ENABLE_WRITES=true
GRAFANA_URL=https://grafana.example.net
GRAFANA_AUTH_TOKEN=glsa_...   # service account token
MCP_AUTH_KEYS='{"keys":[{"id":"tomograph","key":"sk-tomograph-prod"}]}'
```

The Grafana token belongs on the MCP server, not in the browser. The
Tomograph deploy modal's **MCP client key** field should receive
`sk-tomograph-prod` when `MCP_AUTH_KEYS` is configured. Grafana rule
writes need `alert.provisioning:write`; dashboard writes need
`dashboards:write`; folder creation, if managed separately, needs
`folders:write`.

## MCP tools the fetcher uses

| Tool | Used for |
|---|---|
| `system_health` | discovered services → `metadata.bindings.service`, per-service SLIs, OTel + metrics-prom backend verification |
| `system_topology` | jaeger backend verification (if topology shows a jaeger edge) |
| `anomalies_active` | `mcp.activeAnomalies` annotation count |
| `anomalies_baselines` | derives `spec.baselines.mttd_target_p50` from smallest threshold; marks `baselines` verified |

Optional ZK tools (`zk_stats`, `zk_solvency`) are no longer probed — Phase 4 dropped them with the rest of the studio-shape baggage.

## Cron / CI

The included workflow runs every 15 minutes:

```yaml
# .github/workflows/refresh-live-pack.yml
on:
  schedule:
    - cron: '*/15 * * * *'
  workflow_dispatch:
  push:
    paths:
      - tools/fetch-live-pack.mjs
      - tools/lib/adapter.mjs
      - tools/lib/mini-yaml.mjs
      - tools/lib/validator.mjs

jobs:
  refresh:
    steps:
      - name: Fetch live pack from MCP
        env:
          MCP_URL:  ${{ secrets.MCP_URL }}
          MCP_AUTH: ${{ secrets.MCP_AUTH }}
          OUTPUT:   examples/production-live.pack.yaml
        run: node tools/fetch-live-pack.mjs

      - name: Commit if changed
        run: |
          git add examples/production-live.pack.yaml
          git rm --ignore-unmatch packs/production-live.json packs/production-live.pack.yaml   # legacy cleanup
          if git diff --quiet --cached; then echo "no changes"
          else
            git commit -m "chore(live): refresh $(date -u +%FT%TZ)"
            git push
          fi
```

Configure `MCP_URL` and (optionally) `MCP_AUTH` as repo secrets.

## Offline test

`tools/test-fetch-live.mjs` exercises the pack builder with two synthetic MCP scenarios — rich (services + topology + baselines) and empty (zero services, partial tool failures). Asserts schema validation, MCP annotations, verification markers, adapter integration, and YAML round-trip. Run as `npm run test:fetch`.
