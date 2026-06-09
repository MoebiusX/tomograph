# Is Tomograph Itself "Diagnostic Grade"?

### Holding the instrument to its own standard

This applies the eight-axis framework from `DIAGNOSTIC_GRADE_FRAMEWORK.md` to Tomograph itself. Tomograph *is* a measurement instrument: it produces a verdict ("Diagnostic Grade: PASS/FAIL") about whether a service's observability is good enough to trust. The fair question — and a strong one for a CIO audience — is whether that verdict is *itself* produced to diagnostic-grade standard.

**Scope.** The "instrument" here is the Tomograph pipeline that yields the Diagnostic Grade: crawler → adapter → posture matrix → `computeDiagnosticGrade` (8 criteria, pass at ≥7/8) → drift/diff against a live pack. Evidence is drawn from this codebase and the analyses run over this engagement.

**Headline verdict.** Tomograph is a **strong and improving *verification* instrument with a pioneering *calibration* axis, but it is not yet *diagnostic grade* by its own definition.** It excels at reproducibility and at the calibration/drift idea that most observability tooling lacks entirely. But it does not yet quantify its own sensitivity, specificity, detection limit, or verdict uncertainty against any ground truth, and it currently carries a known trueness/bias defect (environment mixing). In metrology terms: **verified, not yet validated.**

---

## Scorecard

Rating scale: **Met** (demonstrated, with evidence) · **Partial** (present but incomplete or unquantified) · **Absent** (not implemented/measured).

| # | Axis | Rating | State today | Evidence |
|---|---|---|---|---|
| 1 | **Validity** — measures the right thing | **Partial** | The grade mostly measures *declaration richness* (multi-modal, correlated, calibrated, comprehensive, actionable) on Pack A — "is the observability well-declared," not "is the service reliable." Only the Trust axis touches reality. Face validity is reasonable; criterion/construct validity (does a PASS predict fewer/shorter incidents?) is **never evidenced**. | `computeDiagnosticGrade` reads declared L1–L5 artefacts; no link to real incident outcomes anywhere in the grade. |
| 2 | **Reliability / reproducibility** — same input → same verdict | **Met** (given a fixed input) | The grade and diff are pure deterministic functions; the diff now preserves every artefact and a pack-vs-self scores `alignment = 1.0`, with a regression test locking it. This is Tomograph's strongest axis. | `tools/test-diff.mjs` (self-diff preserves artefacts, occurrence keys); deterministic `canonicalize`/`stableStringify`. |
| 3 | **Trueness / bias** — right on average, not systematically off | **Partial / at risk** | A real **positive bias** exists: the crawler over-declares by blending three environments and ignoring Helm `enabled: false`, so the declared posture overstates any single environment. Now characterised, not yet corrected. | Env-mixing analysis: compose (Prometheus) + values-eks (`prometheus.enabled: false`, VictoriaMetrics) merged into one pack; `bindings.environments: [prod]` only. |
| 4 | **Sensitivity** — catches real degradations | **Absent** (as measured) | No incident ground-truth set; Tomograph never computes its own catch-rate or MTTD-against-reality. "Sensitivity"-like wording in the rubric refers to *coverage*, not detector recall. | grep of grade code: no `incident` / `catch-rate` / ground-truth concept. |
| 5 | **Specificity** — avoids false alarms | **Absent** (as measured) | No false-alarm/precision tracking of its own verdicts. Worse, a known false-positive source is live: the env-mix inflates "declared, not live" (51 in the last run) with artefacts that were never meant for that environment. | Drift panel "declared-not-live" shown to be dominated by env mismatch, not real drift. |
| 6 | **Detection limit / resolution** — smallest real change reliably caught | **Absent / weak** | No notion of the smallest reliability change detectable. The verdict is 8 binary criteria → resolution is coarse (one criterion ≈ 12.5%); small degradations can't move it. No `a90/95` analogue. | 8-criterion binary scoring; `overallPassed/8`. |
| 7 | **Traceability / calibration** — anchored to a reference, re-anchored on a cadence | **Partial** (best-developed *and* most-broken) | This is the genuinely novel part: declared-vs-live drift via MCP probes, a probe-confirmation tolerance (30%), and a **freshness window (24h)** — i.e. calibration *with a calibration interval*. But (a) static conformance still scans the manifest, not the system; (b) the calibration **reference is currently wrong** — a 3-env blend is compared against one live env (EKS); (c) "verified" is an annotation stamp, not a first-class primitive. | `FRESH_WINDOW_MS = 24h`, `DRIFT_FAIL_TOLERANCE = 0.30`, `mcp.probesAttempted/refreshedAt`; env-mixing breaks the reference. |
| 8 | **Quantified uncertainty** — confidence + pre-declared, cost-justified target | **Absent** | The verdict is a hard PASS/FAIL at exactly 7/8, with **no confidence statement and no uncertainty**, and the 7/8 bar is not derived from the cost of a missed incident. Every measured result in metrology is incomplete without an uncertainty; the grade ships none. | `PASS_THRESHOLD = 7`; grep: no `confidence`/`uncertainty` in grade. |

### Meta-requirements

| Requirement | Rating | Note |
|---|---|---|
| **Validation > verification** (the spec must be adequate, not just met) | **Partial** | Tomograph straddles: conformance/coverage is *verification* (manifest checks); the drift/Trust axis is the *validation* attempt. But it labels a verification-heavy score "Diagnostic Grade," conflating the two — the exact trap VIM 2.45 warns against. |
| **Evidence discipline / auditability** (reportable, bias-appraised) | **Partial → Met** | Deterministic, inspectable, documented (`DIFF.md`), and now regression-tested. Missing: a STARD/QUADAS-equivalent appraisal of its *own* verdicts' accuracy. |

---

## What this means, in one paragraph

Tomograph reliably and reproducibly answers *"is this pack well-formed and does it match what we declared?"* — and uniquely, it begins to ask *"does the declaration match the live system?"* (calibration/drift), which is the single hardest and most valuable axis. What it does **not yet** do is the part that earns the word "diagnostic": it never measures whether its verdict **tracks reality** (validity), how often it **catches real incidents** (sensitivity) or **cries wolf** (specificity), the **smallest problem it can see** (detection limit), or **how confident** any given verdict is (uncertainty) — and it currently has a **systematic over-declaration bias** from environment mixing. By the standard Tomograph is proposing for others, Tomograph is today an excellent **verification + drift** instrument, not yet a validated diagnostic one.

This is not a criticism so much as a roadmap — and a candid version of it is a *much* stronger talk than claiming the tool is already there.

---

## The shortest path to closing the gap

Ordered by leverage; each ties to an axis and to work already scoped this engagement.

1. **Fix trueness first (axis 3) — environment-aware crawl.** Emit `spec.environments` overlays (or crawl per-env), honor `enabled` toggles, and compare like-for-like (EKS pack vs EKS live). This removes the systematic bias *and* repairs the calibration reference (axis 7). Highest leverage; everything downstream is noise until this is done.
2. **Make calibration honest (axis 7) + add uncertainty (axis 8).** Promote "verified/last-verified" to a first-class attestation with a freshness gate (a stale verification should fail regardless of static score), and attach a confidence/coverage statement to the verdict instead of a bare PASS/FAIL. Set the 7/8 threshold from an explicit cost-of-miss argument.
3. **Earn validity, sensitivity, specificity (axes 1, 4, 5) — the hard, decisive part.** Keep a labelled set of past incidents and back-test: did a PASS verdict correspond to fewer/shorter incidents (validity)? what fraction of real incidents did the declared alerts catch within MTTD (sensitivity)? what fraction of fired alerts were noise (specificity)? Report these as the tool's own ROC-style operating point. This is what converts "verification tool" into "diagnostic-grade instrument," and it's exactly the analytical-vs-clinical-validity split from IVD.
4. **Add a resolution statement (axis 6).** Define and report the smallest budget-burn / SLO degradation the pipeline reliably flags — an "a90/95 for observability."

When 1–4 are in place, Tomograph will be able to say of *itself* what it asks of every service: here is our validity, our sensitivity and specificity at a stated operating point, our detection limit, our calibration freshness, and the uncertainty on our verdict — measured, not asserted.

---

*Assessment basis: the eight-axis framework in `DIAGNOSTIC_GRADE_FRAMEWORK.md`; direct reading of `studio/compare-view.mjs` (grade logic), `tools/lib/diff.mjs` / `artefact-model.mjs` (matching), `tools/lib/crawler.mjs` (extraction); and the environment-mixing, artefact-matching, and reconciliation analyses produced over this engagement. Ratings reflect what is **demonstrated in code and evidence today**, not planned work.*
