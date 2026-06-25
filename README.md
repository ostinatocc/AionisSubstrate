# Aionis Substrate

Aionis Substrate is an independent experiment for an Aionis-native memory and execution-state store.

It is not Aionis Runtime core, not a vector database replacement, and not connected to `AionisRuntime-focused` yet.

## Goal

Define the storage semantics Aionis needs before choosing or building a storage engine:

- append-only evidence events
- memory nodes with lifecycle and authority state
- relation graph for support, supersession, contradiction, invalidation, and payload requirements
- admission buckets: `use_now`, `inspect_before_use`, `do_not_use`, `rehydrate`
- decision traces that explain why memory was admitted, downgraded, blocked, or deferred
- controlled forgetting as state transitions, not silent deletion

## Current Scope

This first version ships two embedded adapters:

- `events.jsonl` is the append-only evidence log.
- `snapshot.json` is a derived read model.
- `openSqliteAionisSubstrate` stores the same event log and read model in SQLite tables.
- every write is serialized and persisted.
- reopening the store rebuilds the same state from disk.
- `importRuntimeLiteSnapshot` can import an existing Runtime Lite SQLite database into an isolated Substrate store through a read-only source connection.

This is intentionally small. It proves the substrate contract without changing the existing Aionis Runtime.

## Contract

See [docs/STORE_CONTRACT.md](docs/STORE_CONTRACT.md).

Runtime snapshot import is documented in [docs/RUNTIME_SNAPSHOT_IMPORT.md](docs/RUNTIME_SNAPSHOT_IMPORT.md).

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
