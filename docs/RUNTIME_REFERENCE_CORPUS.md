# Runtime Reference Corpus Parity

`runtime-reference-corpus` checks whether exported Runtime `agent_context` or
`memory_decision_trace` JSON can be tied back to real Runtime Lite SQLite data.

It is intentionally stricter than demo validation:

- references are parsed for concrete memory ids only;
- Runtime scopes are discovered from `lite_memory_nodes`;
- a reference is matched to a scope only when memory ids overlap;
- unmatched references stay in `unmatched_reference_reports` and are not counted
  as parity evidence.

## Run

```bash
npm run check:runtime-reference-corpus -- \
  --source-root /Volumes/ziel/AionisRuntime-focused/.tmp \
  --reference-root /Volumes/ziel/AionisRuntime-focused/docs/examples \
  --max-source-files all \
  --max-scopes-per-file 20 \
  --max-scopes 100 \
  --max-references all
```

The default output is written under `reports/runtime-reference-corpus-*/summary.json`.

## Report fields

- `matched_references`: reference JSON files with at least `min_overlap` ids
  found in a Runtime SQLite scope.
- `unmatched_references`: reference JSON files that had no Runtime scope overlap,
  or contained no recognizable Runtime admission surfaces.
- `exact_matches`: matched references where Substrate `compileContext` buckets
  exactly match Runtime reference buckets.
- `partial_matches`: matched references where both sides were available but at
  least one bucket differed.

This tool does not prove Runtime product behavior by itself. It proves whether a
reference artifact is a real, traceable Runtime parity artifact or only an
unmatched demo/export file.

## Current focused Runtime check

On 2026-06-25, the tool was run against:

```bash
npm run check:runtime-reference-corpus -- \
  --source-root /Volumes/ziel/AionisRuntime-focused \
  --reference-root /Volumes/ziel/AionisRuntime-focused/docs/examples \
  --max-source-files all \
  --max-scopes all \
  --max-scopes-per-file 100 \
  --max-references all
```

Result: 30 SQLite files were discovered, 14 contained Runtime Lite scopes, 228
candidate scopes were scanned, 36 reference JSON files were scanned, and 4 files
contained extractable Runtime admission surfaces. None of those 4 reference files
shared memory ids with the scanned Runtime SQLite scopes.

That means the current `docs/examples` files are useful product examples, but
they are not current real Runtime reference parity artifacts for the local
SQLite corpus. A future real parity run should export guide/measure JSON from
the same Runtime database snapshot that is supplied as `--source-root`.

## Same-source reference fixture

Use `make:runtime-product-reference` to create a same-source artifact pair:

1. start `AionisRuntime-focused` as a local Lite Runtime;
2. force its write/replay SQLite files into the output directory;
3. run a real `/v1/observe -> /v1/guide -> /v1/feedback -> /v1/measure`
   product loop through the Runtime SDK;
4. write `reference.json` containing the returned `agent_context` and
   `memory_decision_trace`;
5. run `check:runtime-reference-corpus` against that exact SQLite/reference pair.

```bash
npm run make:runtime-product-reference -- \
  --runtime-root /Volumes/ziel/AionisRuntime-focused
```

Outputs are written to `reports/runtime-product-reference-*/`:

- `runtime-write.sqlite`
- `runtime-replay.sqlite`
- `reference.json`
- `parity-summary.json`
- `run-summary.json`

This command is intentionally outside Runtime core. It creates a traceable
reference artifact for Substrate parity; it does not mutate the focused Runtime
repository and does not use `docs/examples` as evidence.
