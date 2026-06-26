# Aionis Store Contract

This document defines the first Aionis Substrate boundary. It is intentionally about memory semantics, not about a storage engine.

## Non-goals

- It is not a general database.
- It is not a vector database.
- It is not an Agent framework.
- It is not connected to Aionis Runtime yet.
- It must not encode task-specific repair rules or benchmark fixtures.

## Core Model

### Event Log

Every durable mutation is recorded as an append-only event:

- `memory.node.upsert`
- `memory.lifecycle.transition`
- `memory.relation.upsert`
- `memory.feedback.recorded`
- `memory.decision.recorded`
- `substrate.checkpoint.created`

The event log is the evidence trail. Read models may be rebuilt from it or maintained alongside it, but they are not the authority boundary.

`substrate.checkpoint.created` is a physical compaction event. It contains a checksum-covered snapshot of the current substrate state plus metadata about the covered event history. It does not suppress, archive, delete, or promote memory by itself.

### Store Schema Version

Every store has a substrate schema version. The current schema version is `1`.

Adapters must expose schema metadata through `getStoreInfo`:

- adapter kind
- schema version
- last event sequence
- event count

The SQLite adapter persists schema metadata in `substrate_metadata` and mirrors the same version into SQLite `user_version`. Opening a store with a newer unsupported schema must fail before any mutation occurs.

The file adapter writes the same schema version into `snapshot.json`. The append-only event log remains the durable evidence source; the snapshot schema is the derived read-model format.

### Backup Boundary

Backups export the append-only event log plus schema metadata and a SHA-256 checksum over the canonical event list.

Restore must verify the backup before writing a target store. Restored stores preserve original event ids and sequence numbers, then rebuild derived read models.

Payload files referenced by `payloadRef` are not embedded in the Substrate backup. They remain external artifacts and need their own retention policy.

### Checkpoint Compaction

Adapters may compact a long event log into a `substrate.checkpoint.created` event.

The checkpoint must preserve:

- covered event count;
- covered last sequence;
- SHA-256 checksum of the covered event list;
- current memory nodes;
- current relations;
- current feedback records;
- current decision traces.

After compaction, the physical log sequence restarts at the checkpoint event. Future writes continue after that checkpoint. This is a storage-maintenance boundary only; it must not change admission buckets or lifecycle state.

### Memory Node

A memory node is a governed memory object:

- `scope`
- `kind`
- `summary`
- `lifecycle`
- `authority`
- `confidence`
- optional target files
- optional payload pointer
- optional owner identity

The store treats execution memory, procedure memory, facts, preferences, claims, feedback, and trace pointers as first-class node kinds. It does not flatten all memory into free text.

### Search Contract

`searchNodes` is a read-only substrate query over memory nodes.

It must:

- require an explicit `scope`;
- keep all results scoped;
- support exact filters for kind, lifecycle, authority, target file, owner identity, confidence, and update time;
- provide deterministic lexical query scoring over node id, title, summary, target files, payload pointer, owner ids, and primitive metadata;
- return scored results with inspectable reason codes;
- avoid writing decision events or mutating lifecycle state.

Search is not admission. It may find candidate evidence, but it must not decide whether memory can influence the next Agent turn. Governed prompt surfaces are produced by `compileContext`.

### Relation Graph

Relations connect memory evidence:

- `supports`
- `derived_from`
- `supersedes`
- `contradicts`
- `invalidates`
- `requires_payload`

Relations are scoped. A relation in one scope must never affect admission in another scope.

### Lifecycle

Forgetting is represented as state, not deletion.

Allowed lifecycle states:

- `active`
- `candidate`
- `contested`
- `suppressed`
- `archived`
- `retired`
- `blocked`
- `rehydrate_required`

The store must keep the old evidence and express changes through lifecycle transitions and relations.

## Admission Contract

The store compiles memory into four buckets:

- `use_now`: directly usable context.
- `inspect_before_use`: relevant but not authoritative.
- `do_not_use`: blocked, superseded, contradicted, invalidated, rejected, suppressed, retired, or unsafe.
- `rehydrate`: payload exists but should not be stuffed into the prompt until requested.

The current deterministic admission baseline is deliberately conservative:

- active + trusted/verified memory may enter `use_now`.
- candidate/contested/advisory/unknown memory enters `inspect_before_use`.
- suppressed/retired/blocked/rejected memory enters `do_not_use`.
- archived or payload-required memory enters `rehydrate`.
- high-confidence supersede/contradict/invalidate relations block direct use.
- payload-required relations route to `rehydrate`.

This is not the final Aionis Runtime admission policy. It is the substrate-level minimum contract.

## Decision Trace

Every compiled context must include a decision trace:

- which memory id was routed
- what bucket it entered
- which reason code caused the decision
- which relation caused the decision when applicable

The trace is for audit/debug/measure. It must not mutate admission by itself.

`previewContext` is the side-effect-free admission preview. It returns the same bucket and reason-code shape as `compileContext`, but it must not append events or insert decision rows.

`compileContext` is intentionally not a pure read. It records `memory.decision.recorded` so every exported context has an auditable receipt. Tools that need a side-effect-free view must use `previewContext` instead of treating `compileContext` as read-only.

Decision and evidence records must also be inspectable without creating new events:

- `listRelations(scope, memoryId?)`
- `listFeedback({ scope, memoryId? })`
- `listDecisions(scope)`

These read APIs are for audit, debug, and measure surfaces. They do not compile context and do not mutate lifecycle, relation, feedback, decision, or checkpoint state.

## Adapter Requirements

Every adapter must satisfy the same observable contract:

1. Persist append-only events.
2. Preserve scope isolation.
3. Keep lifecycle transitions instead of deleting memory.
4. Compile the same admission buckets from the same node/relation state.
5. Return the same scoped search results from the same node state.
6. Record decision traces as events.
7. Return the same scoped audit reads from the same relation, feedback, and decision state.
8. Reopen cleanly and recover the same read model.
9. If compaction is supported, compact only through a validated checkpoint event.

Current adapters:

- `openFileAionisSubstrate`: append-only JSONL plus derived JSON snapshot.
- `openSqliteAionisSubstrate`: SQLite event table plus structured read model tables.
