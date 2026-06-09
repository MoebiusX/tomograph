# Runbook — K8s node disk pressure

> **Status:** declared target (scaffold). Replace every `TODO` with verified
> commands before this runbook is treated as `verified` in the drift view.

| | |
|---|---|
| **Trigger** | `alert:k8s-node-disk-pressure` |
| **Layer** | Infrastructure |
| **Default severity** | SEV2 |
| **SLO at risk** | `slo_latency_99` (noisy-neighbour eviction risk) |
| **Automation** | `argo-workflow://cordon-and-evict` |
| **Guardrails** | ≤2 invocations/hour · human approval above SEV2 · **no auto-rollback** · 30m cooldown |
| **Validated by** | chaos experiment `k8s-node-cpu-stress` |

## What this means

One or more nodes in `krystalinex-nodepool` report `DiskPressure`. The kubelet
may start evicting pods; if kx pods are evicted, latency and availability SLOs
are at risk.

## Detect / confirm

1. `TODO`: which nodes — `kubectl get nodes -o wide`; `kubectl describe node <n>` → Conditions: DiskPressure.
2. `TODO`: disk usage — node-exporter `node_filesystem_avail_bytes`; identify the full mount.
3. What is consuming disk: image cache, logs, ephemeral volumes, a runaway pod?

## Diagnose

- `TODO`: largest consumers — `du`-style metric or `crictl` image disk usage.
- Is it a single node (drain it) or fleet-wide (capacity/log-rotation problem)?

## Remediate

`cordon-and-evict` cordons the affected node and evicts pods so they reschedule
onto healthy nodes. **`rollback_on_failure: false`** — cordon/evict is not
auto-reverted; uncordon manually after the node recovers.

1. Free obvious space first if safe: prune images / rotate logs (`TODO: crictl rmi --prune`).
2. Let `cordon-and-evict` run for nodes that stay under pressure (≤2×/hr).
3. After the node is healthy: `TODO: kubectl uncordon <node>`.
4. Fleet-wide → raise node count / fix log shipping retention (`TODO`).

## Rollback

No automated rollback. Manual recovery: `kubectl uncordon <node>` once
`node_filesystem_avail_bytes` is back above threshold.

## Escalate

- Page: GoAlert SEV2 route.
- Owner: `team-platform` · `carlos@krystaline.io`. Cluster/infra on-call if multiple nodes.
