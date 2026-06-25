# External Admission Parity

`scripts/external-admission-parity.ts` validates Aionis Substrate against the real focused Runtime external memory governance path.

It starts `AionisRuntime-focused` in local Lite mode, calls the product SDK method that backs `/v1/memory/govern`, projects the same external candidate memories into Aionis Substrate, and compares the four admission buckets:

- `use_now`
- `inspect_before_use`
- `do_not_use`
- `rehydrate`

## Run

```bash
npm run check:external-admission-parity -- \
  --runtime-root /Volumes/ziel/AionisRuntime-focused
```

By default this runs 6 fixed contract scenarios plus 24 deterministic generated variants:

```bash
npm run check:external-admission-parity -- \
  --runtime-root /Volumes/ziel/AionisRuntime-focused \
  --generated-count 100 \
  --seed external-admission-parity-v2
```

The runner writes a report under:

```text
reports/external-admission-parity-*/summary.json
```

## What This Proves

This validates that Substrate's minimum admission contract can express the same four-bucket result as focused Runtime's external candidate governance route.

The runner covers:

- trusted current execution state admitted to `use_now`;
- unverified candidate memory routed to `inspect_before_use`;
- failed, stale, suppressed, or blocked memory kept out of direct use;
- raw trace or payload-only memory routed to `rehydrate`.
- trusted ordinary preference/fact memory outside code execution traces;
- known-source memory that remains inspect-only under focused Runtime firewall behavior;
- explicit authority requirements that override otherwise current lifecycle hints.

Generated variants expand these surfaces across execution routes, procedures, handoff state, ordinary preference memory, failed/stale/contested/suppressed negative history, and payload-only evidence. They are deterministic contract variants, not a public benchmark leaderboard.

The focused Runtime route may apply stricter product firewall behavior before bucket emission. For example, an inspect-like external candidate outside the active target cluster can be blocked as `do_not_use`. This runner intentionally keeps fixtures inside the shared external admission contract so the comparison validates Substrate bucket expressiveness instead of forcing full Runtime product policy into the substrate layer.

## What This Does Not Prove

This is not full Aionis Runtime policy parity.

It does not replace focused Runtime's guide policy, lifecycle candidate inference, relation adjudication, feedback attribution, or product context compiler. It is deliberately narrower: external candidate admission into the four bucket contract.

It also does not mutate Runtime source code or Runtime product databases. The focused Runtime service is started with isolated temporary SQLite paths under the report directory.

## Current Focused Runtime Check

The expanded focused Runtime parity run currently produces:

```text
scenario_count: 30
base_scenario_count: 6
generated_scenario_count: 24
exact_scenario_count: 30
failed_scenario_count: 0
seed: external-admission-parity-v2
```

Report:

```text
reports/external-admission-parity-2026-06-25T14-01-55-065Z/summary.json
```

Reports are generated artifacts and are not committed by default.

A larger smoke run also passed:

```text
scenario_count: 106
base_scenario_count: 6
generated_scenario_count: 100
exact_scenario_count: 106
failed_scenario_count: 0
seed: external-admission-parity-v2-large
```

## Why This Exists

Runtime snapshot parity validates read-only import from existing Runtime SQLite databases.

Runtime product reference parity validates same-source execution continuity produced by real `observe` / `guide` / `measure` loops.

External admission parity validates the missing product boundary: external memory candidates already carrying candidate governance signals can be routed into the same four bucket contract without relying on Runtime's internal storage.
