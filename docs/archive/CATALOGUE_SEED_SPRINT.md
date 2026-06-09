# Catalogue Seed Sprint — concrete content plan

`docs/REFERENCE_CATALOGUE_PLAN.md` describes *how* the catalogue works
(repo structure, quality bar, Cowork agent, studio integration). This
doc describes *what's in it on day one* — the 5 reference packs we
hand-author or x-ray to seed the catalogue, with the evidence sources
each cites and the rubric scores each should hit.

The seed sprint is intentionally narrow: 5 packs covering the categories
the user keeps hitting in conversation (messaging, streaming, API
gateway, integration, file transfer) — not 50 covering everything. Once
the loop is proven on these, the Cowork agent can extend the library.

---

## Why these five

| Pack | Category | Why first |
|---|---|---|
| **Kafka** | Streaming | Best-documented OTel semantic conventions of any messaging system; community packs already exist to crib from; high resonance in fintech. |
| **IBM MQ** | Messaging | KrystalineX runs it in prod; internal expertise is already in the room. Differentiates from cloud-native-only competitors. |
| **Kong API** | API gateway | Clean public docs, OSS edition, used at every fintech with public APIs. The "I get gateway observability for free" demo moment is strong. |
| **IBM Integration Server** | Integration | Where legacy observability tooling falls down hardest. A canonical reference pack here is *valuable* in a way the others aren't — there's no good public answer today. |
| **MFT (Managed File Transfer)** | File transfer | Same gap as IIS. Audit-grade observability for batch and async file movement, rarely well-instrumented. SOX-flavored fintech requirement. |

Tier targeting: all five publish at **tier-2** (the BAU floor for
fintech) with one **tier-1 variant** per service for teams that need
the higher bar. Tier-3 isn't worth shipping — too thin to benchmark
against.

---

## Per-pack content sketch

Each pack ships with the canonical v1.2 sections below. The numbers
are the *minimum* required to score the targeted tier; real packs may
go deeper. `packc` regression-tests every pack at PR time.

### 1. `messaging/kafka/pack.yaml`

| Section | Content |
|---|---|
| `spec.slis` | broker availability · partition under-replicated count · consumer-group lag p99 · request latency p99 (produce + fetch) · topic message-loss rate |
| `spec.slos` | 99.9% / 30d on broker availability · ≤5min lag / 7d on critical consumer groups · 99% / 30d on partition health |
| `spec.queries.recording_rules` | `kafka:broker_availability:ratio_5m` · `kafka:partition_underreplicated:max_5m` · `kafka:consumer_lag_seconds:p99_5m` |
| `spec.policy.burn_rate_alerts` | 5m/1h@14x SEV1, 30m/6h@6x SEV2 on broker availability SLO; sticky-lag alert on consumer-group lag SLO |
| `spec.telemetry.backends` | metrics-prom (with `kafka_exporter` scrape config) · logs-elastic optional · traces-jaeger optional |
| `spec.dashboards` | broker overview · consumer-group lag · partition health |
| `spec.alerting.routes` | SEV1 → pagerduty · SEV2 → slack-platform · SEV3 → digest |
| `spec.validation.chaos_experiments` | kill-broker fault → expected alert: broker_availability_fast · expected MTTD 90s |

**Evidence sources** (cited in `EVIDENCE.md`):
- OpenTelemetry semantic conventions for messaging (`semconv/messaging.md`)
- Confluent's "Monitoring Kafka in Production" public guide
- Strimzi operator metrics expose list
- Confluent's recommended alert thresholds (community-validated)

**Target score**: tier-2 100% MUST, ≥85% SHOULD. tier-1 variant adds
end-to-end tracing assertions + chaos experiments per topic.

### 2. `messaging/ibm-mq/pack.yaml`

| Section | Content |
|---|---|
| `spec.slis` | queue manager availability · channel availability · queue depth · DLQ depth · message expiry rate |
| `spec.slos` | 99.9% / 30d QM availability · zero DLQ growth / 24h on critical queues · channel availability per channel |
| `spec.queries.recording_rules` | `mq:qm_availability:ratio_5m` · `mq:channel_availability:ratio_5m` · `mq:dlq_depth:max_5m` |
| `spec.policy.burn_rate_alerts` | QM-availability burn-rate (5m/1h@14x SEV1, 30m/6h@6x SEV2) · DLQ-depth threshold per queue |
| `spec.telemetry.backends` | metrics-prom (with `mq_exporter`) · logs-elastic (MQ error logs) · traces optional |
| `spec.dashboards` | QM overview · channel matrix · DLQ trend |
| `spec.alerting.routes` | SEV1 → pagerduty + email-ops · SEV2 → slack-platform |
| `spec.validation.chaos_experiments` | stop-channel fault → expected alert: channel_availability_fast · DLQ-fill fault → DLQ-depth alert |

**Evidence sources**:
- IBM MQ Knowledge Center monitoring section
- mq-metric-samples (IBM's official Prometheus exporter)
- IBM Redbook "IBM MQ — Performance Monitoring" (public)
- KrystalineX internal MQ ops runbook (cited as expert opinion, not
  linked publicly — we attest to it via `evidence.attestation`)

**Target score**: tier-2 100% MUST, ≥80% SHOULD. Honest gaps to flag:
trace integration is rare in MQ deployments; we declare it as
`recommended` not `required` for tier-2.

### 3. `integration/kong-api/pack.yaml`

| Section | Content |
|---|---|
| `spec.slis` | per-route latency p99 · per-route error rate · upstream availability · JWT validation failure rate · plugin error rate |
| `spec.slos` | 99% / 30d per-route latency under threshold · 99.5% / 30d availability per upstream · 99.99% / 7d JWT validation |
| `spec.queries.recording_rules` | `kong:route_latency:p99_5m{route=…}` · `kong:upstream_availability:ratio_5m{upstream=…}` |
| `spec.policy.burn_rate_alerts` | route-latency burn-rate per critical route · upstream-availability burn-rate per upstream |
| `spec.telemetry.backends` | metrics-prom (Kong's prometheus plugin) · logs-elastic (access log via http-log plugin) · traces-jaeger (zipkin plugin) |
| `spec.dashboards` | gateway overview · per-route SLO · upstream health |
| `spec.alerting.routes` | SEV1 → pagerduty-api · SEV2 → slack-api-platform |
| `spec.validation.synthetic_checks` | per-route health probe · JWT-validation probe |

**Evidence sources**:
- Kong's official Prometheus plugin docs
- Kong's "Observability Best Practices" public guide
- OpenTelemetry semantic conventions for HTTP (`semconv/http.md`)
- Kong Insomnia API Standards (public)

**Target score**: tier-2 100% MUST, ≥90% SHOULD. Kong is well-covered;
this should be the highest-scoring seed pack.

### 4. `integration/ibm-integration-server/pack.yaml`

| Section | Content |
|---|---|
| `spec.slis` | execution group health · message flow availability · broker availability · per-flow message rate · message processing latency p99 |
| `spec.slos` | 99.9% / 30d EG availability · message processing latency under threshold per flow · 99% / 30d broker availability |
| `spec.queries.recording_rules` | `iib:eg_availability:ratio_5m` · `iib:flow_latency:p99_5m{flow=…}` |
| `spec.policy.burn_rate_alerts` | EG-availability burn-rate · per-flow latency burn-rate for critical flows |
| `spec.telemetry.backends` | metrics-prom (IBM ACE Monitoring + custom Prometheus adapter) · logs-elastic (broker logs) · traces sparse — declared-not-verified |
| `spec.dashboards` | EG overview · per-flow latency · broker overview |
| `spec.alerting.routes` | SEV1 → pagerduty-integration · SEV2 → email-integration-ops |
| `spec.validation.chaos_experiments` | stop-EG fault → expected alert: eg_availability_fast |

**Evidence sources**:
- IBM ACE Knowledge Center monitoring section
- IBM ACE Resource Statistics public docs
- IBM Integration Server admin runbook (public chapters)
- KrystalineX internal IIS ops runbook (attestation)

**Target score**: tier-2 ~95% MUST (intentional honest gap: tracing
section uses placeholders because IBM ACE tracing is platform-dependent
and rarely standardized). Honest. The README + EVIDENCE.md call this
out so users see we don't pretend to cover what isn't standard.

### 5. `integration/mft/pack.yaml`

| Section | Content |
|---|---|
| `spec.slis` | transfer success rate · transfer queue depth · agent availability · per-protocol error rate (FTP / SFTP / FTPS / HTTPS) · transfer latency p99 |
| `spec.slos` | 99.9% / 30d transfer success rate · agent availability per agent · zero stuck transfers / 24h on critical agents |
| `spec.queries.recording_rules` | `mft:transfer_success:ratio_5m` · `mft:agent_availability:ratio_5m{agent=…}` |
| `spec.policy.burn_rate_alerts` | transfer-success burn-rate · agent-availability burn-rate per critical agent |
| `spec.telemetry.backends` | metrics-prom (MFT custom exporter) · logs-elastic (MFT audit logs) — SOX-compliant retention 7y |
| `spec.dashboards` | MFT overview · per-agent health · transfer-error breakdown |
| `spec.alerting.routes` | SEV1 → pagerduty-mft · SEV2 → email-mft-ops |
| `spec.validation.chaos_experiments` | stop-agent fault → expected alert: agent_availability_fast · network-partition fault → transfer-success burn-rate |

**Evidence sources**:
- IBM MQ MFT Knowledge Center
- AWS Transfer Family monitoring docs (cross-reference for protocol parity)
- OpenTelemetry semantic conventions for file transfer (proposal stage)
- SOX 404 control mapping for audit retention (general legal reference)

**Target score**: tier-2 ~90% MUST. MFT observability is the weakest
in the industry; this pack is *intentionally aspirational* —
benchmarking against it tells a team what good looks like even if
they're far from it.

---

## Authoring path

Three options per pack, in order of preference:

1. **x-ray a public reference implementation** — if a vendor or
   community ships a sample `docker-compose.yml` + Prometheus rules +
   dashboards for the platform, crawl that and refine.
2. **Cowork agent drafts from vendor docs + OTel semconv** — the agent
   reads the cited evidence sources, drafts a canonical pack, opens a
   PR. Human review tightens.
3. **Hand-author from KrystalineX internal expertise** — for IBM MQ
   and IIS specifically, KrystalineX runs both; the internal runbook
   gets distilled into the pack.

For the **demo** specifically, we don't need all 5 by Wednesday. **Two
is enough**: pick **Kafka** (easiest, best docs) and **IBM MQ**
(differentiates, KrystalineX expertise). Those two carry the "look at
this curated catalogue" demo beat. The remaining three ship over the
following two weeks via the Cowork agent loop.

---

## Sequencing for the demo

| When | What |
|---|---|
| **Today / Sunday** | Hand-author the Kafka + IBM MQ packs as canonical YAML in this repo's `examples/` directory (temporary home). Validate + conformance-score them locally with `npm run test:packs`. |
| **Monday morning** | Spin up the `MoebiusX/otel-observability-pack-catalogue` repo with the structure from `REFERENCE_CATALOGUE_PLAN.md`. Move the two packs in. Publish `CATALOGUE.json`. |
| **Monday afternoon** | Wire `/api/catalogue` in the studio. Surface "Reference (curated)" in the Pack B picker. |
| **Tuesday** | Author Kong API + IBM Integration Server packs (the legacy-stack story is the demo punchline). |
| **Tuesday evening** | Author MFT pack. |
| **Wednesday morning** | All 5 packs live, regression-tested, accessible from the studio. |

If we slip on Tuesday/Wednesday, the catalogue still demos with 2-3
packs. Don't ship a low-quality pack to hit a count.

---

## What we DON'T do for the seed sprint

- **No Cowork agent yet.** Agent comes online in Sprint 3 (per the
  catalogue plan). Seed authoring is human-driven so the quality bar
  is set high.
- **No per-product-version variants** (Kafka 3.6 vs 3.7). Evergreen
  `productVersion: "3.x"` ranges. Per-version packs come later if a
  user files a backlog request.
- **No automated evidence verification** — humans confirm citations
  during PR review for the seed packs. Agent verification is a
  Sprint-3 concern.

---

## See also

- [`docs/REFERENCE_CATALOGUE_PLAN.md`](REFERENCE_CATALOGUE_PLAN.md) — how the catalogue works
- [`docs/COMPOSE_MODE_PLAN.md`](COMPOSE_MODE_PLAN.md) — the drag-and-drop pack-authoring UI, which uses these catalogue packs as part of its block library
