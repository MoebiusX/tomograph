# Repository Workflow Instructions

## Branch Workflow

- Use `develop` as the normal working branch for implementation, documentation, tests, and commits.
- Do not commit directly to `master` unless the user explicitly asks for an emergency direct change.
- Keep local `master` aligned with `origin/master`; treat it as the protected integration target.
- Start new work from the latest `origin/develop` when it exists. If `develop` is missing in a new clone, create it from the latest remote integration branch before making changes.
- Push completed work to `origin/develop` or to a feature branch based on `develop`, according to the user's request.
- After validation and CI pass, open a pull request from `develop` to `master` for review and merge.

## Validation Before Push or PR

- Run the repository's standard checks before pushing code changes. For this TypeScript project, use:
  - `npm run lint`
  - `npm test`
  - `npm run build`
- For documentation-only changes, a full test run is optional unless the user asks for it or the docs affect generated/tested content.
- If any validation cannot be run, state that clearly in the final summary.

## Git Hygiene

- Check `git status` before staging, committing, rebasing, or pushing.
- Stage only files related to the current task.
- Never overwrite or revert user changes unless the user explicitly requests it.
- If a push is rejected because the remote moved, fetch first, inspect the branch relationship, and rebase or merge according to the repo workflow.
- Prefer non-interactive git commands.
