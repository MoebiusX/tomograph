# Runbook — Postgres connection-pool exhausted

> **Status:** declared target (scaffold). Replace every `TODO` with verified
> commands before this runbook is treated as `verified` in the drift view.

| | |
|---|---|
| **Trigger** | `alert:postgres-connection-pool-exhausted` |
| **Layer** | Platform |
| **Default severity** | SEV2 |
| **SLO at risk** | `slo_settlement_latency_99` |
| **Automation** | `argo-workflow://recycle-db-connections` |
| **Guardrails** | ≤4 invocations/hour · human approval above SEV2 · rollback on failure · 10m cooldown |
| **Validated by** | chaos experiment `postgres-failover-drill` |

## What this means

The `krystalinex-postgres` connection pool is at/near saturation. New
connections are queuing or being refused, which shows up downstream as
settlement-latency burn and rising app error ratio.

## Detect / confirm

1. `TODO`: active vs max connections — `pg_stat_activity` count vs `max_connections`.
2. `TODO`: pool metrics — waiting clients, checkout latency (pgbouncer/pooler).
3. Identify the consumer holding connections (which service / query).

## Diagnose

- `TODO`: long-running / idle-in-transaction queries — `pg_stat_activity WHERE state = 'idle in transaction'`.
- `TODO`: lock contention — `pg_locks` joined to `pg_stat_activity`.
- Recent traffic spike or a leaking client (connections not returned)?

## Remediate

`recycle-db-connections` terminates idle-in-transaction sessions and recycles
the pooler so healthy capacity returns.

1. Kill clearly-stuck idle-in-transaction sessions (`TODO: pg_terminate_backend`).
2. Let `recycle-db-connections` run (≤4×/hr).
3. If saturation is from real load → scale the pooler / read replicas (`TODO`).

## Rollback

`rollback_on_failure: true`. Recycling is low-risk but if it drops healthy
sessions and worsens latency, revert pooler config (`TODO`).

## Escalate

- Page: GoAlert SEV2 route.
- Owner: `team-platform` · `carlos@krystaline.io`. DBA on-call if data-integrity risk.
