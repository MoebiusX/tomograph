# Tomograph — Rename & Migration Plan

**Decision locked:** the observability compiler toolchain (formerly `otel-observability-pack-studio`) becomes **Tomograph**.
**Category descriptor:** *The Observability Compiler.*
**Brand thesis:** *You have to be able to trust what your eyes see.* Observability that has drifted out of date delivers zero value — a clean scan of a body that has changed. Tomograph keeps observability diagnostic-grade: compiled from the spec, regenerated so the image matches the live system, and scored so you know the instrument itself is sound.

---

## 1. Availability snapshot (verified June 6, 2026)

| Surface | Status | Action |
|---|---|---|
| npm `tomograph` | **Appears unclaimed** (empty package page) | Claim now, defensively |
| PyPI `tomograph` | Taken but dead — v0.1 CT simulator, last release Mar 2019 | Ignore; use a scope if Python ever ships |
| GitHub repos | Only dormant tiny projects (quantum-tomography lib; an abandoned personal "tracing library") | No real collision |
| GitHub org `Tomograph` | Looks available | Claim now |
| `tomograph.dev` / `tomograph.io` | No product found on either | Register `.dev` (primary) + `.io` (defensive) |

No observability/monitoring product named Tomograph exists. Verify domains at a registrar and the org handle on GitHub before announcing.

---

## 2. The locked naming system

The win is a *small imaging vocabulary*, not one word — engineers absorb the whole model in a sentence.

| Element | Name | Notes |
|---|---|---|
| The toolchain / product | **Tomograph** | The Observability Compiler. Repo, CLI umbrella, brand. |
| The compiler binary | **`packc`** | "The pack compiler" — reads like `gcc`/`tsc`/`rustc`. |
| The spec / standard | **`pack` / ObservabilityPack** | **Unchanged.** Load-bearing; descriptive standards win. |
| Crawl / decompile a repo | **x-ray** (verb) | "x-ray a service repo to draft a pack." Verb only — never the brand (AWS X-Ray collision). |
| Conformance output | **the scan / a tomogram** | The rendered, scored picture of posture. |
| Drift | **miscalibration** | The instrument no longer matches the body. |
| The MCP server | **`otel-mcp-server`** | **Unchanged.** Keep for discoverability. |
| The proving ground (demo) | **Krystaline** | **Unchanged.** Good feedback; the crystal = what you image through. |

**One-sentence mental model:**
> Write the pack; `packc` compiles it into every backend; x-ray an existing repo to draft one; Tomograph scans your posture and tells you whether the image still matches the system.

---

## 3. Positioning copy

**Tagline:** Tomograph — the Observability Compiler. *Trust what your eyes see.*

**30-second pitch:**
> Every observability program drifts. Dashboards reference dead metrics; alerts fire on yesterday's topology; the SLOs live in a wiki nobody opens. Tomograph makes the observability of a service a single declarative pack, then *compiles* it — into Prometheus rules, Grafana dashboards, OTel Collector pipelines, and Alertmanager routes. Change the pack, recompile the platform. Re-target between vendors by recompiling. And because a scan is only worth acting on if the instrument is calibrated, Tomograph scores conformance and flags miscalibration — so when you defend an OLA, you're defending what you can actually prove.

**README header block (for the renamed repo):**
```
# Tomograph — the Observability Compiler

Write one ObservabilityPack. Compile it into Prometheus rules, Grafana
dashboards, OTel Collector pipelines, and Alertmanager routes. Scan any
service's observability posture and score it against the spec.

Trust what your eyes see.
```

---

## 4. Repo-by-repo plan

**`otel-observability-pack-studio` → `tomograph`  (rename)**
- Rename the GitHub repo to `tomograph`. GitHub auto-redirects the old URL and existing clones/remotes — nothing breaks.
- `package.json`: `name` → `tomograph` (or `@moebiusx/tomograph`), add `bin` entries for `tomograph` and `packc`, update `description` to lead with "The Observability Compiler."
- Update README to the header block above; update CLI `--help` banner and any in-app titles ("Studio" → "Tomograph").
- Keep the words *observability pack* and *OpenTelemetry* in the repo description and GitHub topics for search.

**`otel-observability-pack` → keep the name (spec).**
- Add one line to the README: "Reference toolchain: **Tomograph** — compiles and scores packs." Cross-link both ways.

**`otel-mcp-server` → keep the name (discoverability).**
- Optional one-liner: "Part of the Tomograph ecosystem — turns *declared* into *verified*."

**`KrystalineX` → keep the Krystaline brand.**
- Brand is **Krystaline**; the repo slug carries a trailing `X`. Optional, low priority: align the repo name to `Krystaline` (auto-redirects), or leave as-is. Your call — no urgency.

---

## 5. Migration mechanics (preserve discoverability)

- **GitHub renames are safe.** Repo and org renames keep old links working via permanent redirects; don't delete or recreate. Push a tiny commit after rename so the redirect is exercised.
- **npm:** claim `tomograph` immediately. If the studio was ever published under another name, publish `tomograph` and `npm deprecate` the old name with a message pointing to the new one.
- **PyPI:** the bare name is a dead 2019 alpha. PEP 541 reclamation is possible but slow and not worth it now — use a scope or a qualified dist name if/when you ship Python.
- **Domains:** register `tomograph.dev` (primary) and `tomograph.io` (defensive/redirect).
- **Always pair "Tomograph" with the descriptor** ("the Observability Compiler") on first mention everywhere until the name carries itself. This disambiguates from the dormant tomography projects and the medical-device meaning.

---

## 6. Sequencing checklist

1. Claim `tomograph` on npm, the `Tomograph` GitHub org/handle, and `tomograph.dev`.
2. Rename the studio repo `otel-observability-pack-studio` → `tomograph` (keep redirect).
3. Update `package.json` (name, `bin`: `packc` + `tomograph`, description) and the CLI help banner.
4. Update README to the new header + tagline; rename in-app "Studio" strings to "Tomograph."
5. Rename the compiler entry point / docs to **`packc`**; introduce **x-ray** as the crawler verb in docs.
6. Cross-link: spec README ↔ Tomograph; add the one-liner to `otel-mcp-server`.
7. Announce: short "the studio is now Tomograph" note, paired with the OpenTelemetry-guidance positioning (prose blueprints vs. an executable compiler — you're a layer below, and complementary).

---

## 7. Watch-items

- **`timjr/tomograph`** (a dormant personal "tracing library") and the **PyPI 2019 CT simulator** are the only same-string echoes. Neither has traffic; the `@moebiusx` scope + the "Observability Compiler" descriptor fully disambiguate.
- **Never** let "X-Ray" creep up to brand level — it's AWS's tracing product. Verb only.
- Re-confirm `tomograph.dev` / `.io` and the org handle at point of registration; availability can change.
