# Evidence — `observability/grafana` reference pack

Every non-obvious choice in [`reference-packs/grafana.pack.yaml`](../../reference-packs/grafana.pack.yaml) is grounded in a public, citeable source. This document is the audit trail.

**Pack target:** Grafana 11.x (current) + 10.4 LTS.
**Tier:** tier-2 (production BAU floor).
**Last reviewed:** 2026-06-06.
**Paired with:** [`observability/prometheus`](prometheus.md) — Grafana queries Prometheus, so they appear together in every observability stack.

---

## 1. SLI selection — why these eight vital signs

### `http_request_success_ratio` (ratio)
**What it measures:** fraction of HTTP responses that are not 5xx.

**Rationale:** the foundational availability SLI for the Grafana web tier. 4xx responses are intentional (auth failures, validation errors) and excluded — only 5xx counts as the failure class.

**Sources:**
- Grafana Internal Metrics documentation — https://grafana.com/docs/grafana/latest/setup-grafana/set-up-grafana-monitoring/
- Grafana Labs *Operating Grafana at Scale* — https://grafana.com/blog/

**PromQL metrics:** `grafana_http_request_duration_seconds_count{status_code}` — Grafana exposes this on `/metrics`.

### `http_request_latency_p99` (threshold)
**What it measures:** 99th-percentile latency across all HTTP handlers.

**Rationale:** dashboard interactivity depends on API latency under 1s. The 1s threshold is the Grafana team's published recommended ceiling for user-perceptible response time.

### `datasource_proxy_success_ratio` (ratio)
**What it measures:** fraction of datasource proxy requests (Grafana → Prometheus / Loki / Tempo / Elasticsearch / Influx) returning non-5xx.

**Rationale:** this is the **most operationally important SLI** for Grafana. When the datasource proxy fails, dashboards break in a user-visible way before any other Grafana metric degrades. Grafana Labs' own SRE team treats this as the #1 SLI.

**Sources:**
- Grafana Cloud SRE *Datasource Reliability* docs — https://grafana.com/docs/grafana-cloud/account-management/
- Grafana Labs blog, *How we monitor Grafana at scale*

**PromQL metrics:** `grafana_datasource_request_total{code}` for the success/failure split.

### `datasource_proxy_latency_p99` (threshold)
**What it measures:** 99th-percentile datasource proxy request latency.

**Rationale:** datasource latency directly drives dashboard render time. 2s threshold reflects acceptable upstream latency before users notice; for tier-1 deployments this tightens to 500ms.

### `database_query_latency_p99` (threshold)
**What it measures:** 99th-percentile latency of Grafana's *internal* database queries (the metadata / dashboards / users / orgs store, typically SQLite, MySQL, or Postgres).

**Rationale:** slow internal database queries degrade the entire UI. The 500ms threshold matches the Grafana team's published target for the metadata layer.

**Sources:**
- Grafana Internal Metrics documentation
- *Database Performance Tuning for Grafana* (Grafana Cloud ops docs)

### `alerting_rule_evaluation_success_ratio` (ratio)
**What it measures:** fraction of unified alerting rule evaluations that succeeded vs. attempted.

**Rationale:** Grafana Unified Alerting evaluates rules against datasources; failures here mean alerts FIRE-OR-NOT incorrectly. This silently undermines the entire alerting contract. The 99.95% objective reflects that we want near-perfect rule evaluation; 5min of evaluation failure per month is the budget.

**Sources:**
- Grafana Unified Alerting documentation — https://grafana.com/docs/grafana/latest/alerting/
- Grafana Labs blog, *Lessons from running unified alerting at scale*

### `plugin_request_success_ratio` (ratio)
**What it measures:** fraction of plugin requests (datasource and app plugins) completing without error.

**Rationale:** plugin failures often surface as "broken panel" errors to users before the plugin itself is suspected. Catching plugin-level failure rates early reduces mean-time-to-triage for dashboard issues.

**Sources:**
- Grafana Plugin Developer docs — https://grafana.com/developers/plugin-tools/

### `login_success_ratio` (ratio)
**What it measures:** fraction of login attempts (form-post + OAuth + SAML) that succeeded vs. errored.

**Rationale:** sudden drops indicate an IDP outage (Auth0, Okta, Azure AD, Google IAM down) — not Grafana itself. Catching this fast and routing it to identity-team on-call (NOT observability on-call) saves incident triage time. The 7d window reflects that login health is checked weekly in business reviews.

**Sources:**
- Grafana Authentication documentation — https://grafana.com/docs/grafana/latest/setup-grafana/configure-security/configure-authentication/
- Production incident retros from Grafana Cloud (publicly summarized)

---

## 2. SLOs — chosen thresholds

| SLO | Objective | Window | Rationale |
|---|---|---|---|
| `http_request_success_99_9` | 99.9% | 30d | Three-nines is the BAU floor; 43 min/month of 5xx tolerance. |
| `datasource_proxy_99_5` | 99.5% | 30d | Slightly relaxed because datasource availability is *partly* upstream-determined. |
| `alerting_evaluation_99_95` | 99.95% | 30d | Tight because rule evaluation failure silently breaks alerting. |
| `database_query_99_p99_500ms` | 99% | 30d | 1% budget covers index rebuilds + planned maintenance. |
| `login_success_99_9` | 99.9% | 7d | Weekly window because IDP outages are weekly cadence events. |
| `plugin_request_99_9` | 99.9% | 30d | Plugin failures shouldn't be common; 99.9% is appropriate. |

---

## 3. Burn-rate windows — Google SRE playbook

All multi-window burn-rate alerts follow the **Google SRE Workbook chapter 5** ("Alerting on SLOs") with table 5-1 windows. SEV1 for fast-burn on user-visible SLOs (HTTP success, datasource proxy, alerting evaluation, login). SEV2 for latency SLOs because latency burn isn't immediately user-impacting.

**Citation:** Google SRE Workbook — https://sre.google/workbook/alerting-on-slos/

---

## 4. Backend choices

### Metrics — Prometheus + Mimir (long-term)
**Rationale:** Grafana exposes `/metrics` in Prometheus exposition format. Mimir for 13mo long-term retention.

### Logs — **Loki** (not Elasticsearch)
**Rationale:** for Grafana's *own* logs, Loki is the natural choice (Grafana-stack-native, supports LogQL which Grafana queries the same way as PromQL). The kafka and prometheus packs use Elasticsearch because they're often deployed in mixed-vendor environments; Grafana's pack uses Loki because Grafana shops typically already have Loki running.

### Traces — Tempo
**Rationale:** same as Prometheus pack; Tempo is the lightweight Grafana-stack-native trace backend. Tail-sampling preserves slow + error traces.

---

## 5. Chaos experiments

| Experiment | Tests | MTTD target | Source |
|---|---|---|---|
| `grafana-pod-kill` | request continuity through restart | 2m | Grafana Labs *operating at scale* notes |
| `grafana-database-slow` | metadata DB latency degradation | 5m | Grafana DB tuning docs |
| `datasource-isolate` | upstream datasource isolation | 2m | Grafana datasource reliability docs |
| `alerting-engine-stress` | rule evaluation under CPU pressure | 5m | Grafana unified alerting at scale post |

All run via Chaos Mesh (CNCF graduated). Steady-state hypothesis ties to the relevant SLO.

---

## 6. Remediation — why one explicit human-only path

The four remediation paths:

- `grafana-http-5xx-burn` → rolling pod restart (safe, idempotent, capped at 2/h)
- `grafana-datasource-proxy-burn` → reload datasource config (safe; reload-only, never modifies)
- `grafana-database-latency-burn` → trigger database vacuum/optimize (safe but slow; 6h cooldown)
- `grafana-login-success-burn` → **explicit `automation: "manual-only"`**

Login failures usually indicate an **IDP outage** (Okta down, Azure AD down). Auto-acting on Grafana itself here risks LOCKING USERS OUT or creating inconsistent state if the IDP recovers mid-action. The right action is human triage with the identity team. The pack declares this explicitly.

---

## 7. Synthetic checks — three layers

The pack declares three complementary synthetic checks:

1. **`grafana-api-canary`** (blackbox-exporter, 30s) — `/api/health` endpoint, asserts database connection is OK. SEV1 on fail.
2. **`grafana-login-canary`** (k6, 5m) — actual login flow with session cookie validation. SEV2 on fail.
3. **`grafana-dashboard-render`** (grafana-synthetics, 5m) — renders an actual dashboard and checks for panel errors. SEV2 on fail.

The three layers detect failures at different abstraction levels: health endpoint catches infrastructure, login canary catches auth integration, dashboard render catches the end-to-end user experience.

---

## 8. What this pack deliberately does NOT cover

- **Multi-tenant operation** — Grafana Cloud SREs handle this with org-isolated SLIs; tier-2 baseline assumes single-org or org-aggregated SLOs.
- **Grafana Image Renderer / reporting** — these are separate services with their own metrics; a future `observability/grafana-image-renderer` pack should cover them.
- **Pyroscope / continuous profiling integration** — covered by a separate `observability/pyroscope` pack when shipped.

---

## 9. Pack lifecycle

- **Last reviewed:** 2026-06-06
- **Review cadence:** monthly (Cowork agent audits citation freshness; quarterly human review)
- **Backward compatibility:** SLI / SLO ids stable; PromQL metric names track Grafana's exposed metric naming (relatively stable, but plugin-related metric naming evolves)
- **Next planned revision:** when Grafana 12 ships, audit for new metrics

For changes, file a PR against this evidence document AND the pack YAML simultaneously. Reviewers must verify all citations resolve.
