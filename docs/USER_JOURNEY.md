# User Journey

The studio has one canonical flow. Keep design changes faithful to it.
When in doubt, read this doc and the journey will tell you whether
your change makes the path shorter or longer.

## North-star flow

```
                            ┌──────────────────────────────┐
                            │           OPEN APP           │
                            │  (or click the brand logo)   │
                            └──────────────┬───────────────┘
                                           │
                                           ▼
                            ┌──────────────────────────────┐
                            │             HOME             │
                            │   single drop-zone affordance │
                            │   "Drop a pack to begin."     │
                            └──────────────┬───────────────┘
                                           │
                  ┌────────────────────────┼────────────────────────┐
                  │                        │                        │
            drop a YAML/JSON         crawl a repo            draft from MCP
            (or pick from disk)    (npm run crawl)          (POST MCP URL)
                  │                        │                        │
                  └────────────────────────┼────────────────────────┘
                                           │
                                           ▼
                            ┌──────────────────────────────┐
                            │      POST /api/validate      │
                            │   schema → adapter → score   │
                            │   registers canonical with    │
                            │   deterministic content id    │
                            └──────────────┬───────────────┘
                                           │
                                  ok? selectedPackId
                                  set to registered.id
                                           │
                                           ▼
                            ┌──────────────────────────────┐
                            │     SINGLE-PACK STUDIO       │
                            │                              │
                            │  Layers      browse L1..GOV  │
                            │  Conformance score vs rubric │
                            │  Compile     →  Prometheus  │
                            │              →  Grafana     │
                            │              →  OTel        │
                            │              →  Alertmanager │
                            │  Schema      maturity view   │
                            │                              │
                            │  header carries Pack A + Env │
                            │  pickers (always visible)    │
                            │                              │
                            │  Pack B picker also visible  │
                            │  — empty until used          │
                            └──────────────┬───────────────┘
                                           │
                                user picks a Pack B
                                from the header
                                           │
                                           ▼
                            ┌──────────────────────────────┐
                            │       AUTO-SWITCH TO         │
                            │       COMPARE VIEW           │
                            │                              │
                            │   (header pickers hide —     │
                            │    pack cards inside the     │
                            │    compare view carry their  │
                            │    own pickers + swap btn)   │
                            └──────────────┬───────────────┘
                                           │
                                           ▼
                            ┌──────────────────────────────┐
                            │     COMPARE / TRACEABILITY   │
                            │     / ATLAS                  │
                            │                              │
                            │  Compare     side-by-side    │
                            │              per-layer diff  │
                            │  Traceability                │
                            │              aligned /       │
                            │              declared-not-   │
                            │              verified /      │
                            │              verified-not-   │
                            │              declared /      │
                            │              stale           │
                            │  Atlas       6 visual variants│
                            │              (strata,        │
                            │               periodic,      │
                            │               constellation, │
                            │               skyline,       │
                            │               transit, arbor)│
                            │                              │
                            │  Conformance + Compile stay  │
                            │  available; A|B focus toggle │
                            │  on the view-nav lets the    │
                            │  user score / compile either │
                            │  side without losing context │
                            └──────────────────────────────┘
```

## Invariants the journey relies on

1. **Empty start.** Nothing is preloaded. No bundled examples on the
   home screen. The user supplies their own pack as the first
   meaningful action.

2. **One affordance per surface.** Home: one drop-zone, three input
   methods. Single-pack views: header pickers, period. Compare view:
   inline pack-card pickers, period. **Never** show the same control
   twice — the duplication of header + inline pickers on Compare was
   the bug that motivated this document.

3. **Picking Pack B is the user saying "compare".** It auto-switches
   to the Compare view. Don't make the user click a separate "Compare"
   nav button. (Exception: if the user explicitly chose Atlas or
   Traceability between B-changes, respect that — they're already on
   a cross-pack view.)

4. **State persists across reloads.** localStorage carries pack ids,
   the active view, layer filter, focus side, and trace-finding
   preferences. Server restart clears uploads (in-memory); rehydrate
   gracefully drops unknown ids and falls back to home.

5. **Uploaded / crawled / drafted packs are first-class.** Same
   `/api/packs/:id/*` surface as catalog packs. Deterministic content
   hash gives them stable ids across restarts and engineers. The
   only thing they don't survive is process restart of the server
   (in-memory only).

## When you make a change

Ask:

- Does this **shorten** the path from "open app" to "see useful data"?
- Does it add a **decision the user doesn't need to make**?
- Does it **duplicate** an existing control?
- Does it **preserve state** the user spent effort to create?
- Does it **show what's on-screen** (single-pack views show Pack A
  metadata; Compare shows both)?

If any of those answers is wrong, the change is fighting the journey.

## What lives where on screen

| Region                | Single-pack views                  | Compare view                            |
|-----------------------|-------------------------------------|------------------------------------------|
| Header brand + logo   | always                              | always                                   |
| Pack A picker         | visible in header                   | hidden — moved into the compare pack card|
| Env A picker          | visible in header                   | hidden — moved into the compare pack card|
| Pack B picker         | visible in header (empty)           | hidden — moved into the compare pack card|
| Env B picker          | visible in header (after B loaded)  | hidden — moved into the compare pack card|
| Metadata strip        | always                              | always                                   |
| View nav              | Layers · Conformance · Compile · Schema | + Compare · Traceability · Atlas       |
| Layer filter chips    | only on Layers view                 | only on Layers view                      |
| A \| B focus toggle   | on Conformance / Compile / Schema   | (hidden — Compare shows both sides)      |

## Things the journey is NOT

- It is **not** a "select your tier" first-screen. The home doesn't
  ask "are you a tier-1 platform team?"
- It is **not** a marketplace of bundled examples. Examples exist for
  the regression suite + as Pack B comparison targets; they don't
  surface as a recommended starting point on home.
- It is **not** a two-track "Analyze a single pack vs Compare two
  packs" decision tree. There's one track: open a pack, work on it,
  add Pack B when you want comparison.

## See also

- [`docs/MODEL.md`](MODEL.md) — pointer to the canonical ObservabilityPack spec v1.2
- [`docs/ADAPTER.md`](ADAPTER.md) — how canonical → layered display projection works
- [`docs/CONFORMANCE.md`](CONFORMANCE.md) — how the maturity rubric scores
- [`docs/MCP_INTEGRATION.md`](MCP_INTEGRATION.md) — the live-fetcher wire details
