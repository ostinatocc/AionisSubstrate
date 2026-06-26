# API Usage

This document shows the first public contract for using Aionis Substrate directly.

The API is intentionally small:

- write memory nodes;
- write relations between memory nodes;
- record outcome feedback;
- search memory nodes with scoped filters;
- compile governed context;
- inspect decision traces.

## Open a Store

SQLite adapter:

```ts
import { openSqliteAionisSubstrate } from "@aionis/substrate";

const store = await openSqliteAionisSubstrate({
  path: "/tmp/aionis-substrate.sqlite",
});
```

File adapter:

```ts
import { openFileAionisSubstrate } from "@aionis/substrate";

const store = await openFileAionisSubstrate({
  dir: "/tmp/aionis-substrate-file-store",
});
```

Both adapters expose the same contract.

## Inspect Store Metadata

```ts
const info = await store.getStoreInfo();

console.log(info.adapter);
console.log(info.schemaVersion);
console.log(info.lastSequence);
console.log(info.eventCount);
```

The schema version is part of the substrate contract. A newer unsupported SQLite schema is rejected on open instead of being read best-effort.

## Write Execution Memory

```ts
await store.putNode({
  id: "route-current",
  scope: "repo-a",
  kind: "procedure",
  title: "Current route",
  summary: "Use src/runtime.ts as the validated current route.",
  lifecycle: "active",
  authority: "trusted",
  confidence: 0.92,
  targetFiles: ["src/runtime.ts", "tests/runtime.test.ts"],
  metadata: {
    source: "agent_observe",
    verifier: "npm test passed",
  },
});
```

## Keep Old Evidence Without Trusting It

```ts
await store.putNode({
  id: "route-old",
  scope: "repo-a",
  kind: "procedure",
  title: "Old route",
  summary: "Use src/legacy.ts as the previous route.",
  lifecycle: "active",
  authority: "trusted",
  confidence: 0.8,
  targetFiles: ["src/legacy.ts"],
});

await store.putRelation({
  scope: "repo-a",
  kind: "supersedes",
  sourceId: "route-current",
  targetId: "route-old",
  confidence: 0.88,
  metadata: {
    reason: "newer verifier evidence replaced the old route",
  },
});
```

The old route remains in the evidence log. It is not silently deleted. The relation prevents it from becoming direct-use context.

## Record Feedback

```ts
await store.recordFeedback({
  scope: "repo-a",
  memoryId: "route-current",
  outcome: "positive",
  strength: "strong",
  evidenceRef: "trace://run-2026-06-25/verifier",
  runId: "run-2026-06-25",
});
```

Feedback is evidence. It does not bypass lifecycle, relation, or authority checks.

## Search Memory Nodes

```ts
const results = await store.searchNodes({
  scope: "repo-a",
  query: "runtime verifier",
  lifecycle: ["active"],
  authority: ["trusted"],
  targetFiles: ["src/runtime.ts"],
  minConfidence: 0.8,
  limit: 10,
});

for (const result of results) {
  console.log(result.node.id, result.score, result.reasons);
}
```

Search is a scoped, read-only substrate query.

It supports structured filters for kind, lifecycle, authority, target files, owner identity, confidence, and update time. The optional `query` is deterministic lexical scoring over node id, title, summary, target files, payload pointer, owner ids, and primitive metadata.

It is not vector search, semantic adjudication, or admission policy. Use `compileContext` when the Agent needs governed prompt surfaces.

## Compile Context

```ts
const context = await store.compileContext({
  scope: "repo-a",
  query: "continue the runtime implementation",
});

console.log(context.use_now.map((node) => node.id));
console.log(context.inspect_before_use.map((node) => node.id));
console.log(context.do_not_use.map((node) => node.id));
console.log(context.rehydrate.map((node) => node.id));
console.log(context.decision_trace);
```

The compiled context has four surfaces:

- `use_now`: directly usable context;
- `inspect_before_use`: relevant but not authoritative;
- `do_not_use`: blocked, superseded, invalidated, or unsafe;
- `rehydrate`: payload is available but should not flood the prompt unless requested.

`compileContext` records a `memory.decision.recorded` event. It is intentionally auditable, not a pure read.

## Compact the Event Log

```ts
const report = await store.compact();

console.log(report.compacted);
console.log(report.before.eventCount);
console.log(report.after.eventCount);
```

Compaction is physical log maintenance. It writes a `substrate.checkpoint.created` event that preserves the current nodes, relations, feedback, decision traces, and checksum metadata for the covered history.

It does not change lifecycle state, admission buckets, or Runtime policy.

## Export, Verify, and Restore

```ts
import {
  exportAionisSubstrateBackup,
  restoreAionisSubstrateBackupToSqlite,
  verifyAionisSubstrateBackup,
  writeAionisSubstrateBackupFile,
} from "@aionis/substrate";

const backup = await exportAionisSubstrateBackup(store);
const report = verifyAionisSubstrateBackup(backup);

if (!report.ok) throw new Error(report.errors.join("; "));

await writeAionisSubstrateBackupFile("/backups/aionis-substrate.json", backup);
await restoreAionisSubstrateBackupToSqlite(backup, "/tmp/restored-aionis-substrate.sqlite");
```

Backup is event-log based. Restore preserves original event ids and sequence numbers, then rebuilds the read model.

## Close the Store

```ts
await store.close();
```

## Boundary

This API is a substrate contract, not the complete Aionis Runtime product facade.

Runtime-level features such as product `observe`, `guide`, `forget`, `measure`, lifecycle candidate inference, memory decision trace presentation, and context compiler UX belong above this substrate layer.
