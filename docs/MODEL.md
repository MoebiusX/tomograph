# The ObservabilityPack model

A 5-layer model for organising an observability platform's inventory.
The studio's UI, the JSON schema, the visualisations, and the MCP wire-up
all hang off this skeleton.

```
                  ┌──────────────────────────────────┐
                  │   L1 · CONTRACT — what "good"    │
                  │   means.  SLIs / SLOs / EBP.     │
                  └──────────────┬───────────────────┘
                                 │
                  ┌──────────────▼───────────────────┐
                  │   L2 · TELEMETRY — produce,      │
                  │   collect, persist. scrape ·     │
                  │   OTel · logs · retention.       │
                  └──────────────┬───────────────────┘
                                 │
                  ┌──────────────▼───────────────────┐
                  │   L3 · INSIGHT — turn signal     │
                  │   into understanding. queries ·  │
                  │   dashboards · topology.         │
                  └──────────────┬───────────────────┘
                                 │
                  ┌──────────────▼───────────────────┐   ┌───────────────┐
                  │   L4 · ACTION — when / where /   │◀──│   L5          │
                  │   what to do.                    │   │   VALIDATION  │
                  │   ┌─────────┬──────────┬───────┐ │   │   chaos ·     │
                  │   │ POLICY  │ ALERTING │ HEAL  │ │   │   synthetic · │
                  │   └─────────┴──────────┴───────┘ │   │   MTTD/MTTR · │
                  └──────────────┬───────────────────┘   │   conformance │
                                 │                       └───────────────┘
                  ┌──────────────▼───────────────────┐
                  │   GOVERNANCE & REPORTS           │
                  │   Evidence that everything above │
                  │   is working.                    │
                  └──────────────────────────────────┘
```

## Why five layers

Most observability roadmaps lump "alerting" with "instrumentation" and
"reporting" with "dashboards". That collapse is the root cause of why most
observability projects drift: there's no place in the inventory for *why*
something exists.

This model separates concerns by **what question the layer answers**, not
by which tool implements it. Prometheus shows up in L2 (it scrapes), L3
(it has recording rules), and L4 (Alertmanager). One tool, three layers,
three different conversations.

## Layer by layer

### L1 · Contract — *What does "good" look like?*

**The promises.** SLIs (the measurable thing), SLOs (the objective), error
budget policy (what happens when the budget burns).

Without L1, every later layer is uncalibrated. You can have perfect
dashboards measuring nothing that matters.

Example artefacts:
- `SLI-01 Availability SLI` — service up ratio
- `SLO-01 Availability SLO 99.9%` — monthly window
- `EBP-01 Error-budget policy (predict_linear)` — burn forecast rule

### L2 · Telemetry — *Produce, collect, persist.*

**The plumbing.** Two sub-concerns: **Collection** (scrape, OTel, log
shipping, health) and **Storage + Retention** (TSDB, log chunks, trace
backend, downsampling).

Storage is its own first-class concern because retention windows govern
what compliance and audit questions you can answer next quarter.

Example artefacts:
- `COL-02 OTel Collector pipeline`
- `STO-04 Long-term metrics (>15d)` ← often a real GAP

### L3 · Insight — *Turn signal into understanding.*

**The interpretation.** Recording rules and derived views; dashboards;
topology. Distinct from L2 because queries can exist before storage is
permanent (and vice versa).

Example artefacts:
- `QRY-01 Recording rules — SLI burn`
- `DASH-03 Grafana — SLO & Error Budget`
- `TOPO-X1 Live dependency map`

### L4 · Action — *When / where / what to do.*

**The response.** Split into three sub-columns:

| Sub | Question | Examples |
|---|---|---|
| **Policy** | When does the system *decide*? | burn-rate thresholds · release-gate · routing matrix |
| **Alerting** | Where do alerts go? | Alertmanager rules · anomaly detector |
| **Self-Healing** | What runs automatically? | runbook automation · KEDA · circuit breakers |

The conflation of these three is where most "we have alerts" handwaving
hides. Splitting them surfaces the gaps: most teams have *alerting* but
no *policy* (alerts fire but no one knows the agreement); many have
*policy* and *alerting* but no *self-healing* (humans paged for
every recoverable condition).

### L5 · Validation — *Prove the loop.*

**The receipts.** This is the layer most observability platforms *don't
have*: chaos drills, synthetic probes, MTTD/MTTR baselines, daily
conformance scans against the schema itself.

L5 is drawn as an orthogonal right-hand column in the studio because it
**wraps** L1–L4. It asserts that the four layers are wired correctly on
every run.

Without L5, an alert rule could silently rot for months — and you wouldn't
notice until incident retrospective. With L5, a synthetic probe trips a
test alert weekly; a chaos drill kills a pod monthly; the conformance scan
nightly checks that every L1 SLI has a corresponding L2 collection.

Example artefacts:
- `VAL-02 Chaos experiments`
- `VAL-03 Synthetic probes`
- `VAL-04 MTTD / MTTR baselines`
- `VAL-05 Daily conformance scan`

### Governance & Reports — *Evidence everything above is working.*

**The audit trail.** Conformance score, audit evidence (SOC2 / ISO27001),
postmortem rollups (MTTD/MTTR trends), cohort reports by team / tier /
domain.

Drawn as a full-width row underneath the layered loop because it consumes
all five layers as inputs.

## Source taxonomy

Each artefact carries a `source` tag — what *kind* of fact it represents.
This is orthogonal to which layer it sits in.

| Tag | Colour | Meaning |
|---|---|---|
| `BAU` | slate | Claimed in repo — supposed to be in production |
| `SLA` | violet | Contractual / audit-driven · externally required |
| `NEW` | green | On the target list to deploy |
| `GAP` | red | Required for the layer but not present |
| `PLANNED` | cyan-dark | On the roadmap, not committed |
| `LIVE` | cyan-light, pulsing | Verified by telemetry at refresh time |

`LIVE` is special: it's the only tag that requires external evidence to
assign. The fetcher writes it onto BAU artefacts when an MCP probe
confirms they're emitting telemetry right now. Everything that *claims*
to be in prod but MCP can't confirm stays BAU — and the studio surfaces
that discrepancy as part of the design.

## A pack is one snapshot

A **Pack** is one rendering of this model — usually one of:

- **Current — Curated.** Hand-edited inventory of what's supposed to be in
  prod. The honest list from the repo.
- **Current — Live.** Same inventory, but with `LIVE` markers from MCP.
  Surfaces the lie between "claimed" and "verified".
- **Target.** The end-state inventory. Adds `NEW` artefacts for items not
  yet in the curated picture.

The studio's Compare and Atlas views render two packs side-by-side and
diff them. The Skyline view in particular makes the project plan inherent
in the data: every steep slope is a piece of work; every flat line at 100%
is a layer that doesn't need attention.
