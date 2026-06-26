# Runtime Sidecar Stabilization

This page defines the Substrate sidecar validation path for Aionis Runtime.

The sidecar path is intentionally external:

- it does not mutate `AionisRuntime-focused` source code;
- it does not replace Runtime Lite SQLite, Zvec, AIFS, or product storage;
- it does not install a production dual-write adapter;
- it only proves that Substrate can mirror, import, and inspect Runtime evidence from outside the Runtime boundary.

## Sidecar Gates

### Gate 1: Read-Only Snapshot Parity

Import one Runtime Lite SQLite snapshot into an isolated Substrate store and compile context for one scope.

```bash
npm run check:runtime-sidecar -- \
  --source /path/to/aionis-runtime-lite.sqlite \
  --scope repo-a \
  --reference /path/to/runtime-guide-or-measure.json
```

Without `--reference`, this is an import smoke: Runtime SQLite is opened read-only and Substrate writes to an isolated target.

With `--reference`, the command compares the four governed buckets:

- `use_now`
- `inspect_before_use`
- `do_not_use`
- `rehydrate`

### Gate 2: Same-Source Reference Corpus

Scan Runtime SQLite files and Runtime guide/measure JSON references, then count only references that share concrete memory ids with a discovered Runtime scope.

```bash
npm run check:runtime-sidecar -- \
  --source-root /path/to/runtime-sqlite-root \
  --reference-root /path/to/runtime-reference-root \
  --max-source-files all \
  --max-scopes all \
  --max-scopes-per-file 100 \
  --max-references all
```

This gate rejects demo-only evidence: a reference JSON must overlap real Runtime memory ids to count.

### Gate 3: Real Runtime Dual-Write Sidecar

This stage starts focused Runtime with isolated Lite SQLite files, calls the public Runtime SDK loop, mirrors the observed memory ids and outcomes into a separate Substrate SQLite store, and compares Runtime guide surfaces against Substrate compiled context.

```bash
npm run check:runtime-dual-write -- \
  --runtime-root /Volumes/ziel/AionisRuntime-focused \
  --generated-count 8 \
  --chain-probe-count 4 \
  --concurrency 4
```

This command remains separate from `check:runtime-sidecar` because it starts a Runtime process. It must be explicit.

## Combined Read-Only Report

`check:runtime-sidecar` can run Gate 1 and Gate 2 in one report:

```bash
npm run check:runtime-sidecar -- \
  --source /path/to/aionis-runtime-lite.sqlite \
  --scope repo-a \
  --reference /path/to/runtime-guide-or-measure.json \
  --source-root /path/to/runtime-sqlite-root \
  --reference-root /path/to/runtime-reference-root \
  --output reports/runtime-sidecar-manual/summary.json
```

The report contract is `aionis_runtime_sidecar_check_report_v1`.

It records:

- requested stages;
- pass/fail summary per stage;
- snapshot import coverage and parity;
- reference corpus matched/unmatched counts;
- notes confirming that Runtime source and Runtime storage were not replaced.

## Interpretation

Passing Gate 1 means Substrate can represent one Runtime SQLite scope as governed substrate state.

Passing Gate 2 means exported Runtime references are traceable to real Runtime SQLite memory ids, not only documentation examples.

Passing Gate 3 means an external host can mirror a small real Runtime execution loop into Substrate and preserve the same admission surface after reopen.

None of these gates mean Substrate has become the full Aionis Runtime policy engine. Runtime owns richer product policy; Substrate owns the durable evidence and minimum governed context contract.
