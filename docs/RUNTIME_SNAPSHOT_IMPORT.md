# Runtime Lite Snapshot Import

This importer reads an existing Aionis Runtime Lite SQLite database and writes a one-way snapshot into an independent Aionis Substrate store.

It is intentionally not a Runtime integration path:

- source Runtime SQLite is opened read-only;
- no Runtime table is created, altered, or updated;
- no dual-write is installed;
- no Runtime guide/admission rule is changed;
- no benchmark or host-specific behavior is encoded.

The importer exists to answer one engineering question:

> Can the Substrate contract represent Runtime memory evidence, relations, feedback, and decision traces without polluting the focused Runtime?

## Source Tables

The importer currently understands the focused Runtime Lite write-store tables:

- `lite_memory_nodes`
- `lite_memory_edges`
- `lite_memory_execution_native_index`
- `lite_memory_rule_feedback`
- `lite_memory_execution_decisions`

`lite_memory_nodes` is required. Other tables are optional; missing optional tables are treated as empty.

## Mapping

Runtime nodes become Substrate memory nodes:

- `id`, `scope`, `title`, `text_summary`, `confidence`, agent/team ownership, and Runtime metadata are preserved.
- `slots_json` and execution-native index fields are preserved under `metadata.runtime_slots` and `metadata.runtime_execution_index`.
- execution target files are collected from `slots_json` and `lite_memory_execution_native_index`.
- Runtime raw/evidence references become `payloadRef`.

Admission state is mapped conservatively:

- explicit active/trusted/current/workflow-anchor evidence can enter `use_now`;
- candidate/advisory/unknown evidence enters `inspect_before_use`;
- archived/cold payload evidence enters `rehydrate`;
- `supersedes`, `contradicts`, and `invalidates` relations block direct use through `do_not_use`.

Runtime edges become Substrate relations:

- `supersedes`, `contradicts`, `invalidates`, `requires_payload`, `derived_from`, or `supports`.
- relation metadata preserves Runtime edge type, weight, decay, commit id, and metadata JSON.

Rule feedback becomes Substrate feedback when the referenced rule node was imported.

Execution decisions become Substrate decision traces when their referenced source rules were imported.

## CLI

SQLite target:

```bash
node scripts/import-runtime-snapshot.ts \
  --source /path/to/aionis-runtime-lite.sqlite \
  --target /tmp/aionis-substrate.sqlite \
  --adapter sqlite \
  --scope repo-a
```

File target:

```bash
node scripts/import-runtime-snapshot.ts \
  --source /path/to/aionis-runtime-lite.sqlite \
  --target /tmp/aionis-substrate-file-store \
  --adapter file
```

The command prints a JSON summary with imported/skipped counts and warnings.

## Parity Checker

The parity checker imports a Runtime Lite SQLite snapshot into an isolated SQLite Substrate store, compiles a Substrate context, and optionally compares its bucket ids with a Runtime guide/measure JSON file.

Smoke mode, without Runtime reference JSON:

```bash
npm run check:runtime-snapshot -- \
  --source /path/to/aionis-runtime-lite.sqlite \
  --scope repo-a \
  --output /tmp/runtime-snapshot-smoke.json
```

Parity mode, with a Runtime response containing `agent_context` and/or `memory_decision_trace`:

```bash
npm run check:runtime-snapshot -- \
  --source /path/to/aionis-runtime-lite.sqlite \
  --scope repo-a \
  --reference /path/to/runtime-guide-or-measure.json \
  --output /tmp/runtime-snapshot-parity.json
```

The checker compares:

- `use_now`
- `inspect_before_use`
- `do_not_use`
- `rehydrate`

The Runtime reference may be a direct `agent_context`, a direct `memory_decision_trace`, or a larger JSON object containing either surface.

When no reference is supplied, the report is still useful: it gives import coverage, skipped rows, warnings, and Substrate bucket counts for a real Runtime DB.

## Product Boundary

This is a read-only bridge for validation. It is not a replacement for Runtime Lite SQLite, Zvec, AIFS, or the product facade.

The safe sequence remains:

1. import Runtime snapshots into an isolated Substrate store;
2. compare admission buckets and decision traces outside Runtime;
3. run parity and negative-control tests;
4. only then decide whether any Runtime adapter is worth productizing.
