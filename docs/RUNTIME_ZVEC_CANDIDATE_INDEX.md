# Runtime Zvec Candidate Index Check

This check validates the optional Zvec candidate index against real Aionis Runtime Lite SQLite snapshots.

It proves a storage/index contract:

- Runtime Lite SQLite is opened read-only.
- selected Runtime scopes are imported into an isolated Substrate SQLite store.
- a Zvec candidate index is rebuilt from the imported Substrate nodes.
- `verify()` must report no missing, orphan, or stale index entries.
- wide-window Zvec candidate search must preserve canonical Substrate search ids.
- narrow-window Zvec candidate search must still recover the seeded real Runtime memory node for exact-node probes.

The check uses a deterministic local text projection to provide vectors for real imported Runtime nodes. It validates Zvec integration, write/rebuild/verify behavior, and candidate-window safety. It does not evaluate embedding-provider semantic quality.

## Run

```bash
npm run check:runtime-zvec-index -- \
  --root /Volumes/ziel/AionisRuntime-focused/.tmp \
  --max-files 10 \
  --max-scopes 12 \
  --min-nodes 3 \
  --probes-per-scope 5
```

The command writes a report under `reports/runtime-zvec-candidate-index-*` unless `--output` is supplied.

## Options

- `--root <path>`: Runtime directory or SQLite file to scan. Repeatable.
- `--max-files <n|all>`: maximum Runtime SQLite files to inspect.
- `--max-scopes <n|all>`: maximum selected scopes to validate.
- `--max-scopes-per-file <n>`: maximum candidate scopes from each Runtime SQLite file.
- `--min-nodes <n>`: minimum `lite_memory_nodes` rows required for a scope.
- `--probes-per-scope <n>`: exact-node search probes to run per selected scope.
- `--narrow-candidate-limit <n>`: Zvec candidate window for narrow recovery probes.
- `--result-limit <n>`: final Substrate search result limit.
- `--keep-store`: keep temporary Substrate SQLite and Zvec files for inspection.

## Report Interpretation

Important fields:

- `passed_scopes` / `failed_scopes`: scope-level storage/index gate.
- `total_nodes_imported`: real Runtime nodes imported into isolated Substrate stores.
- `total_vector_indexable_nodes`: imported nodes with a deterministic vector projection.
- `total_wide_parity_hits / total_probes_attempted`: wide candidate window preserved canonical Substrate search output.
- `total_narrow_seed_hits / total_probes_attempted`: narrow candidate window recovered the seeded real Runtime node.
- `zvec_health`: per-scope missing/orphan/stale index diagnostics.

Failures mean the Zvec sidecar needs index-contract work before it should be used for Runtime-scale candidate preselection.

## Local Validation Snapshot

On 2026-06-26, the check was run against local `AionisRuntime-focused/.tmp` Runtime Lite SQLite files:

```bash
npm run check:runtime-zvec-index -- \
  --root /Volumes/ziel/AionisRuntime-focused/.tmp \
  --max-files all \
  --max-scopes 20 \
  --min-nodes 3 \
  --probes-per-scope 8 \
  --narrow-candidate-limit 20
```

Result:

- discovered SQLite files: 30
- Runtime SQLite files with candidate scopes: 14
- attempted scopes: 20
- passed scopes: 20
- imported Runtime nodes: 3,080
- vector-indexable nodes: 3,080
- probes attempted: 160
- wide candidate parity: 100%
- narrow candidate seed hit rate: 100%

This validates the Zvec storage/index contract on real Runtime snapshots. Semantic embedding quality should be measured separately with a provider-backed embedding eval because this check intentionally uses a deterministic local text projection.
