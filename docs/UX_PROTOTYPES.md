# UX Prototypes — Diagnose & Remediate (?proto=a|b|c)

*Deliverable for [UX_REDESIGN_BRIEF.md](UX_REDESIGN_BRIEF.md), built
2026-06-11. Three divergent, clickable redesigns of Tabs 2 and 3,
running IN the studio on real pack data. This document is the viewing
guide and the honest inventory of what each direction does.*

## How to view

```
npm run serve                # studio on http://localhost:8000
http://localhost:8000/?proto=a    # A · Verdict-first narrative
http://localhost:8000/?proto=b    # B · Mission control
http://localhost:8000/?proto=c    # C · Guided flow
```

Load Pack A + Pack B from the header as usual (the prototypes read the
same `state` and `/api/diff` as production). A floating **PROTOTYPE
A·B·C·×** pill (bottom-left) switches variants; `×` returns to the
production tabs. Without the query param **nothing changes** — the
production Diagnose/Remediate render untouched.

Screenshots (krystaline repo vs production-live MCP draft, the real
drift scenario): [docs/img/ux-protos/](img/ux-protos/).

## What is shared (all three variants)

- **Engines untouched.** Every number comes from
  `computeDiagnosticGrade`, `computeWeightedDeltaRisk`,
  `driftedEntryBadness`, `/api/diff`, and `/api/journeys` — the
  prototypes are view-layer only (`studio/proto-*.mjs`,
  `studio/proto.css`, all behind the param).
- **The projection sentence.** "Fixing these N takes you from B (64%)
  to A (87%)" is computed by re-running the real grade engine on a
  hypothetical post-fix diff (`projectGrade` in
  `studio/proto-shared.mjs`). HONESTY FENCE: requirement-chain
  integrity is held constant and freshness/chaos are never projected —
  when the drift criterion is anchored on chain integrity the
  prototypes say so instead of faking a delta.
- **Honesty machinery preserved verbatim in spirit:** the
  partial-live-evidence banner, scaffold and out-of-scope notes, the
  2C "informational — never scored" operability framing, the
  verification ≠ validation language, and the no-live-signal WARN.
- **Weighted badness is the triage order everywhere.** Per-item
  weights are the engine's own (`declared-not-live 1.0 · drifted 0.5 /
  1.0 decision-bearing / 0.1 cosmetic · live-not-declared 0.15`).
- The comparison loading spinner / retry behaviour is mirrored from
  production (don't-regress item).

## A · Verdict-first narrative

**Diagnose** — one hero answer: the instrument-grade letter + verdict
word, beside the single **"biggest drag on the grade"** callout (the
badness bucket costing the most units) and the compact ladder. A
sticky action bar (deploy-the-missing-set, plan retrofeed, re-verify,
open Remediate) is always visible. The five reports are `<details>`
chapters below — collapsed by default, the dominant problem's chapter
pre-opened, counts shown once in chapter headers.

**Remediate** — leads with the highest-value fix and the full-set
grade projection; the worklist is banded by impact (Critical ≥ 1.0 /
Moderate / Low) instead of by layer, with per-item deploy buttons and
a session-scoped progress meter (honestly labelled: progress resets at
re-verification — the live diff is the source of truth).

## B · Mission control

**Diagnose** — the KrystalineX-reference direction. A hero KPI band:
Score · Coverage · Trust · Drift fidelity · Freshness · Verified as
accent-colored stat tiles; Score and Drift fidelity carry sparklines
and "▲/▼ pp vs previous run" deltas powered by journey run history
(`.tomograph/runs/`). Below, a dense panel grid — **Signal Lattice**
(weighted-health donut), **Strata Drill** (per-layer heat table),
**Requirement Chains**, **Coverage/Trust Matrix** (verdict chips),
**Operability**, **Evidence Ledger**, and **Recommended Next Actions**
— each panel one title + one question, expandable in place (⤢).

**Remediate** — the Recommended-Next-Actions table made first-class: a
full-page triage queue ordered by weighted badness with class chips
(DECISION-BEARING / MISSING LIVE / SHADOW…), per-row one-click deploy,
checkbox basket, and KPI tiles (findings, selected, deployable,
projected grade).

## C · Guided flow

**Diagnose** — four steps, one question per screen: **1 VERDICT** (can
we trust it?) → **2 EVIDENCE** (drift, chains, criteria, ledger) →
**3 PICK GAPS** (checkable triage list with select-all / critical-only,
the **projected grade gauge updating live** as gaps are picked) →
**4 HAND OFF** (the plan: deploy now, open the queue, re-verify).

**Remediate** — the same basket as a triage queue with a sticky right
rail: projected-grade gauge, deploy-basket composition (deployable ·
retrofeed · field decisions · manual), progress meter. The basket is
shared Diagnose ↔ Remediate within the session.

## Prototype-only simplifications (would harden in the real build)

- Variant/step/basket state is session-only module state — deliberate
  for selections (the live diff stays the source of truth) but step
  position would persist in a real build.
- The product lens (`state.compareLens`) is not applied to the
  prototype drift universe; production's drift drill keeps it.
- Retrofeed actions route to the deploy modal or the classic Remediate
  patch flow rather than re-implementing the patch download.
- Requirement-chain per-branch deploy/adopt buttons (2B.G) are not
  reproduced inside the prototypes; chains render as status cards.

## Judging (from the brief)

Time-to-answer (<10 s), time-to-action (one click), demo impact,
honesty preserved, implementation cost. Feedback should target
concrete options; synthesis may freely combine directions — e.g. B's
KPI band + A's chaptered evidence + C's basket/projection rail.
