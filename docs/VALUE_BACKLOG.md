# Value Backlog

Prioritized product backlog for Tomograph's next iterations, distilled from
the 2026-06 audits ([ADVANCED_FEATURE_AUDIT.md](ADVANCED_FEATURE_AUDIT.md),
[REFACTORING_PLAN.md](REFACTORING_PLAN.md)) and the live-drift remediation
work. Ordered by user value per unit of risk: items near the top make the
core promise ("is this service's observability diagnostic-grade?") more
true; items lower down widen the audience.

Engineering-health work lives in REFACTORING_PLAN.md, not here.

---

## P1 — Make the verdict more trustworthy

### 1. Diagnostic-grade validation against incident ground truth
The grade claims "diagnostic-grade" on eight structural criteria. Close the
loop with reality: for services with incident history, check whether the
signals the pack declares would have detected/explained real incidents
(MTTD vs `mttd_target`, alert fired vs incident start, runbook referenced).
Even a manual back-test template against 3–5 historical incidents would
turn the grade from a posture score into a validated claim — and tell us
which of the eight criteria actually predict diagnosability.

### 2. Runtime attestation / freshness evidence
Today "Verified" means the live MCP scan saw the artefact at fetch time.
Strengthen the evidence: per-artefact freshness (rule last evaluated,
dashboard last rendered, alert route last exercised), carried in pack
annotations and surfaced in Traceability buckets and the Fresh criterion.
Turns "it exists in production" into "it is alive in production".

### 3. Richer semantic parsing: PromQL, dashboards, scrape, Alertmanager
Drift matching is structural-plus-PromQL today. Deepen the semantic layer:
- PromQL: normalise label-matcher order, vector-matching clauses, and
  constant folding so cosmetic rewrites stop reading as drift.
- Dashboards: compare panel *queries and thresholds*, not raw JSON shape.
- Scrape configs: relabel rules and target discovery semantics.
- Alertmanager: route-tree equivalence (group_by/matchers/receivers) rather
  than node-by-node identity.
Each reduces false drift, which is the main credibility tax on Diagnose.

## P2 — Close the remediation loop

### 4. Bidirectional remediation
Remediate currently compiles repo→production. Build the reverse arrows:
- **Repo retrofeed**: when live has verified artefacts the repo never
  declared (shadow signals worth keeping), generate the pack fragment + a
  PR-ready diff back into the service repo.
- **Deploy missing declared artefacts**: from the declared-not-verified
  bucket, one action to compile and push exactly the missing set through
  the existing MCP write path.
Together these make the pack genuinely round-trip: declared ⇄ live.

### 5. Service-scoped reconciliation controls
The reconciliation engine supports service scoping; the UI exposes little
of it. Give the user explicit scope control in Diagnose/Remediate: which
service(s) of a multi-service live pack to reconcile against, with the
out-of-scope inventory clearly parked rather than silently ignored.

### 6. Requirement-branch reconciliation UI
Traceability shows requirement chains and the comparison spec
(TRACEABILITY_GRAPH_COMPARISON_SPEC.md) defines branch-level divergence.
Build the acting surface: per requirement branch, show declared vs live
side by side and offer the targeted fix (deploy the missing rule, adopt the
live threshold, retire the stale alert) — remediation at requirement
granularity instead of artefact granularity.

## P3 — Widen what the crawler can see

### 7. Exporter metric extraction from source (TypeScript / Go / Java)
The crawler reads config artefacts (rules, dashboards, collector, Helm).
The biggest blind spot is the code itself: extract metric/span/log
declarations from instrumentation source (prom-client / OTel SDK calls in
TS, Go, Java) so the L2 inventory includes what the service *emits*, not
just what the platform *collects*. Start with one language (TS) and the
two dominant patterns (prom-client counters/histograms, OTel meters).

### 8. Multi-service operating model
Today the unit of work is one pack. Define the model for a team operating
many services: a workspace listing every service's grade/drift at a glance,
shared reference targets, roll-up reporting (how many tier-1 services are
diagnostic-grade?), and bulk refresh. The service selector exists; the
operating layer above it doesn't.

---

## Sequencing note

P1 items compound: better parsing (3) reduces false drift, which makes
freshness evidence (2) cleaner to interpret, which makes incident
back-testing (1) meaningful. P2 items depend on trust in the verdict —
shipping auto-remediation on top of noisy drift would amplify noise. P3
widens input after the loop is closed.
