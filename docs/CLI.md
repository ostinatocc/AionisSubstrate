# CLI

`@aionis/substrate` publishes a small CLI for local store operations, validation, and sidecar integration work.

It is intentionally narrow:

- it inspects, previews, backs up, restores, and compacts Substrate stores;
- it imports Runtime Lite SQLite snapshots into separate Substrate stores;
- it runs read-only checks over existing Runtime evidence;
- it writes reports to local files;
- it does not start Aionis Runtime unless you explicitly use the separate repository script `check:runtime-dual-write`;
- it does not mutate Runtime source code or replace Runtime storage.

## Install

Run without installing permanently:

```bash
npx @aionis/substrate --help
```

Install into a project:

```bash
npm install @aionis/substrate
npx aionis-substrate --help
```

The CLI requires Node 24+.

## Store Commands

All store commands use explicit adapter and path arguments:

```bash
npx aionis-substrate inspect --adapter sqlite --path ./substrate.sqlite --scope repo-a
npx aionis-substrate preview-context --adapter sqlite --path ./substrate.sqlite --scope repo-a --query "continue runtime work"
npx aionis-substrate backup --adapter sqlite --path ./substrate.sqlite --output ./substrate-backup.json
npx aionis-substrate restore --adapter sqlite --path ./restored.sqlite --input ./substrate-backup.json
npx aionis-substrate compact --adapter sqlite --path ./substrate.sqlite
```

Use `--adapter file` with a directory path for the file-backed adapter:

```bash
npx aionis-substrate inspect --adapter file --path ./substrate-store --scope repo-a
```

### Inspect

`inspect` prints store metadata. With `--scope`, it also prints scoped counts and memory-node summaries:

```bash
npx aionis-substrate inspect \
  --adapter sqlite \
  --path ./substrate.sqlite \
  --scope repo-a
```

The report contract is `aionis_substrate_inspect_report_v1`.

### Preview Context

`preview-context` compiles the governed buckets without writing a `memory.decision.recorded` receipt:

```bash
npx aionis-substrate preview-context \
  --adapter sqlite \
  --path ./substrate.sqlite \
  --scope repo-a \
  --query "continue the current route" \
  --max-per-bucket 8
```

The report includes `read_only: true` when event counts and sequence numbers are unchanged.

### Backup and Restore

`backup` writes a checksum-covered event backup:

```bash
npx aionis-substrate backup \
  --adapter sqlite \
  --path ./substrate.sqlite \
  --output ./substrate-backup.json
```

`restore` verifies the backup before writing an empty target:

```bash
npx aionis-substrate restore \
  --adapter sqlite \
  --path ./restored.sqlite \
  --input ./substrate-backup.json
```

Use `--overwrite` only when replacing an existing restore target is intentional.

### Compact

`compact` rewrites the event history into one checkpoint event without changing governed state:

```bash
npx aionis-substrate compact \
  --adapter sqlite \
  --path ./substrate.sqlite
```

## Runtime Snapshot Import

Use `import-runtime-snapshot` to copy Runtime Lite SQLite evidence into a separate Substrate store:

```bash
npx aionis-substrate import-runtime-snapshot \
  --source /path/to/aionis-runtime-lite.sqlite \
  --target ./substrate.sqlite \
  --adapter sqlite \
  --scope repo-a
```

The Runtime source is opened read-only. The target is a Substrate store owned by this command.
The JSON output includes imported/skipped counts plus structured `diagnostics.sourceTables`,
`diagnostics.skipReasons`, and `diagnostics.jsonIssues` so bridge failures can be classified
without scraping warning strings.

## Sidecar Check

Use `sidecar` when you already have Runtime Lite SQLite evidence and want to check whether Substrate can mirror the governed context surface from outside the Runtime boundary.

Snapshot parity:

```bash
npx aionis-substrate sidecar \
  --source /path/to/aionis-runtime-lite.sqlite \
  --scope repo-a \
  --reference /path/to/runtime-guide-or-measure.json \
  --output reports/runtime-sidecar/summary.json
```

Reference corpus parity:

```bash
npx aionis-substrate sidecar \
  --source-root /path/to/runtime-sqlite-root \
  --reference-root /path/to/runtime-reference-root \
  --max-source-files all \
  --max-scopes all \
  --max-scopes-per-file 100 \
  --max-references all
```

Combined report:

```bash
npx aionis-substrate sidecar \
  --source /path/to/aionis-runtime-lite.sqlite \
  --scope repo-a \
  --reference /path/to/runtime-guide-or-measure.json \
  --source-root /path/to/runtime-sqlite-root \
  --reference-root /path/to/runtime-reference-root \
  --output reports/runtime-sidecar/summary.json
```

The report contract is `aionis_runtime_sidecar_check_report_v1`.

## What Passing Means

Passing snapshot parity means one Runtime SQLite scope can be imported into an isolated Substrate store and compiled into matching governed buckets.

Passing reference corpus parity means exported Runtime guide/measure JSON is traceable to real Runtime memory ids in the same source corpus.

Passing these checks does not mean Substrate has become the full Runtime policy engine. Runtime still owns richer product policy; Substrate owns durable evidence, lifecycle state, relations, feedback, and the minimum governed context contract.

## Common Failures

`no_matched_reference`

The reference files were scanned, but none of their memory ids overlap the discovered Runtime SQLite scopes. Point `--reference-root` at guide/measure outputs produced from the same Runtime data as `--source-root`.

`snapshot_parity failed`

The imported Substrate buckets do not match the supplied Runtime guide/measure surface. Inspect the generated `summary.json` before changing code; the mismatch may be a scope, reference, or fixture problem.

`ExperimentalWarning: SQLite is an experimental feature`

Node 24 currently marks `node:sqlite` as experimental. This is expected for the current embedded SQLite adapter.
