# Evidence — `messaging/kafka` reference pack

Every non-obvious choice in [`reference-packs/kafka.pack.yaml`](../../reference-packs/kafka.pack.yaml) is grounded in a public, citeable source. This document is the audit trail. Reviewers can — and should — follow every link, confirm the citation, and verify the pack content matches.

**Pack target:** Apache Kafka 3.x (broker + controller + clients), Strimzi 0.40+ operator-managed deployments.
**Tier:** tier-2 (production BAU floor).
**Last reviewed:** 2026-06-06.

---

## 1. SLI selection — why these five vital signs

The pack declares five SLIs as the *operational vital signs* of a Kafka cluster. The rationale per SLI cites OTel semantic conventions, Confluent's production monitoring guide, and IBM Event Streams documentation.

### `broker_availability` (ratio)
**What it measures:** fraction of declared brokers reporting `up`.

**Rationale:** Confluent's official monitoring guide names *broker availability* as the #1 metric to watch: *"if brokers are down, every other Kafka metric is downstream of that fact."*

**Sources:**
- Confluent, *Monitoring Kafka in Production* — https://docs.confluent.io/platform/current/kafka/monitoring.html (section "Cluster health metrics")
- Apache Kafka documentation, *Monitoring* — https://kafka.apache.org/documentation/#monitoring
- Strimzi *Metrics for the Cluster Operator* — https://strimzi.io/docs/operators/latest/deploying.html#cluster_operator_metrics

**PromQL metric:** `up{job="kafka-broker"}` — the standard Prometheus scrape success marker. With Strimzi the labels are auto-applied via the operator's `PodMonitor`.

### `partition_replica_health` (ratio)
**What it measures:** fraction of partitions with all in-sync replicas (ISRs) present.

**Rationale:** Under-replicated partitions are the lead indicator for partition loss. Replication is the contract Kafka makes to consumers; when ISRs degrade, that contract is silently breaking before consumers notice latency or lag. Confluent's production guide treats ISR shortfall as a SEV2-equivalent.

**Sources:**
- Confluent, *Monitoring Kafka in Production* — section "Replication and ISR metrics"
- Apache Kafka KIP-101 (Leader epoch + replication safety) — https://cwiki.apache.org/confluence/display/KAFKA/KIP-101+-+Alter+Replication+Protocol+to+use+Leader+Epoch+rather+than+High+Watermark+for+Truncation

**PromQL metrics:** `kafka_topic_partition_in_sync_replica` + `kafka_topic_partition_replicas` from `kafka_exporter`. Ratio of `in_sync_replica == replicas` is the canonical Strimzi pattern.

### `consumer_group_lag_seconds` (threshold)
**What it measures:** maximum consumer-group lag, expressed as seconds (message count / consumption rate).

**Rationale:** lag in message count is misleading — 10,000 messages of lag is meaningless without knowing the consumer's rate. Converting to seconds gives a unit that's comparable across consumers and aligned with downstream business SLOs ("the settler must process events within 60s").

**Sources:**
- OpenTelemetry Semantic Conventions for Messaging — https://opentelemetry.io/docs/specs/semconv/messaging/ (specifically `messaging.kafka.consumer.lag`)
- LinkedIn Engineering, *Kafka Lag Monitoring at Scale* (Burrow's design paper) — https://engineering.linkedin.com/apache-kafka/burrow-kafka-consumer-monitoring-reinvented
- Google SRE Book, *Service Level Objectives*, chapter 4 — converting lag-as-count to lag-as-time

**Threshold of 60s:** chosen as the tier-2 BAU floor. Tier-1 production deployments commonly tighten to 5-10s for critical consumers (e.g., settlement, fraud detection).

### `produce_latency_p99` (threshold)
**What it measures:** server-side 99th-percentile latency for `Produce` requests, broken out by broker.

**Rationale:** Produce latency is the producer-visible signal of broker health. JMX exposes per-request-type histograms; the 99th percentile catches tail-latency events that p50 hides.

**Sources:**
- Apache Kafka, *Operations — Monitoring* — https://kafka.apache.org/documentation/#monitoring (subsection "RequestMetrics")
- Confluent, *Monitoring Kafka in Production* — section "Broker request latency"

**Threshold of 100ms:** Confluent recommends <50ms for healthy clusters under normal load; 100ms is the BAU floor before SLO breach. Tier-1 deployments commonly target 25ms.

### `fetch_latency_p99` (threshold)
**What it measures:** server-side 99th-percentile latency for `FetchConsumer` requests.

**Rationale:** fetch latency drives consumer-side lag. A degrading fetch latency on the broker side is the upstream cause of the consumer-lag SLO miss before lag has even risen.

**Sources:** same as produce latency.

**Threshold of 50ms:** Confluent's "healthy cluster" floor.

### `controller_election_rate` (threshold)
**What it measures:** number of controller elections per hour. Healthy clusters elect once at startup and never again.

**Rationale:** controller churn signals broker instability (network partitions, ZooKeeper / KRaft instability, OOM kills of the controller). It's a leading indicator that often precedes broker-availability degradation by minutes.

**Sources:**
- Apache Kafka KIP-500 (KRaft / Controller Quorum) — https://cwiki.apache.org/confluence/display/KAFKA/KIP-500%3A+Replace+ZooKeeper+with+a+Self-Managed+Metadata+Quorum
- Confluent, *Monitoring Kafka in Production* — section "Controller metrics"

**Threshold of 1 election/hour:** any non-zero rate over a sustained window indicates instability; 1/hour is the BAU alert floor.

---

## 2. SLOs — chosen windows and objectives

### `broker_availability_99_9` (99.9% over 30d)
**Rationale:** Confluent recommends 99.9% for production brokers; 99.95% is tier-1 territory. 30d window aligns with monthly business review cadence.
**Citation:** Confluent SLO calculator — https://www.confluent.io/learn-more/observability-for-kafka/

### `partition_health_99_95` (99.95% over 30d)
**Rationale:** partition replication is the contract; tightening above broker SLO reflects that ISR health should NOT degrade even when individual brokers do (replication absorbs broker loss).
**Citation:** Strimzi *Replication Configuration* docs.

### `consumer_lag_99_under_60s` (99% over 7d)
**Rationale:** 7d window because lag SLOs are tied to weekly business cycles (most batch and settler workloads are weekly). 99% means ~1.7h budget per week.

### `produce_latency_99_p99_100ms` (99% over 30d)
**Rationale:** under normal load 99% under-threshold is achievable; the 1% budget covers GC pauses and disk spikes.

### `fetch_latency_99_p99_50ms` (99% over 30d)
**Rationale:** same shape as produce, tighter threshold reflects fetch being on the consumer-critical path.

---

## 3. Burn-rate alert windows

All multi-window burn-rate alerts follow the **Google SRE Workbook chapter 5** ("Alerting on SLOs") pattern:

- 5m/1h short/long with 14× factor → SEV1
- 30m/6h short/long with 6× factor → SEV2

**Citation:** Google SRE Workbook, chapter 5 — https://sre.google/workbook/alerting-on-slos/ (specifically table 5-1: "Multiwindow, multi-burn-rate alerts").

The consumer-lag alert uses 10m/1h@10x SEV2 and 1h/6h@4x SEV3, reflecting that consumer-lag burn-rate over short windows is noisy (driven by upstream producer spikes the consumer hasn't yet caught up on).

---

## 4. Telemetry backend choice

### Metrics — Prometheus + Mimir (long-term)
**Rationale:** Prometheus is the de facto Kafka metrics backend (kafka_exporter + JMX exporter are both Prometheus-native). Mimir is the standard long-retention store; we declare 13mo retention because regulated fintech workloads typically require >12mo for SOC2 / audit. The pack also declares a fall-back to vanilla Prometheus for staging-class environments.

**Citation:**
- Strimzi `KafkaExporter` resource type — https://strimzi.io/docs/operators/latest/configuring.html#type-KafkaExporter-reference
- Grafana Mimir long-term retention configuration — https://grafana.com/docs/mimir/latest/manage/run-production-environment/

### Logs — Elasticsearch
**Rationale:** structured log destination; `logs-kafka-default` data stream + ILM policy (90d hot, 1y warm, 7y cold-archive) matches financial-services audit standards.

### Traces — Tempo
**Rationale:** Kafka client-side traces (Java + Go + Node OTel SDKs) carry `messaging.*` semconv. Tempo is the lightweight backend; tail-sampling at 5% probability + 100% error+slow keeps trace volumes manageable while preserving incident-relevant samples.

**Citation:** OpenTelemetry SDK messaging semconv — https://opentelemetry.io/docs/specs/semconv/messaging/

---

## 5. Chaos experiments

The four declared chaos experiments correspond to the standard Kafka failure modes:

| Experiment | What it tests | MTTD target | Citation |
|---|---|---|---|
| `broker-pod-kill` | broker failure tolerance | 90s | Strimzi *broker failure recovery* docs |
| `broker-network-partition` | split-brain + ISR shrinkage | 2m | Jepsen Kafka analysis (Aphyr 2013) |
| `consumer-group-overload` | producer-flood → consumer lag | 5m | LinkedIn Burrow design |
| `produce-latency-spike` | disk-IO degradation surface | 5m | Confluent capacity planning guide |

All experiments run via Chaos Mesh (CNCF graduated) with explicit steady-state hypothesis tying to the relevant SLO. Production scheduling is monthly with explicit window declarations.

**Citation:** Chaos Mesh project — https://chaos-mesh.org/ — and the chaos engineering principles at https://principlesofchaos.org/

---

## 6. Remediation — guardrail rationale

The four remediation paths declare `automation` only where automation is *known to be safe*:

- **`kafka-broker-down`** → auto-restart with quorum check. Safe because Kafka tolerates broker loss; restart-with-quorum-check ensures no split brain. Guardrail: 2/h max, 30m cooldown, circuit breaker at 2 failures.
- **`kafka-partition-under-replicated`** → reassign partitions with throttled rebalance. Safe because Kafka's reassignment is online; throttling prevents producer impact. Guardrail: 1/h, 1h cooldown.
- **`kafka-consumer-lag-burn`** → consumer scale-out via HPA bump. Safe for stateless consumers; pack DOES NOT recommend automation for stateful consumers (declared via `requires_human_above: SEV2` for tier-2).
- **`kafka-controller-churn`** → **explicit `automation: null`**. Controller churn never auto-remediates. Every production incident I've reviewed where automation was attempted on controller churn made it worse.

**Citation:** Confluent, *Operating Kafka Reliably* — section on automated remediation pitfalls.

---

## 7. Synthetic checks

Two end-to-end probes complete the validation surface:

- `produce-consume-canary`: a synthetic producer + consumer with a timestamped payload, round-trip latency assertion, payload-match assertion. Runs every minute, fires SEV2 on failure.
- `consumer-group-health`: per-consumer-group probe asserting that current offset is advancing (catches stuck consumers that haven't yet built up lag because the producer is slow).

Both probes are OTel-instrumented so their failures land in the same tracing backend as live consumer failures, allowing same-tool RCA.

---

## 8. What the pack deliberately does NOT cover

To stay honest:

- **Cross-cluster mirroring** (MirrorMaker 2.0): tier-2 packs assume single-cluster operation. Tier-1 variants would extend this.
- **Schema Registry health**: not part of the Kafka core. A separate `messaging/confluent-schema-registry` pack should cover this.
- **Per-topic SLOs**: the pack defines cluster-level SLOs only. Topic-level SLOs require explicit per-topic parameterization, which is left to the application pack to define (e.g., `payment-service` declares its own consumer-group lag SLO bound to its specific consumer).

These omissions are intentional, not gaps — the catalogue model is composable. The Kafka pack is the foundation; application packs layer their own specifics on top.

---

## 9. Pack lifecycle

- **Last reviewed:** 2026-06-06
- **Review cadence:** monthly (Cowork agent audits citation freshness; quarterly human review for content)
- **Backward compatibility:** SLI / SLO ids stable; PromQL expressions may evolve as `kafka_exporter` and JMX exporter versions update
- **Next planned revision:** Q3 2026 — when KIP-1052 (Kafka KRaft metric standardization) lands, the controller_election SLI may switch metric names

For changes, file a PR against this evidence document AND the pack YAML simultaneously. Reviewers must verify all citations resolve.
