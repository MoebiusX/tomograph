# Recorded MCP response fixtures

Real responses recorded 2026-06-12 from the Krystaline otel-mcp-server,
trimmed for size (fewer rules / targets / dashboards / metric names) with
the field structure preserved verbatim — including authentic extras the
adapters must tolerate (`health`, `lastEvaluation`, a `down` target with a
populated `lastError`, dashboard `tags`/`folderUid`, …).

These are the contract-test inputs for `tools/test-contract-shapes.mjs`:
each fixture must satisfy its capability's declared response shape
(`tools/lib/contracts/response-shapes.mjs` — critical fields required,
extras allowed), and `adapt(fixture)` is pinned in `adapted/`.

| Fixture | Tool | Capabilities |
|---|---|---|
| `vmalert_rules.json` | `vmalert_rules` | recording_rules + alert_rules |
| `metrics_alerts.empty.json` | `metrics_alerts` | the legitimate-empty case (`{groups: []}` — the real VM-ruler response that motivated the cascade order) |
| `grafana_dashboards_search.json` | `grafana_dashboards_search` | dashboards |
| `metrics_targets.json` | `metrics_targets` | scrape_configs |
| `metrics_label_values.json` | `metrics_label_values` | metric_names |

## Re-recording

When an upstream MCP changes its payload shape on purpose: capture the new
response (any MCP client; the payload is the parsed `content[0].text` of the
`tools/call` result), trim it the same way, replace the fixture, then run

    node tools/test-contract-shapes.mjs --update

and review the `adapted/` diff — it is the canonical-fragment changelog of
the upstream change. If the shape check itself fails, the upstream removed
or renamed a critical field: update the shape row AND the adapter together,
in the same commit.
