# Changelog

All notable changes to Aionis Substrate are documented here.

## Unreleased

### Added

- Nothing yet.

### Changed

- Nothing yet.

## 0.1.1 - 2026-06-26

### Added

- v0.2 roadmap that freezes Substrate hardening scope and excludes Runtime policy, vector recall, Agent harnesses, and SaaS concerns.
- Scoped audit read APIs for relations, feedback, and decision receipts.
- SQLite schema migration registry with durable applied-migration records.
- Durability negative controls for orphan decision receipts, checksum-valid corrupt backups, and post-compaction invalid writes.
- Runtime sidecar stabilization report that combines read-only snapshot parity and same-source reference corpus parity.
- Published package CLI `aionis-substrate` with a `sidecar` command for read-only Runtime sidecar stabilization checks.
- CLI documentation covering install, sidecar reports, and common failure interpretation.

### Changed

- Documented audit reads as side-effect-free adapter parity surfaces.
- Documented SQLite migrations as explicit adapter-scoped schema changes.
- Decision traces now require every decision memory id to reference an existing node in the same scope.
- Documented Runtime sidecar validation as staged gates, keeping real dual-write explicit and isolated.
- README now separates package install, minimal API usage, and Runtime sidecar validation paths.

## 0.1.0 - 2026-06-26

### Added

- Independent `@aionis/substrate` package with file and SQLite adapters.
- Append-only memory event log with deterministic replay.
- Memory nodes with lifecycle, authority, confidence, owner, target-file, metadata, and payload references.
- Relation graph for `supports`, `supersedes`, `contradicts`, `invalidates`, and `requires_payload`.
- Outcome feedback records tied to concrete memory ids.
- Governed context surfaces: `use_now`, `inspect_before_use`, `do_not_use`, and `rehydrate`.
- `compileContext()` for auditable context compilation with `memory.decision.recorded` receipts.
- `previewContext()` for side-effect-free admission previews.
- Deterministic scoped `searchNodes()` over lexical and structured fields.
- Backup export, integrity verification, and restore to file or SQLite stores.
- Checkpoint compaction that preserves governed state while collapsing event history.
- Runtime Lite snapshot import and parity tooling for isolated validation against Aionis Runtime data.
- External admission parity and dual-write sidecar experiments.
- Package, install, contract, and scale release checks.
- Basic example covering file + SQLite stores, preview, compile, feedback, search, and backup.

### Boundaries

- The package is a substrate contract, not the full Aionis Runtime policy engine.
- `searchNodes()` is deterministic lexical/structured search, not vector search, ANN, or semantic recall.
- SQLite uses Node's built-in `node:sqlite`, which may emit an experimental warning on Node 24.
