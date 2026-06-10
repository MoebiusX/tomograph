# Archived Docs

Superseded planning and status documents, kept for historical context.
**Nothing in this directory describes current behavior** — for the live doc
set, start at the repo [README](../../README.md) "Key Docs" section. Archived
documents are frozen as written: internal links and file paths inside them
may be stale, and they are not updated when the product changes.

A plan lands here when it was either shipped (and the live docs now describe
the real behavior), absorbed into a newer plan, or parked. The forward-
looking backlog lives in [docs/VALUE_BACKLOG.md](../VALUE_BACKLOG.md);
engineering-health work in [docs/REFACTORING_PLAN.md](../REFACTORING_PLAN.md).

| Document | What it was | Why archived |
|---|---|---|
| [COMPOSE_MODE_PLAN.md](COMPOSE_MODE_PLAN.md) | Drag-and-drop pack authoring from a block library | Parked — superseded by the crawl / draft-from-MCP / upload pack-creation paths |
| [DEPENDENCY_VIEW_PLAN.md](DEPENDENCY_VIEW_PLAN.md) | Per-artefact REQUIRES / USED BY traceability drawer | Shipped in evolved form — see Traceability (Advanced) and the drawer's cross-references |
| [REFERENCE_CATALOGUE_PLAN.md](REFERENCE_CATALOGUE_PLAN.md) | Curated best-practice reference pack catalogue design | Shipped — `reference-packs/` + Advanced → References; growth backlog in VALUE_BACKLOG.md |
| [CATALOGUE_SEED_SPRINT.md](CATALOGUE_SEED_SPRINT.md) | Sprint plan for the first catalogue seed packs | Executed — Kafka / Prometheus / Grafana packs landed with evidence docs |
| TOMOGRAPH_BRAND_PLAN.md *(local-only)* | Brand/rename strategy | Executed (the rename happened); kept out of the public repo by .gitignore |
| TOMOGRAPH_MIGRATION_CHECKLIST.md *(local-only)* | Launch/migration backlog | Superseded by VALUE_BACKLOG.md + RELEASE_READINESS.md; local-only |
| PROJECT_STATUS_SURVEY.md *(local-only)* | Point-in-time project status survey | Snapshot only; local-only |

*Local-only* files are present on maintainer machines under this directory
but excluded from the public repo by `.gitignore`.
