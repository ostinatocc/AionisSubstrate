# Aionis Substrate

Aionis Substrate is an independent storage-contract project for Aionis memory and execution state.

It defines the durable substrate Aionis needs for governed working memory: append-only evidence, lifecycle state, relations, feedback, decision receipts, and context admission buckets.

Aionis Runtime can use this layer as a durable governed memory substrate. Agents and Runtime policy remain above it; file/SQLite remain the truth store; optional indexes such as Zvec can accelerate candidate preselection.

## Status

- Package: `@aionis/substrate`
- Version: `0.1.7`
- Runtime: Node 24+
- License: Apache-2.0
- Current adapters: file store and SQLite
- Runtime integration status: read-only snapshot import, checkpointed Runtime mirror, reference-corpus parity, external admission parity, and isolated dual-write sidecar experiments

The project is intentionally independent from `AionisRuntime-focused`. It can import real Runtime Lite SQLite snapshots for validation, mirror Runtime evidence into a separate Substrate target through an external checkpointed sidecar, and run isolated sidecar dual-write experiments, but it does not mutate Runtime source code or replace Runtime storage.

## Install

```bash
npm install @aionis/substrate
```

Run the published CLI without adding a dependency:

```bash
npx @aionis/substrate --help
```

After installing into a project:

```bash
npx aionis-substrate --help
```

Common CLI operations:

```bash
npx aionis-substrate inspect --adapter sqlite --path ./substrate.sqlite --scope repo-a
npx aionis-substrate preview-context --adapter sqlite --path ./substrate.sqlite --scope repo-a
npx aionis-substrate backup --adapter sqlite --path ./substrate.sqlite --output ./backup.json
npx aionis-substrate restore-plan --input ./backup.json --adapter sqlite --path ./restored.sqlite
npx aionis-substrate restore --adapter sqlite --path ./restored.sqlite --input ./backup.json
npx aionis-substrate compact --adapter sqlite --path ./substrate.sqlite
npx aionis-substrate mirror-runtime --source ./runtime.sqlite --target ./substrate.sqlite --adapter sqlite --checkpoint ./runtime-mirror-checkpoint.json --scope repo-a
npx aionis-substrate mirror-runtime --source ./runtime.sqlite --target ./substrate.sqlite --adapter sqlite --checkpoint ./runtime-mirror-checkpoint.json --scope repo-a --watch --iterations 20 --interval-ms 5000
```

`mirror-runtime` is the product-facing Runtime sidecar entry point. It opens the
Runtime SQLite source read-only, writes only the external Substrate target and
checkpoint, and does not change Runtime guide behavior, Runtime storage, or
Runtime learning policy. `live-sidecar` remains available as the lower-level
command name for existing scripts.

## Two-Minute Live Sidecar Demo

From a cloned repository:

```bash
npm run example:live-sidecar
```

The demo creates a real Runtime Lite SQLite source, inserts current route, failed
branch, and raw-trace pointer evidence, mirrors that source into a separate
Substrate SQLite store through `runRuntimeLiveSidecarOnce`, and previews the
governed context buckets. The expected output shows:

- `current-route` in `use_now`;
- `failed-branch` in `do_not_use`;
- `raw-trace` in `rehydrate`;
- the second sidecar run applying zero unchanged rows.

## Goal

Define the storage semantics Aionis needs before choosing or building a storage engine:

- append-only evidence events
- memory nodes with lifecycle and authority state
- relation graph for support, supersession, contradiction, invalidation, and payload requirements
- admission buckets: `use_now`, `inspect_before_use`, `do_not_use`, `rehydrate`
- decision traces that explain why memory was admitted, downgraded, blocked, or deferred
- controlled forgetting as state transitions, not silent deletion

## Product Boundary

Aionis Substrate owns durable memory evidence, lifecycle state, relation graph, feedback receipts, audit reads, side-effect-free preview, and the minimum governed context contract.

Aionis Runtime owns richer admission policy, product orchestration, Agent-facing guide behavior, and model/provider workflows above this storage-contract layer.

## Current Scope

This first version ships two embedded adapters:

- `events.jsonl` is the append-only evidence log.
- `snapshot.json` is a derived read model.
- `openSqliteAionisSubstrate` stores the same event log and read model in SQLite tables.
- SQLite uses Node's built-in `node:sqlite`; Node may print an experimental warning depending on the installed Node 24 build.
- every write is serialized and persisted.
- reopening the store rebuilds the same state from disk.
- every store reports its substrate schema version through `getStoreInfo`.
- the SQLite adapter persists schema metadata, records applied schema migrations, and rejects stores created by a newer unsupported schema.
- event-log backups can be exported, checksum-verified, and restored to either file or SQLite stores.
- checkpoint compaction can rewrite a store event log to one checksum-covered checkpoint event without changing governed state.
- `searchNodes` provides scoped deterministic lexical/structured search over memory nodes without mutating events or admission state.
- stores can be opened with an optional candidate index. The index is rebuilt on open by default, receives write-through node updates, can be verified for missing/orphan/stale entries, and only narrows candidate ids before Substrate reloads truth nodes and scores them.
- `createZvecCandidateIndex` provides an optional Zvec-backed candidate index for local vector preselection. Substrate fuses candidate-index rank into final search while preserving scope, lifecycle, authority, confidence, and target-file filters. It requires installing `@zvec/zvec`; file/SQLite remain the truth store.
- `buildAionisEmbeddingDocument` and `buildAionisEmbeddingQuery` expose the stable SDK projection for hosts that generate provider vectors before writing nodes or querying Zvec.
- `importRuntimeLiteSnapshot` can import an existing Runtime Lite SQLite database into an isolated Substrate store through a read-only source connection.
- `runRuntimeLiveSidecarOnce`, `runRuntimeLiveSidecarWatch`, and `aionis-substrate live-sidecar` incrementally mirror Runtime Lite evidence into a separate Substrate target through a checkpoint file.
- `aionis-substrate mirror-runtime` exposes the same checkpointed read-only Runtime evidence mirror as the formal product entry point.
- `aionis-substrate restore-plan` verifies backups and prints a read-only restore/migration plan without writing a target.

This is intentionally small. It proves the substrate contract without changing the existing Aionis Runtime.

## Contract

See [docs/STORE_CONTRACT.md](docs/STORE_CONTRACT.md).

API usage is documented in [docs/API_USAGE.md](docs/API_USAGE.md).

CLI usage is documented in [docs/CLI.md](docs/CLI.md).

Adapter consistency requirements are documented in [docs/ADAPTER_CONTRACT.md](docs/ADAPTER_CONTRACT.md).

The v0.2 roadmap is documented in [docs/V0_2_ROADMAP.md](docs/V0_2_ROADMAP.md).

Backup and restore are documented in [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md).

Checkpoint compaction is documented in [docs/CHECKPOINT_COMPACTION.md](docs/CHECKPOINT_COMPACTION.md).

Runtime snapshot import is documented in [docs/RUNTIME_SNAPSHOT_IMPORT.md](docs/RUNTIME_SNAPSHOT_IMPORT.md).

The product contract is documented in [docs/PRODUCT_CONTRACT.md](docs/PRODUCT_CONTRACT.md).

Runtime mirror sync is documented in [docs/RUNTIME_LIVE_SIDECAR.md](docs/RUNTIME_LIVE_SIDECAR.md).

Runtime integration design is documented in [docs/RUNTIME_INTEGRATION_DESIGN.md](docs/RUNTIME_INTEGRATION_DESIGN.md).

Published Runtime bridge validation is documented in the release checks section below. It installs the published npm package into a fresh temporary project, reads a real Runtime Lite SQLite source, writes only separate Substrate target stores, and verifies snapshot/live parity plus checkpoint idempotency.

Post-release package evidence is documented in [docs/POST_RELEASE_EVIDENCE.md](docs/POST_RELEASE_EVIDENCE.md).

Runtime Zvec candidate-index validation is documented in [docs/RUNTIME_ZVEC_CANDIDATE_INDEX.md](docs/RUNTIME_ZVEC_CANDIDATE_INDEX.md).

Zvec scale and maintenance validation is documented in [docs/ZVEC_SCALE_MAINTENANCE.md](docs/ZVEC_SCALE_MAINTENANCE.md).

Provider-backed Zvec embedding validation is documented in [docs/ZVEC_PROVIDER_EMBEDDING_EVAL.md](docs/ZVEC_PROVIDER_EMBEDDING_EVAL.md).
The provider eval supports OpenAI-compatible embedding endpoints and MiniMax native embeddings for checking Zvec candidate preselection with real provider vectors.

Runtime reference corpus parity is documented in [docs/RUNTIME_REFERENCE_CORPUS.md](docs/RUNTIME_REFERENCE_CORPUS.md).

Runtime sidecar stabilization is documented in [docs/RUNTIME_SIDECAR_STABILIZATION.md](docs/RUNTIME_SIDECAR_STABILIZATION.md).

External admission parity is documented in [docs/EXTERNAL_ADMISSION_PARITY.md](docs/EXTERNAL_ADMISSION_PARITY.md).

Runtime dual-write experimentation is documented in [docs/RUNTIME_DUAL_WRITE_EXPERIMENT.md](docs/RUNTIME_DUAL_WRITE_EXPERIMENT.md).

Release steps are documented in [RELEASE.md](RELEASE.md).

Changes are tracked in [CHANGELOG.md](CHANGELOG.md).

The basic package example is in [examples/basic](examples/basic).

## Quick Test

```bash
cd /Volumes/ziel/AionisSubstrate
npm install
npm run typecheck
npm test
npm run example:basic
```

Node 24+ is required because the project runs TypeScript directly.

## Minimal API Loop

```ts
import { createMemoryCandidateIndex, openSqliteAionisSubstrate } from "@aionis/substrate";

const store = await openSqliteAionisSubstrate({
  path: "./aionis-substrate.sqlite",
  candidateIndex: createMemoryCandidateIndex(),
});

await store.putNode({
  id: "current-route",
  scope: "repo-a",
  kind: "procedure",
  summary: "Use src/runtime.ts after verifier passed.",
  lifecycle: "active",
  authority: "trusted",
  confidence: 0.95,
  targetFiles: ["src/runtime.ts"],
});

const context = await store.compileContext({
  scope: "repo-a",
  query: "continue the runtime implementation",
});

console.log(context.use_now.map((node) => node.id));
console.log(context.decision_trace);

await store.close();
```

Use `previewContext` when you need the same governed buckets without writing a decision receipt.

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

This scans Runtime Lite SQLite files read-only, imports selected scopes into temporary Substrate stores, and writes an aggregate matrix report under `reports/runtime-snapshot-corpus-*`. The report includes bucket totals, node/relation/feedback/decision coverage, source-table presence, skip reasons, and Runtime JSON issues.

Runtime Zvec candidate-index check:

```bash
npm run check:runtime-zvec-index -- \
  --root /path/to/AionisRuntime-focused/.tmp \
  --max-scopes 20 \
  --min-nodes 3 \
  --probes-per-scope 8
```

This imports real Runtime Lite SQLite scopes into isolated Substrate SQLite stores, rebuilds a Zvec candidate index, verifies missing/orphan/stale health, and checks that wide candidate search preserves canonical Substrate search while narrow candidate search recovers seeded real Runtime memory nodes.

Runtime mirror:

```bash
npx aionis-substrate mirror-runtime \
  --source /path/to/aionis-runtime-lite.sqlite \
  --target /tmp/aionis-substrate.sqlite \
  --adapter sqlite \
  --checkpoint /tmp/aionis-runtime-live-checkpoint.json \
  --scope repo-a
```

This opens Runtime SQLite read-only, writes only new or changed mapped evidence into the separate Substrate target, and atomically updates a checkpoint file. Re-running the command should report unchanged evidence instead of replaying the same rows.

Add `--watch --iterations <n> --interval-ms <ms>` for a bounded polling loop with a single-instance checkpoint lock.

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

Runtime sidecar stabilization report:

```bash
npm run check:runtime-sidecar -- \
  --source /path/to/aionis-runtime-lite.sqlite \
  --scope repo-a \
  --reference /path/to/runtime-guide-or-measure.json \
  --source-root /path/to/AionisRuntime-focused/.tmp \
  --reference-root /path/to/runtime-references \
  --output reports/runtime-sidecar-manual/summary.json
```

This combines read-only snapshot parity and same-source reference corpus parity into one sidecar report. It does not start Runtime and does not replace Runtime storage.

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

This starts focused Runtime with isolated Lite SQLite paths, calls real `observe -> guide -> feedback -> measure`, writes the same observed memory ids and outcomes into a separate Substrate SQLite store, compares guide buckets, closes and reopens Substrate, and compares again. It can add deterministic generated scenarios with `--generated-count`, run independent scopes concurrently with `--concurrency`, and record mirror write-integrity plus lifecycle/relation chain probes. It does not mutate focused Runtime source code or replace Runtime storage.

Sustained sidecar soak:

```bash
npm run check:runtime-dual-write -- \
  --runtime-root /path/to/AionisRuntime-focused \
  --generated-count 96 \
  --chain-probe-count 16 \
  --concurrency 8
```

The soak report includes per-scenario latency summaries, chain-probe latency, reopen latency, event-sequence continuity, and SQLite file sizes.

Runtime product bridge gate:

```bash
npm run check:runtime-product-bridge -- \
  --runtime-root /path/to/AionisRuntime-focused
```

This is the product-level bridge check. It runs real focused Runtime
`observe -> guide -> feedback -> measure`, verifies external Substrate
dual-write parity, closes and reopens the Substrate store, runs lifecycle/relation
chain probes, mirrors the Runtime Lite SQLite source through read-only
`live-sidecar`, re-runs `live-sidecar` to prove checkpoint idempotency, and then
compares the mirrored Substrate `previewContext` buckets back against Runtime
guide surfaces. The default gate runs 4 fixed scenarios, 96 deterministic
generated scenarios, and 16 chain probes. It writes a single
`product-bridge-gate-summary.json` report and exits non-zero if any stage fails.

## Development Checks

```bash
npm run typecheck
npm run build
npm test
npm run bench:contract
npm run check:runtime-live-sidecar-soak
npm run check:runtime-live-sidecar-recovery
npm run check:pack
npm run check:install-smoke
npm run example:basic
npm run example:live-sidecar
```

The CI workflow runs the same checks on every push and pull request.

For a full local release gate:

```bash
npm run check:release
```

`check:pack` runs `npm pack --dry-run` and rejects package contents that would leak tests, reports, CI metadata, `node_modules`, or other non-runtime artifacts into the published tarball.

`check:install-smoke` packs the built package, installs that tarball into a fresh temporary project, imports `@aionis/substrate`, and runs real file/SQLite store operations from the installed package.

`check:runtime-live-sidecar-soak` creates a real Runtime Lite SQLite fixture, repeatedly appends execution-memory rows, and verifies checkpointed live-sidecar watch sync into a separate real Substrate SQLite store.

`check:runtime-live-sidecar-recovery` injects missing checkpoint, changed evidence after missing checkpoint, corrupt checkpoint, malformed fingerprint, source/scope mismatch, and empty-target recovery scenarios. It verifies the sidecar repairs recoverable checkpoint loss without duplicate events, still applies real source changes, fails closed for unsafe checkpoint state, and releases locks on failure.

After publishing to npm, run the registry package checks:

```bash
npm run check:registry-install
npm run check:published-runtime-smoke
AIONIS_RUNTIME_SQLITE_SOURCE=/path/to/aionis-lite.sqlite npm run check:published-runtime-bridge
AIONIS_RUNTIME_SQLITE_SOURCE=/path/to/aionis-lite.sqlite npm run check:published-runtime-bridge -- --live-passes 5
npm run check:published-runtime-bridge-corpus -- --root /path/to/runtime/.tmp --max-files 5 --live-passes 3
```

These commands install `@aionis/substrate@<package.json version>` from the npm registry into a fresh temporary project. `check:published-runtime-smoke` also creates a Runtime Lite SQLite fixture and verifies published-package snapshot import into a separate Substrate store.

`check:published-runtime-bridge` is the real Runtime bridge gate. It reads the Runtime Lite SQLite source passed through `AIONIS_RUNTIME_SQLITE_SOURCE`, imports it into an isolated snapshot store, runs checkpointed Runtime mirror sync into an isolated live store, verifies every pass after the first does not mutate the target, verifies snapshot/live event parity, and verifies the Runtime source file was not modified. Use `-- --live-passes N` for a short published-package idempotency soak against a real Runtime source.

`check:published-runtime-bridge-corpus` installs the published package once, scans a directory of real Runtime Lite SQLite sources, and runs the same isolated bridge gate across multiple sources. It is the stronger post-publish check when you want to verify that Runtime bridge behavior is not tied to one SQLite file.

The latest published-package evidence is summarized in [docs/POST_RELEASE_EVIDENCE.md](docs/POST_RELEASE_EVIDENCE.md).

## Scale Smoke

```bash
npm run check:scale -- \
  --nodes 10000 \
  --scopes 10 \
  --relations 2000 \
  --feedback 1000
```

The scale smoke writes a temporary SQLite substrate, verifies event sequence continuity, runs scoped search, compiles context, compacts the store, reopens it, and writes a report under `reports/scale-*`.

SQLite + Zvec scale maintenance:

```bash
npm run check:zvec-scale -- \
  --nodes 10000 \
  --scopes 10 \
  --relations 2000 \
  --feedback 1000 \
  --probes 100 \
  --narrow-candidate-limit 20
```

This writes a temporary SQLite truth store with a Zvec candidate sidecar, verifies write-through index health, compares wide-window Zvec search against canonical Substrate search, checks narrow-window seeded recovery, transitions lifecycle state, compacts, reopens, and writes a report under `reports/zvec-scale-*`.

Provider-backed Zvec embedding eval:

```bash
AIONIS_EMBEDDING_API_KEY=... \
AIONIS_EMBEDDING_MODEL=text-embedding-3-small \
npm run check:zvec-provider-embedding -- \
  --base-url https://api.openai.com/v1 \
  --nodes 240 \
  --scopes 4 \
  --queries 20 \
  --candidate-limit 20
```

This uses a real embedding provider, stores provider vectors on generated Substrate nodes, runs Zvec candidate search, and reports both raw Zvec candidate hit rate and final Substrate search hit rate. The runner supports OpenAI-compatible endpoints, MiniMax native embeddings, and DashScope native `text-embedding-v4` with query/document projection.
