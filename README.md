# Aionis Substrate

Aionis Substrate is an independent storage-contract project for Aionis memory and execution state.

It defines the durable substrate Aionis needs for governed working memory: append-only evidence, lifecycle state, relations, feedback, decision receipts, and context admission buckets.

It is not Aionis Runtime core, not an Agent framework, and not a vector database replacement.

## Status

- Package: `@aionis/substrate`
- Version: `0.0.1`
- Runtime: Node 24+
- License field: `UNLICENSED` until an explicit public license is chosen
- Current adapters: file store and SQLite
- Runtime integration status: read-only snapshot import, reference-corpus parity, external admission parity, and isolated dual-write sidecar experiments

The project is intentionally independent from `AionisRuntime-focused`. It can import real Runtime Lite SQLite snapshots for validation and run isolated sidecar dual-write experiments, but it does not mutate Runtime source code or replace Runtime storage.

## Goal

Define the storage semantics Aionis needs before choosing or building a storage engine:

- append-only evidence events
- memory nodes with lifecycle and authority state
- relation graph for support, supersession, contradiction, invalidation, and payload requirements
- admission buckets: `use_now`, `inspect_before_use`, `do_not_use`, `rehydrate`
- decision traces that explain why memory was admitted, downgraded, blocked, or deferred
- controlled forgetting as state transitions, not silent deletion

## What It Is Not

- not a RAG library;
- not a vector index;
- not a chat memory store;
- not a benchmark harness;
- not the full Aionis Runtime policy engine.

The admission logic here is a substrate-level minimum contract. Full Aionis Runtime policy remains above this layer.

## Current Scope

This first version ships two embedded adapters:

- `events.jsonl` is the append-only evidence log.
- `snapshot.json` is a derived read model.
- `openSqliteAionisSubstrate` stores the same event log and read model in SQLite tables.
- SQLite uses Node's built-in `node:sqlite`; Node may print an experimental warning depending on the installed Node 24 build.
- every write is serialized and persisted.
- reopening the store rebuilds the same state from disk.
- every store reports its substrate schema version through `getStoreInfo`.
- the SQLite adapter persists schema metadata and rejects stores created by a newer unsupported schema.
- event-log backups can be exported, checksum-verified, and restored to either file or SQLite stores.
- checkpoint compaction can rewrite a store event log to one checksum-covered checkpoint event without changing governed state.
- `searchNodes` provides scoped deterministic lexical/structured search over memory nodes without mutating events or admission state. It is not ANN, vector recall, semantic retrieval, or a Recall Engine.
- `importRuntimeLiteSnapshot` can import an existing Runtime Lite SQLite database into an isolated Substrate store through a read-only source connection.

This is intentionally small. It proves the substrate contract without changing the existing Aionis Runtime.

## Contract

See [docs/STORE_CONTRACT.md](docs/STORE_CONTRACT.md).

API usage is documented in [docs/API_USAGE.md](docs/API_USAGE.md).

Adapter consistency requirements are documented in [docs/ADAPTER_CONTRACT.md](docs/ADAPTER_CONTRACT.md).

Backup and restore are documented in [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md).

Checkpoint compaction is documented in [docs/CHECKPOINT_COMPACTION.md](docs/CHECKPOINT_COMPACTION.md).

Runtime snapshot import is documented in [docs/RUNTIME_SNAPSHOT_IMPORT.md](docs/RUNTIME_SNAPSHOT_IMPORT.md).

Runtime reference corpus parity is documented in [docs/RUNTIME_REFERENCE_CORPUS.md](docs/RUNTIME_REFERENCE_CORPUS.md).

External admission parity is documented in [docs/EXTERNAL_ADMISSION_PARITY.md](docs/EXTERNAL_ADMISSION_PARITY.md).

Runtime dual-write experimentation is documented in [docs/RUNTIME_DUAL_WRITE_EXPERIMENT.md](docs/RUNTIME_DUAL_WRITE_EXPERIMENT.md).

## Quick Test

```bash
cd /Volumes/ziel/AionisSubstrate
npm install
npm run typecheck
npm test
```

Node 24+ is required because the project runs TypeScript directly.

## Contract Benchmark

```bash
npm run bench:contract
```

The benchmark runs the same governed memory scenarios against both embedded adapters and writes a report under `reports/substrate-contract-*`.

## Runtime Snapshot Import

```bash
node scripts/import-runtime-snapshot.ts \
  --source /path/to/aionis-runtime-lite.sqlite \
  --target /tmp/aionis-substrate.sqlite \
  --adapter sqlite \
  --scope repo-a
```

The source Runtime database is opened read-only. The command writes a separate Substrate store and prints imported/skipped counts.

Runtime snapshot smoke/parity:

```bash
npm run check:runtime-snapshot -- \
  --source /path/to/aionis-runtime-lite.sqlite \
  --scope repo-a \
  --output /tmp/aionis-runtime-snapshot-report.json
```

Add `--reference /path/to/runtime-guide-or-measure.json` to compare Substrate buckets against Runtime `agent_context` / `memory_decision_trace` bucket ids.

Runtime snapshot corpus smoke:

```bash
npm run check:runtime-corpus -- \
  --root /path/to/AionisRuntime-focused/.tmp \
  --max-files 20 \
  --max-scopes 20 \
  --max-scopes-per-file 3
```

This scans Runtime Lite SQLite files read-only, imports selected scopes into temporary Substrate stores, and writes an aggregate report under `reports/runtime-snapshot-corpus-*`.

Runtime reference corpus parity:

```bash
npm run check:runtime-reference-corpus -- \
  --source-root /path/to/AionisRuntime-focused/.tmp \
  --reference-root /path/to/AionisRuntime-focused/docs/examples \
  --max-source-files all \
  --max-scopes 100 \
  --max-scopes-per-file 20 \
  --max-references all
```

This scans Runtime `agent_context` / `memory_decision_trace` JSON and only counts a reference when its memory ids overlap a real Runtime SQLite scope. Unmatched demo/export files are reported separately.

External admission parity against focused Runtime:

```bash
npm run check:external-admission-parity -- \
  --runtime-root /path/to/AionisRuntime-focused
```

This starts focused Runtime with isolated Lite SQLite paths, calls the real external memory governance route, projects the same candidate memories into Substrate, and compares `use_now`, `inspect_before_use`, `do_not_use`, and `rehydrate`. The runner includes fixed contract scenarios plus deterministic generated variants; pass `--generated-count` and `--seed` to control the batch.

Runtime dual-write sidecar experiment:

```bash
npm run check:runtime-dual-write -- \
  --runtime-root /path/to/AionisRuntime-focused \
  --generated-count 8 \
  --chain-probe-count 4 \
  --concurrency 4
```

This starts focused Runtime with isolated Lite SQLite paths, calls real `observe -> guide -> feedback -> measure`, writes the same observed memory ids and outcomes into a separate Substrate SQLite store, compares guide buckets, closes and reopens Substrate, and compares again. It can add deterministic generated scenarios with `--generated-count`, run independent scopes concurrently with `--concurrency`, and record sidecar write-integrity plus lifecycle/relation chain probes. It does not mutate focused Runtime source code or replace Runtime storage.

Sustained sidecar soak:

```bash
npm run check:runtime-dual-write -- \
  --runtime-root /path/to/AionisRuntime-focused \
  --generated-count 96 \
  --chain-probe-count 16 \
  --concurrency 8
```

The soak report includes per-scenario latency summaries, chain-probe latency, reopen latency, event-sequence continuity, and SQLite file sizes.

## Development Checks

```bash
npm run typecheck
npm run build
npm test
npm run bench:contract
npm run check:pack
npm run check:install-smoke
```

The CI workflow runs the same checks on every push and pull request.

For a full local release gate:

```bash
npm run check:release
```

`check:pack` runs `npm pack --dry-run` and rejects package contents that would leak tests, reports, CI metadata, `node_modules`, or other non-runtime artifacts into the published tarball.

`check:install-smoke` packs the built package, installs that tarball into a fresh temporary project, imports `@aionis/substrate`, and runs real file/SQLite store operations from the installed package.

## Scale Smoke

```bash
npm run check:scale -- \
  --nodes 10000 \
  --scopes 10 \
  --relations 2000 \
  --feedback 1000
```

The scale smoke writes a temporary SQLite substrate, verifies event sequence continuity, runs scoped search, compiles context, compacts the store, reopens it, and writes a report under `reports/scale-*`.
