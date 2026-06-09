# Runbook — Checkout journey degraded

> **Status:** declared target (scaffold). Replace every `TODO` with verified
> commands before this runbook is treated as `verified` in the drift view.

| | |
|---|---|
| **Trigger** | `alert:checkout-journey-degraded` |
| **Layer** | User Experience |
| **Default severity** | SEV2 |
| **SLO at risk** | `ux_checkout_journey_success_99`, `ux_page_load_p95_99` |
| **Automation** | `argo-workflow://rollback-ui-canary` |
| **Guardrails** | ≤2 invocations/hour · human approval above SEV2 · rollback on failure · 20m cooldown |
| **Validated by** | chaos experiment `checkout-journey-latency` · synthetic `ux-journey-checkout-canary` |

## What this means

The checkout journey success ratio (RUM) has dropped or page-load p95 has
crossed 2.5s. Real users are seeing a slow or failing checkout even if backend
SLOs still look green — this is the user-experience layer.

## Detect / confirm

1. `TODO`: RUM panel — `rum_journey_completed_total{journey="checkout"}` success vs total.
2. `TODO`: page-load p95 — `rum_page_load_duration_seconds_bucket{app="krystalinex-ui"}`.
3. Check the synthetic canary `ux-journey-checkout-canary` (grafana-synthetics):
   is it red? Which step fails?

## Diagnose

- Frontend vs backend: do server SLOs (`slo_http_requests_99`) look healthy?
  If yes → suspect the UI build / CDN / third-party script.
- `TODO`: correlate the failing journey step with traces (Jaeger/Tempo).
- Recent UI canary release? Check the rollout that preceded the alert.

## Remediate

`rollback-ui-canary` rolls the UI canary back to the last-good build.

1. If a UI canary deploy lines up with the regression → let `rollback-ui-canary`
   run (≤2×/hr), or trigger it manually (`TODO: argo rollouts undo`).
2. If backend-induced → branch to `krystalinex-core-error-burn` /
   `postgres-pool-exhausted`.
3. If third-party (payments widget, CDN) → `TODO`: enable fallback / feature-flag off.

## Rollback

`rollback_on_failure: true` — if the canary rollback doesn't restore the
journey success ratio within cooldown, it reverts to the prior rollout state.

## Escalate

- Page: GoAlert SEV2 route.
- Owner: `team-platform` · `carlos@krystaline.io`. Frontend on-call + comms if customer-facing checkout is down.
