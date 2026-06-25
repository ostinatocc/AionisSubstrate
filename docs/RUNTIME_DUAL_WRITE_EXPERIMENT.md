# Runtime Dual-Write Experiment

This experiment validates Aionis Substrate as an external sidecar for real focused Runtime execution state.

It does not replace Runtime storage. It does not mutate `AionisRuntime-focused`. It starts a real focused Runtime process with isolated Lite SQLite paths, calls the public SDK loop, mirrors the observed memory ids and outcomes into a separate Substrate SQLite store, and compares the resulting admission buckets.

## Why This Exists

Snapshot import proves Substrate can read existing Runtime databases.

External admission parity proves Substrate can project candidate memories into the same admission buckets as focused Runtime's external memory route.

Dual-write is the next integration step. It checks whether an external host can write the same execution-state facts into Runtime and Substrate during one real run, then get equivalent governed context from both systems.

## What It Runs

The runner executes this loop for each scenario:

1. Start focused Runtime with isolated Lite SQLite paths.
2. Call `execution.guideForRole` before any memory exists.
3. Call `execution.observeStep` for an accepted active route.
4. Call `execution.observeStep` for a rejected failed branch.
5. Write the same returned Runtime memory ids into Substrate.
6. Add a Substrate relation from the active route to the failed branch.
7. Call `execution.guideForRole` again and extract Runtime guide surfaces.
8. Call `store.compileContext` for the same scope and compare Substrate surfaces.
9. Call `execution.feedbackFromOutcome` and `execution.measureRun`.
10. Write matching Substrate feedback.
11. Probe invalid Substrate relation/feedback writes and verify no partial events are appended.
12. Optionally run independent Substrate lifecycle/relation chain probes.
13. Close and reopen Substrate, then compare persisted surfaces again.

The compared surfaces are:

- `use_now`
- `inspect_before_use`
- `do_not_use`
- `rehydrate`

## Command

```bash
npm run check:runtime-dual-write -- \
  --runtime-root /Volumes/ziel/AionisRuntime-focused \
  --generated-count 8 \
  --chain-probe-count 4 \
  --concurrency 4
```

Optional flags:

```bash
--scenario-count 4
--generated-count 24
--chain-probe-count 4
--concurrency 4
--seed runtime-dual-write-v2
--max-per-bucket 8
--output-dir reports/runtime-dual-write-manual
```

Sustained soak example:

```bash
npm run check:runtime-dual-write -- \
  --runtime-root /Volumes/ziel/AionisRuntime-focused \
  --generated-count 96 \
  --chain-probe-count 16 \
  --concurrency 8
```

## Report

The runner writes:

```text
reports/runtime-dual-write-*/summary.json
```

The report includes:

- focused Runtime base URL and isolated Lite SQLite paths
- Substrate SQLite path
- Runtime memory ids returned by `observeStep`
- Runtime guide surfaces
- Substrate compiled surfaces
- per-bucket parity details
- Substrate event counts
- generated/fixed scenario counts
- invalid write rollback probes
- chain probe counts for lifecycle transitions, supersession, invalidation, support, and payload relations
- persisted parity after close/reopen
- scenario, chain-probe, and reopen latency summaries
- append-only event sequence continuity
- Substrate and focused Runtime SQLite file sizes

## Chain Probes

Chain probes run in independent Substrate scopes after the real Runtime sidecar scenarios.

Each probe writes:

- one verified active memory expected in `use_now`
- one candidate procedure expected in `inspect_before_use`
- one prior memory superseded by the active memory
- one failed branch invalidated by the active memory and transitioned to `blocked`
- one raw payload pointer that requires rehydration

The probe then compiles context, compares the four admission buckets, closes and reopens the SQLite store, and compares again. This validates the substrate relation and lifecycle contract without adding benchmark-specific policy to focused Runtime.

## Soak Metrics

The report `soak` object is for sustained sidecar checks:

- `scenario_latency`: p50/p95/max latency for real Runtime sidecar scenarios.
- `chain_probe_latency`: p50/p95/max latency for Substrate-only lifecycle/relation probes.
- `reopen_latency`: p50/p95/max latency for persisted scenario checks after closing and reopening SQLite.
- `chain_probe_reopen_latency`: persisted chain probe reopen latency.
- `event_sequence`: verifies append-only event sequence continuity, duplicate count, and gap count.
- `db_sizes`: records Substrate SQLite/WAL/SHM file sizes and focused Runtime Lite SQLite file sizes.

## Boundary

This experiment is intentionally sidecar-only:

- no Runtime source mutation
- no Runtime storage replacement
- no production dual-write API
- no Agent framework logic
- no benchmark-specific Runtime policy

Passing this experiment means Substrate can mirror a small real Runtime execution loop and preserve the same admission surface after reopen. It does not mean Substrate is ready to become the focused Runtime storage engine.
