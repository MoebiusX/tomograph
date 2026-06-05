# vendor/observability-pack-spec

A pinned copy of the [MoebiusX/otel-observability-pack](https://github.com/MoebiusX/otel-observability-pack)
spec. The studio validates, adapts, and renders against this copy — never against a network fetch — so it
is reproducible offline and drift against upstream is detectable.

## Contents

| Vendor path | Upstream path |
|---|---|
| `v1.2/observability-pack.schema.json` | `schema/observability-pack.schema.json` |
| `v1.2/spec.md` | `spec/ObservabilityPack-Spec.md` |
| `v1.2/examples/payment-service.pack.yaml` | `examples/payment-service.pack.yaml` |
| `v1.2/docs/maturity-model.md` | `docs/maturity-model.md` |

`VERSIONS.json` records the upstream commit, fetch timestamp, and per-file SHA-256 of every vendored file.

## Refreshing

```bash
# Sync to current upstream main HEAD
node tools/sync-spec.mjs

# Sync to a specific ref or commit
node tools/sync-spec.mjs --ref e324f096

# Verify on-disk files match VERSIONS.json (CI-friendly)
node tools/sync-spec.mjs --check
```

The sync script uses the `gh` CLI for authentication and rate-limit headroom; no npm deps.
