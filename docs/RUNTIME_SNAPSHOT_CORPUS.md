# Runtime Snapshot Corpus Validation

The corpus checker validates whether Aionis Substrate can represent real Aionis Runtime Lite SQLite snapshots without mutating Runtime data.

It is a read-only validation path:

1. scan Runtime SQLite files;
2. select Runtime scopes;
3. import each scope into a temporary Substrate SQLite store;
4. compile Substrate context;
5. aggregate import coverage, bucket counts, warnings, failures, and structured import diagnostics.

It does not replace Runtime storage and does not install dual-write.

## CLI

```bash
npm run check:runtime-corpus -- \
  --root /path/to/AionisRuntime-focused/.tmp \
  --max-files all \
  --max-scopes 100 \
  --max-scopes-per-file 20 \
  --min-nodes 1 \
  --max-per-bucket 50
```

The command writes a report under `reports/runtime-snapshot-corpus-*` unless `--output` is supplied.

## Report Fields

- `discovered_sqlite_files`: SQLite-like files found under the root.
- `runtime_sqlite_files`: files with Runtime `lite_memory_nodes`.
- `candidate_scopes`: scopes selected from Runtime files before global truncation.
- `attempted_scopes`: scopes actually imported.
- `passed_scopes`: scopes imported and compiled successfully.
- `failed_scopes`: scopes that failed import or compile.
- `total_nodes_imported`: imported Runtime nodes.
- `total_nodes_read` / `total_nodes_skipped`: node-level import coverage.
- `total_relations_*`, `total_feedback_*`, `total_decisions_*`: bridge coverage for Runtime relation, outcome, and decision evidence.
- `total_warnings`: scan and import warnings.
- `bucket_totals`: aggregate compiled Substrate admission buckets across imported scopes.
- `diagnostics_summary`: machine-readable source table coverage, skip reasons, and JSON issues aggregated across scopes.
- `scope_reports`: per-scope import and bucket summary.

## Interpretation

This checker proves storage-contract coverage, not Runtime policy superiority.

Good results mean:

- Runtime SQLite sources can be opened read-only;
- Runtime memory nodes can be mapped into Substrate nodes;
- Substrate can compile governed context for real scopes;
- warnings and failures are visible;
- skipped evidence is attributable to concrete causes such as missing endpoints, missing referenced rule nodes, audit-only nodes, empty summaries, or malformed Runtime JSON.

Bad results should be treated as mapping or substrate-contract evidence, not as a reason to mutate Aionis Runtime core.

## Local Validation Snapshot

Latest local run:

```bash
npm run check:runtime-corpus -- \
  --root /Volumes/ziel/AionisRuntime-focused/.tmp \
  --max-files all \
  --max-scopes 100 \
  --max-scopes-per-file 20 \
  --min-nodes 1 \
  --max-per-bucket 50
```

Result on 2026-06-26:

- discovered SQLite files: 30
- Runtime SQLite files: 14
- candidate scopes: 128
- attempted scopes: 100
- passed scopes: 100
- failed scopes: 0
- Runtime nodes read: 8,948
- Runtime nodes imported: 8,848
- Runtime nodes skipped: 100
- relation rows skipped: 0
- feedback rows skipped: 0
- decision rows skipped: 0
- bucket totals: `use_now=100`, `inspect_before_use=3,778`, `do_not_use=26`, `rehydrate=0`
- source table coverage: `lite_memory_nodes=100/100`, `lite_memory_edges=100/100`, `lite_memory_execution_native_index=40/100`, `lite_memory_rule_feedback=100/100`, `lite_memory_execution_decisions=100/100`
- skip reason totals: `not_agent_facing=100`, all other skip reasons `0`
- JSON issues: 0
- warnings: 100, all from intentionally skipped non-agent-facing Runtime nodes

Local report:

`reports/runtime-snapshot-corpus-2026-06-26T08-19-45-872Z/summary.json`
