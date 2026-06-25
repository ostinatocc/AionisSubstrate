# Runtime Snapshot Corpus Validation

The corpus checker validates whether Aionis Substrate can represent real Aionis Runtime Lite SQLite snapshots without mutating Runtime data.

It is a read-only validation path:

1. scan Runtime SQLite files;
2. select Runtime scopes;
3. import each scope into a temporary Substrate SQLite store;
4. compile Substrate context;
5. aggregate import coverage, bucket counts, warnings, and failures.

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
- `total_warnings`: scan and import warnings.
- `scope_reports`: per-scope import and bucket summary.

## Interpretation

This checker proves storage-contract coverage, not Runtime policy superiority.

Good results mean:

- Runtime SQLite sources can be opened read-only;
- Runtime memory nodes can be mapped into Substrate nodes;
- Substrate can compile governed context for real scopes;
- warnings and failures are visible.

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

Result on 2026-06-25:

- discovered SQLite files: 30
- Runtime SQLite files: 14
- candidate scopes: 128
- attempted scopes: 100
- passed scopes: 100
- failed scopes: 0
- imported Runtime nodes: 8,948
- warnings: 0

Local report:

`reports/runtime-snapshot-corpus-2026-06-25T11-54-32-014Z/summary.json`
