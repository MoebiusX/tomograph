# Runbook — krystalinex-core error-budget burn

> **Status:** declared target (scaffold). Replace every `TODO` with verified
> commands before this runbook is treated as `verified` in the drift view.

| | |
|---|---|
| **Trigger** | `alert:krystalinex-core-error-burn` |
| **Layer** | Application |
| **Default severity** | SEV1 / SEV2 (multi-window burn) |
| **SLO at risk** | `slo_http_requests_99`, `slo_availability_99` |
| **Automation** | `argo-workflow://restart-and-drain` |
| **Guardrails** | ≤3 invocations/hour · human approval above SEV1 · rollback on failure · 15m cooldown · circuit-breaker (2 failures / 1h) |
| **Validated by** | chaos experiment `krystalinex-core-error-injection` |

## What this means

The error-ratio burn-rate alert is firing: `kx-exchange` is returning 5xx (or
failing health) fast enough to threaten the 30-day error budget. Fast-window
(SEV1) means the budget could be exhausted in hours.

## Detect / confirm

1. Confirm the burn is real, not a single bad deploy or probe blip:
   - Grafana → *KrystalineX Unified Observability* → error-ratio panel.
   - `TODO`: PromQL — `slo:http_requests:error_ratio_5m` vs `..._1h`.
2. Check recent changes: last deploy, config push, feature flag.
3. Check upstream/platform: is this actually a Postgres / Kong / node issue
   surfacing as app errors? If so, branch to the matching runbook.

## Diagnose

- `TODO`: top failing endpoints — `sum by (route) (rate(http_request_errors_total[5m]))`
- `TODO`: correlate traces in Jaeger/Tempo for the failing route.
- `TODO`: check logs in Elasticsearch/Loki for the dominant error signature.

## Remediate

The declared automation `restart-and-drain` will: drain the unhealthy pods,
roll a restart, and re-admit traffic gradually.

1. If a bad deploy is the cause → roll back the release first (`TODO: argocd app rollback`).
2. Otherwise let `restart-and-drain` run (auto-invoked up to 3×/hr).
3. **Above SEV1, a human must approve** before automation proceeds.

## Rollback

`rollback_on_failure: true` — if the workflow worsens the SLI within the
cooldown, it auto-reverts. Manual: `TODO`.

## Escalate

- Page: GoAlert SEV1 route → on-call platform engineer.
- Owner: `team-platform` · `carlos@krystaline.io`.
