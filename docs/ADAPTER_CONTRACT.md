# Adapter Contract

Aionis Substrate adapters must preserve the same memory semantics even when their storage engines differ.

Current adapters:

- `openFileAionisSubstrate`: append-only JSONL event log plus derived JSON snapshot.
- `openSqliteAionisSubstrate`: SQLite event log plus structured read model tables.

## Required Guarantees

### 1. Append-Only Evidence

Every durable mutation must be recorded as an event:

- `memory.node.upsert`
- `memory.lifecycle.transition`
- `memory.relation.upsert`
- `memory.feedback.recorded`
- `memory.decision.recorded`
- `substrate.checkpoint.created`

Adapters may maintain read-model tables or snapshots, but those read models are derived from evidence events.

`substrate.checkpoint.created` is allowed only for physical log compaction. It must carry the current read model plus checksum metadata for the events it covers.

### 2. Validate Before Persisting Invalid Events

An adapter must not persist an event that cannot be applied to the current state.

Examples:

- lifecycle transition for a missing memory node must fail without appending an event;
- relation with a missing source or target must fail without appending an event;
- feedback for a missing memory node must fail without appending an event.
- decision trace for a missing memory node must fail without appending an event.

The file adapter validates against a cloned state before appending to `events.jsonl`.

The SQLite adapter validates inside the write transaction before inserting the event and read-model mutation.

### 3. Replay Must Rebuild the Same State

Reopening a store must recover the same memory nodes, relations, feedback, and decision trace events.

For the file adapter, `snapshot.json` is an optimization. If the snapshot is absent, the adapter must rebuild from `events.jsonl`.

For the SQLite adapter, the event table and read model tables must stay transactionally aligned.

### 3.1 Schema Version Must Be Explicit

Adapters must expose store metadata through `getStoreInfo`.

The current schema version is `1`.

The SQLite adapter must persist schema metadata in `substrate_metadata`, set SQLite `user_version`, and refuse to open a database whose schema version is newer than the runtime supports. Silent best-effort reads of future schemas are not allowed.

SQLite schema changes must go through the adapter migration registry. Applied migrations are recorded in `substrate_schema_migrations` with version, name, and timestamp. A migration ledger whose recorded name no longer matches the current registry is treated as corruption and the store is rejected.

The file adapter must write the schema version into `snapshot.json` and report the same version through `getStoreInfo`.

### 4. Scope Isolation

All node, relation, feedback, and context compilation behavior is scoped.

A relation in `repo-a` must not affect admission in `repo-b`, even if memory ids match.

### 5. Controlled Forgetting

Forgetting is a lifecycle transition, not deletion.

Physical compaction must not be used as forgetting. Memory evidence remains visible through lifecycle and relation state after a checkpoint.

### 5.1 Checkpoint Compaction

If an adapter implements `compact()`, it must:

- validate the checkpoint before replacing the event log;
- include covered event count, covered last sequence, and covered event checksum;
- preserve the current nodes, relations, feedback, and decision traces;
- keep `compileContext` buckets unchanged after reopen;
- continue future writes with contiguous event sequences after the checkpoint.

The file adapter rewrites `events.jsonl` atomically. The SQLite adapter replaces `substrate_events` in a transaction and resets the event sequence table.

### 6. Context Compilation Parity

Given the same durable state, adapters must compile the same admission buckets:

- `use_now`
- `inspect_before_use`
- `do_not_use`
- `rehydrate`

The contract benchmark checks file/SQLite parity for the same governed scenarios.

### 7. Search Parity

Given the same durable node state, adapters must return the same `searchNodes` ids, scores, and reason codes for the same scoped query.

Search is read-only. It must not append `memory.decision.recorded`, lifecycle events, or any other event.

Search is not a vector index and not the full Runtime admission policy. It is a deterministic substrate query for locating candidate memory nodes before higher-level governance decides whether they can affect an Agent turn.

When a candidate index is configured, both adapters must preserve the same final `searchNodes` ids, scores, and reason-code semantics. The index is allowed to preselect candidate ids, but the adapter must reload canonical nodes from the truth store before returning results.

Candidate index synchronization requirements:

- open-time rebuild is enabled by default;
- `putNode` write-through updates the index after the durable node mutation succeeds;
- `transitionLifecycle` write-through updates the index after the durable lifecycle mutation succeeds;
- `verify(nodes)` must expose missing, orphan, and stale entries so operators can rebuild instead of trusting silent drift.

### 8. Context Preview and Decision Receipt Side Effect

`previewContext` returns the same governed buckets and decision-reason shape as `compileContext`, but it is read-only. It must not append `memory.decision.recorded`, lifecycle events, relation events, feedback events, or any other event.

`compileContext` records `memory.decision.recorded`.

This is intentional: exported context must leave a receipt. Callers that need a side-effect-free preview must use `previewContext` instead of weakening `compileContext`.

### 9. Audit Read API Parity

Adapters must expose the same scoped audit reads:

- `listRelations(scope, memoryId?)`
- `listFeedback({ scope, memoryId? })`
- `listDecisions(scope)`

These APIs must be side-effect-free. They must not append decision events, lifecycle transitions, relation writes, feedback writes, or checkpoints.

When `memoryId` is supplied to `listRelations`, adapters must return relations where that memory is either the source or target. When `memoryId` is supplied to `listFeedback`, adapters must return feedback attached to that memory only.

### 10. Backup and Restore Integrity

Backup export must operate over the append-only event log, not only over derived read-model tables or snapshots.

Restore must verify:

- supported backup and schema version;
- contiguous event sequence;
- duplicate event ids;
- event reference integrity, including decision trace memory ids;
- header event counts;
- SHA-256 checksum.

File and SQLite restore targets must reject non-empty destinations unless explicit overwrite is requested.

## Current Negative Controls

The test suite currently checks:

- failed lifecycle transition does not corrupt the file event log;
- failed relation writes do not persist corrupt events or partial rows;
- failed feedback writes do not persist corrupt events or partial rows;
- failed decision writes do not persist corrupt events or partial rows;
- file and SQLite adapters compile identical buckets for the same evidence;
- superseded memory is blocked from direct use;
- archived evidence becomes a rehydrate hook;
- scope-local relations cannot leak across scopes;
- file snapshots can be rebuilt from append-only events;
- concurrent writes are serialized with contiguous event sequences;
- store schema version is reported by both adapters;
- SQLite schema metadata and migration ledger are persisted, backfilled for legacy v1 stores, and future unsupported schemas are rejected;
- event-log backups verify checksums and restore to file and SQLite stores;
- event-log backups reject checksum-valid decision traces that reference missing memory nodes;
- checkpoint compaction preserves governed state and restarts future event sequences after the checkpoint;
- compacted checkpoints reject corrupt decision references on reopen;
- relation, feedback, and decision writes remain atomic after checkpoint compaction;
- file and SQLite adapters return identical read-only search results for the same scoped query;
- file and SQLite adapters return identical scoped audit reads without mutating event logs;
- Runtime snapshot import opens source SQLite read-only.

## Non-Goals

The adapter contract does not define:

- vector similarity search;
- embedding model management;
- full Aionis Runtime admission policy;
- SaaS tenancy;
- external Agent orchestration.

Those can be layered above or beside the substrate. They must not weaken the substrate consistency contract.
