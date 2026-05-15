# Changelog

## 0.2.0

### Added
- **Atlas** — four-metaphor visualisation tab (Stratigraphy, Periodic Table,
  Constellation, Skyline). Each metaphor reads the same two packs and makes
  a different argument; each suits a different audience.
- **Live MCP integration** — `tools/fetch-live-pack.mjs` reads from an
  MCP-exposed observability surface (JSON-RPC over Streamable HTTP), maps
  responses to ObservabilityPack artefacts, and writes a JSON file. The
  studio's loader picks it up at boot.
- **`LIVE` source tag** — a new source pill (pulsing cyan) for artefacts
  verified by MCP at refresh time. Orthogonal to BAU/SLA/NEW/GAP — claims
  are about repo; LIVE is about telemetry-reality.
- **Liveness badge** in the header — `live · 5m ago` / `embedded snapshot` /
  `stale · 36h ago` / `MCP error`.
- **File picker + drag-and-drop** for loading packs from disk.
- **JSON Schema** for pack validation (`schema/pack.schema.json`).
- **MCP evidence in drawer** — when an artefact has an `mcp` field, the
  drawer renders the tool name, refresh timestamp, and evidence dict.
- **CI cron example** — `.github/workflows/refresh-live-pack.yml`.

### Changed
- Single-file studio split into a real repo with `studio/`, `packs/`,
  `tools/`, `schema/`, `docs/`.
- Embedded packs extracted as standalone JSON in `packs/`.
- Stats banner widened to include `LIVE (mcp-verified)`.
- Skyline view auto-spaces colliding labels with leader lines.

## 0.1.0

Initial release. Single-file HTML studio with the 5-layer
ObservabilityPack model (L1 Contract → L2 Telemetry → L3 Insight → L4
Action, L5 Validation as orthogonal column, Governance underneath).
Views: Current, Target, Compare, Schema. Drawer drilldown. Print
stylesheet.
