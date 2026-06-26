# Changelog

All notable changes to Aionis Substrate are documented here.

## Unreleased

### Added

- Live sidecar integration example that builds a real Runtime Lite SQLite source, mirrors it through the checkpointed sidecar, and previews governed context buckets.
- Optional candidate index boundary with rebuild, verify, write-through node sync, and candidate-id narrowing before canonical Substrate scoring.
- Optional Zvec-backed candidate index adapter for local vector preselection while keeping file/SQLite as truth storage.
- Runtime Zvec candidate-index validation gate that imports real Runtime Lite SQLite scopes into isolated Substrate stores and checks Zvec health plus canonical-search parity.
- Zvec scale-maintenance gate that writes a SQLite truth store with a Zvec candidate sidecar, verifies write-through health, wide-search parity, narrow seeded recovery, lifecycle-transition sync, compaction, and reopen rebuild.
- Provider-backed Zvec embedding eval that calls OpenAI-compatible or MiniMax native embeddings endpoints and reports raw Zvec candidate hit rate separately from final Substrate search hit rate.
- Candidate-index semantic fusion that lets Zvec/provider candidates influence final `searchNodes()` ranking without bypassing scope, lifecycle, authority, confidence, or target-file filters.

## 0.1.4 - 2026-06-26

### Added

- Runtime live sidecar API and CLI command for checkpointed, repeated Runtime Lite SQLite mirroring into a separate Substrate target.
- Runtime live sidecar bounded watch mode with interval polling, aggregate reports, and a single-instance checkpoint lock.
- Runtime live sidecar soak check that repeatedly appends real Runtime Lite SQLite evidence and verifies checkpointed watch sync into a separate Substrate SQLite target.
- Runtime live sidecar documentation covering checkpoint behavior, dry runs, watch mode, soak checks, and product boundaries.

## 0.1.3 - 2026-06-26

### Added

- Runtime Lite snapshot import summaries now expose structured source-table, skip-reason, and JSON issue diagnostics.
- Runtime snapshot corpus reports now aggregate bucket totals plus node, relation, feedback, decision, source-table, skip-reason, and JSON issue matrix diagnostics.

## 0.1.2 - 2026-06-26

### Added

- CLI commands for `inspect`, `preview-context`, `backup`, `restore`, `compact`, and `import-runtime-snapshot`.
- CLI integration tests that run the store commands against real SQLite stores and Runtime Lite snapshot fixtures.

### Changed

- CLI documentation now covers store operations, Runtime snapshot import, and sidecar checks as separate surfaces.

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
