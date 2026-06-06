# Per-artefact dependency view — plan

User shared two screenshots from a prior prototype showing a per-artefact
"Traceability" drawer with REQUIRES / USED BY / DATA SOURCES / RULE LOGIC
/ DASHBOARDS sections. Both were INFERRED dependency lists. The user
proposed: on **ctrl+click** an artefact card, dim every unrelated card's
opacity so the dependency relationships become visible at a glance.

This document plans that feature — both the data layer (computing
dependencies) and the visual layer (the opacity-dim mode).

---

## 1 · Name collision (decide first)

Two views currently want the name "Traceability":

- **The bucket view I shipped**: walks both packs and bins artefacts into
  Aligned / Declared-not-verified / Verified-not-declared / Stale. Cross-
  pack, drift-reconciliation focused.
- **The per-artefact dependency view this doc plans**: walks one pack
  and traces an artefact's REQUIRES / USED BY / DATA SOURCES / RULE LOGIC
  / DASHBOARDS dependencies. Single-pack, lineage focused.

The prior-prototype usage of "Traceability" was the per-artefact one.

**Recommendation:** rename the bucket view to **"Drift"** and reserve
"Traceability" for the per-artefact dependency view. The bucket view's
function (detecting drift between repo and live) matches "Drift" cleanly.

Migration: state-persistence has `view: 'traceability'`; a one-time
rehydrate translates the old key to `'drift'` so users in flight don't
lose their saved view.

**Open question for you**: confirm the rename direction, or suggest a
different pair of names (e.g. "Reconciliation" / "Lineage"). The doc
below assumes the recommended pair.

---

## 2 · Data layer — dependency inference

For each artefact, compute four buckets of dependencies by walking the
canonical pack:

| Bucket         | What populates it                                                                 |
|----------------|-----------------------------------------------------------------------------------|
| REQUIRES       | Artefacts this one references (e.g. dashboard.binds_to → SLI; SLO.ref → SLI)     |
| USED BY        | Artefacts that reference this one (reverse of REQUIRES, computed by index)        |
| DATA SOURCES   | The pipelines / backends / receivers that feed this artefact's metrics            |
| RULE LOGIC     | The recording-rule / alert expressions that define or consume this artefact      |
| DASHBOARDS     | Dashboards whose panel_bindings reference this artefact                           |

### Reference extraction map

Walking the canonical pack, the following fields produce dependency edges:

- `spec.slos[].sli` → SLO depends on SLI
- `spec.policy.burn_rate_alerts[].slo` → alert depends on SLO
- `spec.alerting.routes[].matchers[]` and `.receivers[]` → route depends on receivers
- `spec.remediation[].trigger` (e.g. `alert:foo`) → remediation depends on alert
- `spec.dashboards[].panel_bindings[].metric|sli|slo` → dashboard depends on metric/SLI/SLO
- `spec.queries.recording_rules[].expr` → string-grep for `:ratio_5m`, `:error_ratio_5m` etc. to find which SLIs feed which rules
- `spec.validation.chaos_experiments[].expected_alerts` → chaos test depends on alerts
- `spec.validation.synthetic_checks[].target` → check depends on backend / endpoint

### Output shape

```ts
type DependencyIndex = Map<artefactId, {
  requires: { id, layer, inferred: boolean }[],
  usedBy:   { id, layer, inferred: boolean }[],
  dataSources: { id, layer, inferred: boolean }[],
  ruleLogic: { ruleId, expr, inferred: boolean }[],
  dashboards: { id, layer, inferred: boolean }[],
}>;
```

The index is built once per pack-load and cached. INFERRED chips appear
in the UI on every row because the inference is heuristic — when a future
spec revision adds explicit refs (e.g. `dashboard.panels[].dependsOn: slis.X`),
those rows lose the INFERRED badge.

---

## 3 · Visual layer — the opacity-dim mode

### Trigger
Ctrl+click (or ⌘+click on macOS) on any artefact card in any layer.

### Behavior on enter
1. Compute the dependency closure for the clicked artefact:
   - direct REQUIRES, plus their transitive REQUIRES (depth 2)
   - direct USED BY, plus their transitive USED BY (depth 2)
   - DATA SOURCES, RULE LOGIC, DASHBOARDS rows
2. Build a set `relatedIds` of every artefact id involved.
3. Apply CSS:
   - The clicked card gets `[data-dep-focus="anchor"]` (full opacity + accent border)
   - Cards in `relatedIds` get `[data-dep-focus="related"]` (full opacity, subtle accent)
   - All other cards get `[data-dep-focus="dim"]` (opacity: 0.18, no interaction)
4. Open a `Traceability` drawer (or sidebar) showing the buckets list, mirroring the prior prototype's screenshots.

### Behavior on exit
- Ctrl+click anywhere else, OR
- Press Escape, OR
- Click the drawer's close button
→ remove all `[data-dep-focus]` attributes, close the drawer.

### Cross-layer awareness
The dimming applies across all visible layers (so when you ctrl+click an
SLI, the L2 backends + L3 recording rules + L3 dashboards that depend on
it all stay lit; L4 burn-rate alerts and L5 chaos tests that consume it
stay lit too).

### CSS sketch
```css
.card[data-dep-focus="dim"]     { opacity: 0.18; pointer-events: none; }
.card[data-dep-focus="anchor"]  { box-shadow: 0 0 0 2px var(--CMP); }
.card[data-dep-focus="related"] { box-shadow: 0 0 0 1px var(--CMP-50); }
.card                           { transition: opacity 200ms ease, box-shadow 200ms ease; }
```

---

## 4 · Drawer

The drawer the prior prototype showed:

```
┌─ Traceability ────────────────────────────────────────────────┐
│ Target                                                         │
│   evt-sys-auth-admin-down · Admin Auth Connection Down (P1)   │
│   Layer: L4                                                    │
│                                                                │
│ REQUIRES                                                       │
│   <none / inferred list>                                       │
│                                                                │
│ USED BY  (INFERRED)                                            │
│   • evt-sys-security · Security Notification (P1) (L4)        │
│   • evt-sys-auth-bind-down · LDAP Bind Connection Down (P1)   │
│   • …                                                          │
│                                                                │
│ DATA SOURCES  (INFERRED)                                       │
│   • sol_event_system_authentication_admin_conn_down_total     │
│     · metric referenced in query                               │
│                                                                │
│ RULE LOGIC  (INFERRED)                                         │
│   • evt-sys-security · (sum by (vpn, host) …)                 │
│   • …                                                          │
│                                                                │
│ DASHBOARDS                                                     │
│   <list of dashboards binding this artefact>                  │
└────────────────────────────────────────────────────────────────┘
```

Reuses the existing right-side drawer infrastructure (already used for
drawer-b in single mode). Slot the dependency lists in instead of the
generic detail panels.

---

## 5 · Implementation scope

| Phase | What ships |
|-------|------------|
| 0 — naming | Rename bucket view "Traceability" → "Drift". Persistence migration. |
| 1 — data  | `tools/lib/dependency-index.mjs` exporting `buildDependencyIndex(canonical)`. Tested against payment-service.pack.yaml + a synthetic fixture with intentional broken references. |
| 2 — drawer | Drawer template + populate from the index. Ctrl+click handler that opens it. Drawer mirrors the prior prototype. |
| 3 — opacity dim | `[data-dep-focus]` attributes + CSS rules + the related-id closure logic. Escape to exit. |
| 4 — atlas hook | When an artefact is in dep-focus mode, the Atlas arbor view (now available in single mode) highlights the same closure — clicking a node in arbor enters dep-focus on that artefact. |

Phases 0-3 ship sequentially. Phase 4 is a stretch goal that connects
this feature to the arbor view the user already values.

---

## 6 · Things to decide before coding

1. **Drawer or sidebar?** Drawer slides in from the right (consistent with
   the existing detail drawer). Sidebar docks permanently. Default: drawer.
2. **Dimming depth?** 0.18 opacity feels strong. The user's framing was
   "very deem" → very dim. Could try 0.12 or 0.08.
3. **Transitive depth?** Direct refs only, or one hop further? Default
   in the plan: depth 2 (direct + one hop). Deeper risks lighting up too much.
4. **Persistence?** Should ctrl+click state survive a page refresh? Probably
   no — it's a "focus moment", not a saved view.
5. **Mobile / touch?** Ctrl+click doesn't exist on touch devices. Long-press
   as the touch trigger?

---

## See also

- [`docs/USER_JOURNEY.md`](USER_JOURNEY.md) — north-star flow
- [`docs/REFERENCE_CATALOGUE_PLAN.md`](REFERENCE_CATALOGUE_PLAN.md) — the
  catalogue is the long-term source of reference packs the user benchmarks
  against; once the bucket view is renamed to "Drift", "Traceability"
  carries the per-artefact-lineage meaning consistently.
