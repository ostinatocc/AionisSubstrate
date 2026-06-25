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

Adapters may maintain read-model tables or snapshots, but those read models are derived from evidence events.

### 2. Validate Before Persisting Invalid Events

An adapter must not persist an event that cannot be applied to the current state.

Examples:

- lifecycle transition for a missing memory node must fail without appending an event;
- relation with a missing source or target must fail without appending an event;
- feedback for a missing memory node must fail without appending an event.

The file adapter validates against a cloned state before appending to `events.jsonl`.

The SQLite adapter validates inside the write transaction before inserting the event and read-model mutation.

### 3. Replay Must Rebuild the Same State

Reopening a store must recover the same memory nodes, relations, feedback, and decision trace events.

For the file adapter, `snapshot.json` is an optimization. If the snapshot is absent, the adapter must rebuild from `events.jsonl`.

For the SQLite adapter, the event table and read model tables must stay transactionally aligned.

### 4. Scope Isolation

All node, relation, feedback, and context compilation behavior is scoped.

A relation in `repo-a` must not affect admission in `repo-b`, even if memory ids match.

### 5. Controlled Forgetting

Forgetting is a lifecycle transition, not deletion.

Adapters may support physical compaction later, but the current contract keeps memory evidence visible through lifecycle and relation state.

### 6. Context Compilation Parity

Given the same durable state, adapters must compile the same admission buckets:

- `use_now`
- `inspect_before_use`
- `do_not_use`
- `rehydrate`

The contract benchmark checks file/SQLite parity for the same governed scenarios.

### 7. Decision Receipt Side Effect

`compileContext` records `memory.decision.recorded`.

This is intentional: exported context must leave a receipt. If a caller needs a side-effect-free preview, the API should add a separate preview method instead of weakening `compileContext`.

## Current Negative Controls

The test suite currently checks:

- failed lifecycle transition does not corrupt the file event log;
- failed relation writes do not persist corrupt events or partial rows;
- failed feedback writes do not persist corrupt events or partial rows;
- file and SQLite adapters compile identical buckets for the same evidence;
- superseded memory is blocked from direct use;
- archived evidence becomes a rehydrate hook;
- scope-local relations cannot leak across scopes;
- file snapshots can be rebuilt from append-only events;
- concurrent writes are serialized with contiguous event sequences;
- Runtime snapshot import opens source SQLite read-only.

## Non-Goals

The adapter contract does not define:

- vector similarity search;
- embedding storage/indexing;
- full Aionis Runtime admission policy;
- SaaS tenancy;
- external Agent orchestration.

Those can be layered above or beside the substrate. They must not weaken the substrate consistency contract.
