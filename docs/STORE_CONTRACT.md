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

The event log is the evidence trail. Read models may be rebuilt from it or maintained alongside it, but they are not the authority boundary.

### Store Schema Version

Every store has a substrate schema version. The current schema version is `1`.

Adapters must expose schema metadata through `getStoreInfo`:

- adapter kind
- schema version
- last event sequence
- event count

The SQLite adapter persists schema metadata in `substrate_metadata` and mirrors the same version into SQLite `user_version`. Opening a store with a newer unsupported schema must fail before any mutation occurs.

The file adapter writes the same schema version into `snapshot.json`. The append-only event log remains the durable evidence source; the snapshot schema is the derived read-model format.

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

`compileContext` is intentionally not a pure read. It records `memory.decision.recorded` so every exported context has an auditable receipt. Tools that need a side-effect-free preview should add a separate preview API instead of treating `compileContext` as read-only.

## Adapter Requirements

Every adapter must satisfy the same observable contract:

1. Persist append-only events.
2. Preserve scope isolation.
3. Keep lifecycle transitions instead of deleting memory.
4. Compile the same admission buckets from the same node/relation state.
5. Record decision traces as events.
6. Reopen cleanly and recover the same read model.

Current adapters:

- `openFileAionisSubstrate`: append-only JSONL plus derived JSON snapshot.
- `openSqliteAionisSubstrate`: SQLite event table plus structured read model tables.
