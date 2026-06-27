# Aionis Substrate Product Contract

Aionis Substrate is a governed memory substrate for long-running agents.

It gives an agent host a durable place to store execution memory, lifecycle authority, feedback, relations, and memory-decision receipts, then compiles a scoped context object that an agent can safely use on the next turn.

## Product Promise

Aionis Substrate turns raw agent memory into governed working memory:

- active evidence can influence the next turn;
- stale, failed, low-authority, or payload-only evidence stays visible without silently becoming instruction;
- raw traces can be restored through rehydrate hooks instead of flooding the prompt;
- every context decision can leave an auditable receipt;
- optional semantic candidate indexing can improve recall without replacing lifecycle governance.

## Core Contract

Substrate stores memory as append-only evidence and derived read models.

| Surface | Product meaning | Primary API |
| --- | --- | --- |
| Evidence log | Durable record of memory writes, lifecycle transitions, relations, feedback, and decisions | `writeNode`, `transitionLifecycle`, `writeRelation`, `writeFeedback`, `compileContext` |
| Lifecycle authority | The current status that controls whether memory can act | `active`, `contested`, `suppressed`, `archived` |
| Admission buckets | The agent-facing context boundary | `use_now`, `inspect_before_use`, `do_not_use`, `rehydrate` |
| Preview | Read-only context compilation for UI, planning, or dry runs | `previewContext()` |
| Receipt | Auditable record of a context decision | `compileContext()` |
| Backup | Checksum-covered export and restore of evidence | `exportBackup`, `restore...` |
| Runtime bridge | Read-only import or checkpointed Runtime mirror from Aionis Runtime Lite SQLite | `importRuntimeLiteSnapshot`, `runRuntimeLiveSidecarOnce` |
| Semantic candidate index | Optional Zvec-backed candidate narrowing before deterministic admission | `createZvecCandidateIndex` |

## Admission Semantics

Substrate compiles memory into four buckets.

| Bucket | Meaning |
| --- | --- |
| `use_now` | Directly usable memory. The host may place this in the agent context as current working state. |
| `inspect_before_use` | Relevant but uncertain memory. The agent may inspect it, but it should not be treated as an instruction. |
| `do_not_use` | Memory blocked from direct use by lifecycle, authority, scope, or relation evidence. |
| `rehydrate` | Pointer to raw payload or trace evidence that can be restored on demand. |

This contract is intentionally stricter than ordinary vector recall. Search can find candidates; admission decides whether candidates may influence the next turn.

## Host Integration Shape

A host normally integrates Substrate in four calls:

```ts
import {
  openSqliteAionisSubstrate,
  createZvecCandidateIndex,
  buildAionisEmbeddingDocument,
  buildAionisEmbeddingQuery,
} from "@aionis/substrate";

const store = await openSqliteAionisSubstrate({ path: "./aionis-substrate.sqlite" });

await store.writeNode({
  id: "route-1",
  scope: "repo-a",
  kind: "procedure",
  summary: "Use the active migration path after verifier passes.",
  lifecycle: "active",
  authority: "trusted",
  targetFiles: ["src/migrate.ts"],
});

const context = await store.previewContext({
  scope: "repo-a",
  query: "continue the migration task",
});

const receipt = await store.compileContext({
  scope: "repo-a",
  query: "continue the migration task",
  traceId: "agent-run-42",
});
```

`previewContext()` gives a read-only context object. `compileContext()` produces the same governed buckets and records a decision receipt.

## Embedding Projection Contract

Provider embeddings should be built from stable Substrate projection helpers:

```ts
const documentText = buildAionisEmbeddingDocument(memoryNode, {
  projection: "structured",
});

const queryText = buildAionisEmbeddingQuery(userQuery, {
  projection: "structured",
});
```

The current projection version is:

```ts
AIONIS_EMBEDDING_PROJECTION_VERSION
```

Hosts can use this to keep document-side and query-side embeddings aligned across providers. The projection is a recall helper; lifecycle admission still controls whether a retrieved candidate can become `use_now`.

## Runtime Bridge Contract

Substrate can mirror Aionis Runtime Lite SQLite into a separate store:

```bash
npx aionis-substrate import-runtime-snapshot \
  --source ./runtime.sqlite \
  --target ./substrate.sqlite \
  --adapter sqlite

npx aionis-substrate mirror-runtime \
  --source ./runtime.sqlite \
  --target ./substrate.sqlite \
  --adapter sqlite \
  --checkpoint ./checkpoint.json
```

The bridge reads Runtime evidence and writes an external Substrate store. Runtime source storage remains untouched.

## Release-Level Guarantees

For `@aionis/substrate@0.1.5`:

- file and SQLite adapters preserve the same admission buckets for the same evidence;
- invalid writes do not persist partial events;
- controlled forgetting is a lifecycle transition;
- backup restore verifies event integrity;
- Runtime snapshot import is read-only against Runtime source SQLite;
- Runtime mirror uses checkpoint fingerprints for repeated sync;
- published package install smoke verifies CLI and SDK import surfaces;
- structured embedding projection is exposed as public SDK API.
