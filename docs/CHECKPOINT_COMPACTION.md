# Checkpoint Compaction

Aionis Substrate stores durable memory changes as events. Over time, a long-running store can compact its physical event log into a checkpoint event.

Compaction is storage maintenance. It is not forgetting, admission policy, or evidence deletion.

## Checkpoint Event

`compact()` rewrites the event log to one event:

- `substrate.checkpoint.created`

The checkpoint payload contains:

- substrate schema version;
- number of covered events;
- last covered event sequence;
- SHA-256 checksum of the covered canonical event list;
- current memory nodes;
- current relations;
- current feedback records;
- current decision traces.

After compaction, the event log starts from the checkpoint at sequence `1`. Future writes continue from sequence `2`.

## Adapter Behavior

The file adapter:

- validates the checkpoint with the same replay state machine used by backup verification;
- atomically replaces `events.jsonl`;
- rewrites `snapshot.json`.

The SQLite adapter:

- builds the checkpoint from the structured read model;
- validates the checkpoint with the same replay state machine;
- replaces the event table inside a transaction;
- resets the event AUTOINCREMENT sequence.

Both adapters preserve the same observable governed state after reopen.

## Backup Boundary

Backups can export compacted stores. A compacted backup may contain a checkpoint event instead of the original full event history.

The checkpoint keeps audit metadata for the covered history through:

- `coveredEventCount`
- `coveredLastSequence`
- `coveredEventsSha256`

Payload files referenced by `payloadRef` are still external artifacts. Compaction does not embed them.

## Usage

```ts
const report = await store.compact();

console.log(report.before.eventCount);
console.log(report.after.eventCount);
console.log(report.after.checkpointEventId);
```

If the store has no events, `compact()` returns `compacted: false`.

## Non-Goals

Checkpoint compaction does not:

- remove stale memories;
- suppress memories;
- archive payload files;
- change `use_now`, `inspect_before_use`, `do_not_use`, or `rehydrate`;
- replace Aionis Runtime policy.
