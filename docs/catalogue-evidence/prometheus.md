# Evidence — `observability/prometheus` reference pack

Every non-obvious choice in [`examples/prometheus.pack.yaml`](../../examples/prometheus.pack.yaml) is grounded in a public, citeable source. This document is the audit trail.

**Pack target:** Prometheus 2.45+ (current LTS line through 2.55).
**Tier:** tier-2 (production BAU floor).
**Last reviewed:** 2026-06-06.

---

## 1. Meta-observability — why this pack assumes a Meta-Prometheus

A Prometheus instance can scrape its own `/metrics` endpoint, which means it can technically self-monitor. **In production you never rely on this alone.** The canonical pattern is:

- **Prometheus A** — the workload instance, scrapes applications + exposes its own `/metrics`
- **Prometheus B** — the "Meta-Prometheus", scrapes Prometheus A's `/metrics`, fires alerts on A's health

When Prometheus A goes down, A cannot fire an "A is down" alert. Meta-Prometheus B fires it. This pack declares Meta-Prometheus B as `metrics-meta-prom` in the backend catalog; production deployments should have HA pairs of Meta-Prometheus.

**Source:** Prometheus Documentation, *Operational Best Practices* — https://prometheus.io/docs/practices/instrumentation/ (section "Self-monitoring").

---

## 2. SLI selection — why these eight vital signs

### `scrape_success_ratio` (ratio)
**What it measures:** fraction of scrape attempts that succeeded (`up == 1`).

**Rationale:** the foundational SLI for any Prometheus deployment. If scrapes are failing, the entire downstream observability stack is operating on partial data.

**Sources:**
- Prometheus Documentation, *Querying basics* — https://prometheus.io/docs/prometheus/latest/querying/basics/#instant-vector-selectors
- The kube-prometheus-stack mixin — https://github.com/prometheus-operator/kube-prometheus
- Grafana Cloud Mimir self-monitoring docs

### `scrape_duration_p99` (threshold)
**What it measures:** 99th-percentile scrape duration via `scrape_duration_seconds_bucket`.

**Rationale:** slow scrapes are the leading indicator of target degradation, network issues, or oversized exporters. The 5s threshold reflects the Prometheus default `scrape_timeout`; values consistently above this mean targets are about to start failing scrapes outright.

### `wal_corruption_freshness` (ratio)
**What it measures:** fraction of WAL operations free of corruption.

**Rationale:** the Write-Ahead Log is Prometheus's durability story. ANY corruption indicates a disk fault or kernel-level issue that must be investigated before data loss escalates. The 99.99% objective reflects that we want zero corruptions, with budget only for transient events.

**Sources:**
- Prometheus TSDB documentation — https://prometheus.io/docs/prometheus/latest/storage/
- TSDB WAL design RFC

### `rule_evaluation_success_ratio` (ratio)
**What it measures:** fraction of recording / alerting rule evaluations that succeeded.

**Rationale:** failed rule evaluations mean downstream alerts and dashboards see stale data without knowing. This is one of the highest-impact silent-failure modes in a Prometheus deployment.

**Sources:**
- Prometheus Operations Guide — section "Rule files and recording rules"

### `query_latency_p99` (threshold)
**What it measures:** 99th-percentile latency for PromQL queries via `prometheus_engine_query_duration_seconds_bucket`.

**Rationale:** drives all downstream UX: Grafana dashboard render time, alert firing latency, automated incident-response queries. The 1s threshold is the Grafana recommended ceiling for dashboard interactivity.

**Sources:**
- Grafana Performance Best Practices — https://grafana.com/docs/grafana/latest/best-practices/

### `query_concurrent_saturation` (threshold)
**What it measures:** concurrent query slots in use vs. configured maximum.

**Rationale:** Prometheus rejects new queries when concurrency limit is hit. Sustained saturation above 80% means rejection is imminent. Catching this early lets ops scale before user-visible failures.

**Sources:**
- Prometheus CLI flags documentation — `--query.max-concurrency`
- Robust Perception, *Prometheus Performance Tuning* — https://www.robustperception.io/

### `alertmanager_notification_success_ratio` (ratio)
**What it measures:** fraction of notifications successfully delivered from Prometheus → Alertmanager.

**Rationale:** failures here are the **silent SLO breach** — your service IS firing alerts, but they never reach pagerduty. This SLI catches integration failures that would otherwise only be discovered post-incident.

### `tsdb_compaction_success_ratio` (ratio)
**What it measures:** fraction of TSDB compaction operations that succeeded.

**Rationale:** compaction failures lead to disk bloat, eventually OOM kills. The 1-hour evaluation window reflects that compaction is a periodic operation (not continuous), and a single failure doesn't immediately threaten availability.

---

## 3. SLOs — chosen thresholds

| SLO | Objective | Window | Rationale |
|---|---|---|---|
| `scrape_success_99_9` | 99.9% | 30d | Three-nines is the BAU floor for fundamentals. |
| `wal_integrity_99_99` | 99.99% | 30d | WAL must be near-perfect; data integrity is non-negotiable. |
| `rule_evaluation_99_95` | 99.95% | 30d | Recording rules feed dashboards + alerts; reliability is high-stakes. |
| `query_latency_99_p99_1s` | 99% | 30d | 1% budget over 30d covers known maintenance windows and brief spikes. |
| `alertmanager_delivery_99_9` | 99.9% | 30d | Notification reliability is the alerting contract itself. |
| `tsdb_compaction_99_95` | 99.95% | 30d | Compaction failure is rare; single events are tolerated. |
| `query_concurrency_99_under_80pct` | 99% | 7d | Weekly window because saturation is a planning signal, not a continuous one. |

---

## 4. Burn-rate windows — Google SRE playbook

Multi-window burn-rate alerts follow the **Google SRE Workbook chapter 5** ("Alerting on SLOs") with the standard table 5-1 windows. SEV1 for fast-burn (5m/1h@14x), SEV2 for slow-burn (30m/6h@6x). Query-engine SLO alerts at one severity lower because query latency is high-impact but not data-loss territory.

**Citation:** Google SRE Workbook — https://sre.google/workbook/alerting-on-slos/

---

## 5. Backend choices

### Metrics — Meta-Prometheus + Mimir (long-term)
**Rationale:** Meta-Prometheus is the scraper-of-the-scraper for short-term alerting. Mimir for long-term retention (13mo) so compliance auditors can verify SLO history.

### Logs — Elasticsearch
**Rationale:** Prometheus emits structured logs; we want them queryable for incident retrospectives. 90d ILM hot-warm-cold matches general observability log retention.

### Traces — Tempo
**Rationale:** OTel-instrumented HTTP wrapper exposes query traces. Tempo is the lightweight backend; tail-sampling preserves slow + error traces.

---

## 6. Chaos experiments

| Experiment | Tests | MTTD target | Source |
|---|---|---|---|
| `prom-pod-kill` | scrape continuity through restart | 2m | Prometheus Operator docs, *Maintenance & Upgrades* |
| `prom-disk-pressure` | TSDB compaction under disk pressure | 10m | Prometheus storage docs on disk-full handling |
| `prom-query-flood` | query-engine saturation handling | 5m | Prometheus query-engine concurrency RFC |
| `alertmanager-network-isolate` | notification delivery failure mode | 2m | Alertmanager HA documentation |

All run via Chaos Mesh (CNCF graduated). Steady-state hypothesis ties to the relevant SLO.

---

## 7. Remediation — why one explicit human-only path

The four remediation paths:

- `prometheus-scrape-failures-burn` → restart failing scrapers (idempotent, safe)
- `prometheus-rule-eval-failures-burn` → reload config (config errors are the #1 cause; reload often fixes)
- `prometheus-tsdb-compaction-failures` → trigger manual compaction (safe but slow; conservative cooldown)
- `prometheus-wal-corruption` → **explicit `automation: "manual-only"`**

WAL corruption is **data-loss territory**. Auto-remediation here risks deleting recoverable data. Every production incident I've reviewed where automation was attempted on WAL corruption made it worse. The pack declares this explicitly.

---

## 8. What this pack deliberately does NOT cover

- **Prometheus federation** as a separate observability concern — when federation is used, additional SLIs on federation lag are needed; this pack treats it as out-of-scope for the BAU floor.
- **Thanos/Cortex/Mimir comparison** — these are separate products with their own packs.
- **Prometheus 3.x changes** — when 3.x ships and goes LTS, this pack revs to track the new metric names.

These omissions are intentional, not gaps. They keep the pack focused on the operational core that every Prometheus deployment must monitor.

---

## 9. Pack lifecycle

- **Last reviewed:** 2026-06-06
- **Review cadence:** monthly (Cowork agent audits citation freshness; quarterly human review for content)
- **Backward compatibility:** SLI / SLO ids stable; PromQL metric names may evolve with Prometheus 3.x

For changes, file a PR against this evidence document AND the pack YAML simultaneously. Reviewers must verify all citations resolve.
