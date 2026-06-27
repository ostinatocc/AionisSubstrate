# Runtime Live Sidecar

The Runtime live sidecar is an external, one-way bridge from an Aionis Runtime Lite SQLite database into an independent Aionis Substrate store.

It exists for a narrow productization step:

- Runtime remains the source of execution memory writes.
- Substrate mirrors Runtime evidence into a durable substrate store.
- A checkpoint prevents replaying unchanged Runtime rows on every poll.
- No Runtime table, source file, policy, or guide path is mutated.

This is not a replacement for Runtime policy. It is a sidecar substrate sync primitive.

## Command

```bash
npx aionis-substrate live-sidecar \
  --source /path/to/aionis-runtime-lite.sqlite \
  --target ./substrate.sqlite \
  --adapter sqlite \
  --checkpoint ./runtime-live-checkpoint.json \
  --scope repo-a
```

Run the command repeatedly from a scheduler or host process. Each run:

1. opens the Runtime SQLite source read-only;
2. maps Runtime memory nodes, relations, feedback, and decisions through the snapshot importer;
3. fingerprints each mapped Substrate write;
4. writes only new or changed evidence into the target store;
5. atomically updates the checkpoint file.

Use `--adapter file` when the target is a file-backed Substrate directory.

Use `--dry-run` to report what would be applied without writing the target or checkpoint:

```bash
npx aionis-substrate live-sidecar \
  --source /path/to/aionis-runtime-lite.sqlite \
  --target ./substrate.sqlite \
  --adapter sqlite \
  --checkpoint ./runtime-live-checkpoint.json \
  --scope repo-a \
  --dry-run
```

## Bounded Watch Loop

Use `--watch` when a host wants Substrate to poll Runtime Lite repeatedly in one process:

```bash
npx aionis-substrate live-sidecar \
  --source /path/to/aionis-runtime-lite.sqlite \
  --target ./substrate.sqlite \
  --adapter sqlite \
  --checkpoint ./runtime-live-checkpoint.json \
  --scope repo-a \
  --watch \
  --iterations 20 \
  --interval-ms 5000
```

`--watch` is intentionally bounded in this package version. The host chooses the number
of iterations and can restart the command through cron, launchd, systemd, a supervisor,
or its own Agent host process.

The watch command creates a single-instance lock by default at:

```text
<checkpoint>.lock
```

Override it with `--lock <path>`. Use `--no-lock` only for controlled tests.

The watch report contract is `aionis_runtime_live_sidecar_watch_report_v1`.
It contains:

- `reports`: every per-iteration `aionis_runtime_live_sidecar_report_v1`;
- `apply_summary`: aggregate attempted/applied/unchanged counts across all iterations;
- `lock_path`: the lock used for this run;
- `iterations_requested` and `iterations_completed`.

## Soak Check

Use the soak check before release or before embedding the sidecar in a long-running host:

```bash
npm run check:runtime-live-sidecar-soak
```

The check creates a real Runtime Lite SQLite fixture, appends evidence in batches,
and runs bounded watch loops against a separate real Substrate SQLite target. It
verifies:

- every newly appended Runtime row is applied exactly once;
- unchanged rows remain checkpoint-skipped on later polls;
- the checkpoint fingerprint count matches the mirrored target;
- the lock file is released after every watch loop;
- the target store can be reopened with the same node and event counts.

The report contract is `aionis_runtime_live_sidecar_soak_report_v1`.

## Recovery Check

Use the recovery check before embedding the sidecar in a supervised or long-running process:

```bash
npm run check:runtime-live-sidecar-recovery
```

The check uses real Runtime Lite and Substrate SQLite stores and injects checkpoint failure modes. It verifies:

- corrupt checkpoint JSON fails before target mutation;
- malformed fingerprint records fail before target mutation;
- source/scope mismatch fails before target mutation;
- watch lock files are released even when checkpoint loading fails;
- an empty target with a stale-but-valid checkpoint replays the Runtime snapshot instead of silently trusting fingerprints.

The report contract is `aionis_runtime_live_sidecar_recovery_report_v1`.

## Report

The report contract is `aionis_runtime_live_sidecar_report_v1`.

Important fields:

- `import_summary`: the Runtime snapshot importer coverage for this scan.
- `apply_summary`: what the live sidecar actually applied or skipped through the checkpoint.
- `checkpoint_before`: whether a checkpoint existed and how many fingerprints it contained.
- `checkpoint_after`: fingerprint counts after the run.
- `store_before` / `store_after`: target store event counters.
- `warnings`: importer warnings plus sidecar consistency warnings.

`import_summary.nodesImported` can be larger than `apply_summary.nodes.applied`. That is expected: the importer reports what it mapped from Runtime; the live sidecar reports what was new or changed after checkpoint comparison.

## Checkpoint Behavior

The checkpoint is scoped to:

- Runtime source path;
- optional Runtime scope;
- mapped Substrate object fingerprints.

If the checkpoint path points to a different Runtime source or scope, the command fails. This prevents accidental cross-source reuse.

If the checkpoint JSON is corrupt or has malformed fingerprint records, the command fails closed before importing Runtime evidence. The target store is not mutated.

If the checkpoint contains fingerprints but the target store is empty, the sidecar ignores the checkpoint and replays the Runtime snapshot into the target. This prevents a stale checkpoint from hiding a lost or newly created target store.

If an individual node, relation, feedback row, or decision is missing from the target even though the checkpoint says it is unchanged, the sidecar re-applies that object.

## Product Boundary

The live sidecar is external infrastructure:

- it does not replace Runtime Lite;
- it does not install dual-write inside Runtime;
- it does not change Runtime guide/admission policy;
- it does not encode benchmark-specific rules;
- it does not make Substrate the full Runtime policy engine.

Use it when you want a live Substrate mirror for inspection, backup, product experiments, or external host integration without touching Runtime core.
