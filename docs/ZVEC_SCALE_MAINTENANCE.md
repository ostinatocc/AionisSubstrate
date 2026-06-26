# Zvec Scale Maintenance Check

This check validates the optional Zvec candidate sidecar under Substrate-scale write and maintenance operations.

It proves a storage/index contract:

- SQLite remains the truth store.
- Zvec receives write-through node upserts while nodes are written.
- `verify()` reports no missing, orphan, or stale entries after writes.
- reopening the store rebuilds the sidecar from SQLite truth.
- wide-window Zvec candidate search preserves canonical Substrate search ids.
- narrow-window Zvec candidate search recovers seeded exact-node probes.
- lifecycle transitions update the sidecar fingerprint.
- checkpoint compaction and post-compaction reopen keep the sidecar verifiable.

The check uses the same deterministic local text projection as the Runtime Zvec validation. It validates storage/index maintenance and candidate-window safety. It does not evaluate embedding-provider semantic quality.

## Run

```bash
npm run check:zvec-scale -- \
  --nodes 10000 \
  --scopes 10 \
  --relations 2000 \
  --feedback 1000 \
  --probes 100 \
  --narrow-candidate-limit 20
```

The command writes a report under `reports/zvec-scale-*` unless `--output` is supplied.

## Options

- `--nodes <n>`: generated memory nodes.
- `--scopes <n>`: generated scopes.
- `--relations <n>`: generated relation rows.
- `--feedback <n>`: generated feedback rows.
- `--probes <n>`: exact-node search probes.
- `--narrow-candidate-limit <n>`: Zvec candidate window for narrow seeded recovery probes.
- `--transitions <n>`: lifecycle transitions to apply after reopen.
- `--output <dir>`: report directory.
- `--keep-store`: keep the temporary SQLite and Zvec files for inspection.

## Report Interpretation

Important fields:

- `zvec_health.after_write`: write-through index health.
- `zvec_health.after_reopen`: rebuild-on-open health.
- `zvec_health.after_transitions`: lifecycle transition sync health.
- `zvec_health.after_compact` and `after_compact_reopen`: compaction and reopen health.
- `wide_parity_rate`: wide-window Zvec search matched canonical Substrate search.
- `narrow_seed_hit_rate`: narrow-window Zvec search recovered seeded nodes.
- `sqlite_bytes` and `zvec_bytes`: local storage footprint for the generated run.

Any missing, orphan, stale, parity, or seeded-recovery failure means the Zvec sidecar needs maintenance work before it should be used for larger Substrate candidate preselection.

## Local Validation Snapshot

On 2026-06-26, the check was run locally with a 10k-node SQLite truth store and Zvec sidecar:

```bash
npm run check:zvec-scale -- \
  --nodes 10000 \
  --scopes 10 \
  --relations 2000 \
  --feedback 1000 \
  --probes 100 \
  --narrow-candidate-limit 20
```

Result:

- nodes: 10,000
- relations: 2,000
- feedback records: 1,000
- lifecycle transitions: 100
- probes: 100
- Zvec health after write/reopen/transitions/compact/compact-reopen: pass
- wide candidate parity: 100%
- narrow seeded recovery: 100%
- SQLite bytes: 17,657,856
- Zvec sidecar bytes: 19,528,279
- write nodes with Zvec: 2,335 ms
- close after write, including manifest flush: 171 ms
- reopen and rebuild: 1,855 ms
- post-compaction reopen and rebuild: 1,783 ms

This validates the sidecar maintenance path at package scale: write-through indexing, rebuild, lifecycle-transition synchronization, compaction, and candidate-window safety all remain consistent with the SQLite truth store.
