# Tomograph migration — execution checklist

The rename `otel-observability-pack-studio → Tomograph` ships across two
tracks. **Track 1 (this PR)** is the in-code work: all visible strings,
docs, the package.json, the README. **Track 2 (manual)** is the things
only you can do — claiming external surfaces (GitHub, npm, domains) and
the repo rename itself.

This doc is the checklist for Track 2. Read it through before pulling the
trigger on anything — the order matters in places.

---

## Pre-rename — claim defensively (do these first, in any order)

These can happen any time after PR #31 merges. They protect the name
before anyone else can squat it. None of them affect the existing repo
or the running studio.

- [ ] **npm**: `npm publish --dry-run` from a clone after the rename PR
      merges (just to verify package.json is sane); then
      `npm publish --access public` to claim the name. The package is
      already named `tomograph` in package.json.
- [ ] **GitHub org**: visit https://github.com/account/organizations/new
      and create the `Tomograph` organization. This reserves the handle
      even if the repo stays under `MoebiusX` for now.
- [ ] **Domains**: register `tomograph.dev` (primary) at a registrar.
      Add `tomograph.io` as a defensive forward to `.dev`. Set DNS to
      park them or point at the eventual landing page.

Roughly 15 minutes total. Do them in one sitting before announcing.

---

## Repo rename — the main event

When you're ready to rename the studio repo:

- [ ] On GitHub, go to repo settings → rename
      `otel-observability-pack-studio` → `tomograph`.
      GitHub creates a permanent redirect from the old URL, so:
      - existing clones (`git remote -v`) keep working
      - existing PR URLs keep working
      - existing CI integrations keep working
      - external docs and slack pins keep working

- [ ] After the rename, push a tiny no-op commit so the redirect is
      exercised at least once. (Some downstream tools cache the old
      URL until the next push.) Example:
      ```bash
      git pull
      echo "" >> README.md
      git commit -am "chore: post-rename redirect ping"
      git push
      ```

- [ ] Update your local clone's remote URL to the new canonical:
      ```bash
      git remote set-url origin https://github.com/MoebiusX/tomograph.git
      ```
      The old URL keeps working via redirect, but using the canonical
      one avoids confusion in `git remote -v` output.

---

## Cross-repo housekeeping

In the spec repo (`otel-observability-pack`):

- [ ] Add to the README, near the top:
      > Reference toolchain: **[Tomograph](https://github.com/MoebiusX/tomograph)** — the Observability Compiler. Compiles and scores packs.

In the MCP repo (`otel-mcp-server`):

- [ ] Add a one-liner to the README:
      > Part of the **[Tomograph](https://github.com/MoebiusX/tomograph)** ecosystem — turns *declared* into *verified*.

In any internal references (Notion, Slack, decks):

- [ ] Sweep for "studio" / "ObservabilityPack Studio" / the old repo
      URL. Update to "Tomograph" / "the Observability Compiler" / the
      new URL.

---

## CLI binaries — `packc` and `tomograph`

The `package.json` doesn't yet declare `bin` entries because the
underlying CLI dispatcher hasn't been written. When you're ready to
introduce the binaries (post-FOST is fine):

- [ ] Create `tools/cli.mjs` as a thin dispatcher that reads `argv[2]`
      and delegates:
      ```
      packc validate <file>          → tools/validate-pack.mjs
      packc compile <file> <target>  → tools/lib/compile.mjs (programmatic)
      packc x-ray <repo-dir>         → tools/crawl-repo.mjs
      packc adapt <file>             → tools/adapt-spec-pack.mjs
      tomograph                      → server/index.mjs (boots studio)
      ```
- [ ] Add to package.json:
      ```json
      "bin": {
        "packc": "./tools/cli.mjs",
        "tomograph": "./tools/cli.mjs"
      }
      ```
- [ ] Verify with `npm link` locally that `packc --help` and
      `tomograph` both work.

---

## Communications — when you announce

- [ ] **Short note on the repo**: pin an issue or update the About
      blurb on GitHub:
      > "Tomograph — the Observability Compiler. Trust what your eyes see."
- [ ] **Pair on first mention always**: "Tomograph — the Observability
      Compiler" until the name carries itself. Section 5 of the plan
      doc has the positioning copy ready to use.
- [ ] **Disambiguate from neighbours**:
      - "Tomograph" ≠ AWS X-Ray. We use *x-ray* as a verb only ("x-ray
        a repo to draft a pack"), never as a brand.
      - "Tomograph" ≠ the dormant 2019 PyPI CT-simulator. No real
        collision; the "Observability Compiler" descriptor disambiguates
        instantly.
      - "Tomograph" ≠ `timjr/tomograph` (a dead personal tracing
        library). No traffic, no real collision.

---

## Open after the demo

- [ ] Decide whether to publish the npm package as plain `tomograph`
      or as `@moebiusx/tomograph` (scoped). Scoped is more polite to
      future contributors who might want to fork; unscoped feels
      cleaner for end users.
- [ ] Decide whether the `KrystalineX` repo stays as-is or renames to
      `Krystaline` (matching the brand). No urgency; auto-redirects
      keep everything working either way.
- [ ] If/when Python ships, use a scoped dist name (`moebiusx-tomograph`)
      since the bare `tomograph` PyPI name is taken by a 2019 alpha
      that's not worth PEP-541-reclaiming.

---

## When you're done

The studio's home page will already say **Tomograph — the Observability
Compiler**. The `package.json` already says `tomograph`. The README
already leads with the new positioning. All that's left after the
manual steps above is the repo URL itself catching up with the brand —
and once it does, everything else clicks into place.

Don't rush the order. The visible brand is the demo's headline; the
structural rename is the long tail.
