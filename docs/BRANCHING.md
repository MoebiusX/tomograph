# Branching Model

The contract for how change flows through this repository. It applies to
every contributor — human or agent. The shape is a lightweight GitFlow-style
trunk pair plus agent topic branches.

```
codex/<topic> ──PR──▶ develop ──promotion PR──▶ main ──▶ tag vX.Y.Z
                      (default,                (release
                       integration)             line)
```

## The lanes

### `main` — the release line

- Advances **only** by promotion PR from `develop`
  (e.g. [#39](https://github.com/MoebiusX/tomograph/pull/39),
  [#50](https://github.com/MoebiusX/tomograph/pull/50)). Never receives
  direct pushes or topic-branch merges.
- Release tags (`v0.3.0`, …) are cut on `main` at promoted commits.
- Merging to `main` is the **maintainer's act**: agents prepare and open
  the promotion PR; the maintainer reviews and merges.

### `develop` — the integration line

- The GitHub **default branch** (scheduled workflows read their triggers
  from here).
- Day-to-day execution-track work lands here directly in small,
  individually verified commits — this is the lead agent's sanctioned
  lane. Everything else arrives by PR from a topic branch.

### `codex/<topic>` — topic branches

- One branch per task, created **from `develop`**, worked in an isolated
  worktree, merged **into `develop`** by PR after review. Never push
  `develop` or `main` directly from a topic-branch task.
- Historical note: early topic PRs (#44–#48) targeted `main` directly,
  which forced back-merges into `develop`. That pattern is retired —
  `main` only advances by promotion.
- Research/spec-track branches (e.g.
  [#49](https://github.com/MoebiusX/tomograph/pull/49)) are docs-only and
  reviewed by the execution lead before merge, so load-bearing engine
  semantics never move underneath in-flight implementation work.

## The per-commit bar (develop and topic branches alike)

Every commit must:

1. use a conventional-commit message (`feat(server): …`, `fix(studio): …`,
   `docs: …`) whose body says *why*, not just *what*;
2. be green on `npm run lint` (ESLint, 0 errors) and `npm test` (the full
   aggregate);
3. be **browser-verified** when the change is observable in the studio
   (render the affected view, exercise the interaction, check the console);
4. carry a `Co-Authored-By` trailer when an agent wrote it.

## Multi-writer rules

Several writers (maintainer, lead agent, task agents) share this repo:

- **Always `git fetch` before pushing.** Expect non-fast-forward
  rejections and resolve them by merging, never by force-push.
- **Never force-push** `develop` or `main`.
- One writer per checkout: task agents use their own worktrees
  (`git worktree add`), never the maintainer's or another agent's working
  tree.

## Promotion cadence

Promote `develop → main` at **milestone points** — a coherent, demo-able
unit of work (a release-readiness slice, a completed backlog item set) —
not per commit. The promotion PR describes the unit; a release tag follows
on `main` when the milestone warrants one.

## Roles

| Actor | Lane | May merge to |
|---|---|---|
| Maintainer | everywhere | `main` (promotions), `develop` |
| Lead agent (execution track) | `develop` direct commits; opens promotion PRs | `develop` |
| Task agents (Codex, etc.) | `codex/<topic>` worktrees; in by PR | — (PRs only) |
