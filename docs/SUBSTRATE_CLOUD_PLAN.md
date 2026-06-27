# Aionis Substrate Cloud Plan

Status: planned, not active implementation

Date: 2026-06-27

## Summary

Aionis Substrate Cloud is the planned hosted layer for durable evidence, audit,
backup, restore planning, and cross-environment continuity for Aionis Runtime.

It should not replace the local Runtime. The Runtime remains the real-time
execution memory engine that handles observe, guide, feedback, measure, context
compilation, admission, forgetting, and rehydration. Substrate Cloud should be a
durable evidence substrate that receives mirrored Runtime evidence and makes it
searchable, restorable, auditable, and shareable across machines, agents, and
teams.

The current product priority remains local-first:

- Make local Runtime + local Substrate mirror reliable.
- Prove that Substrate improves backup, restore, audit, migration, and evidence
  continuity without changing Runtime guide behavior.
- Run external benchmarks and real host integrations to validate Aionis claims:
  shorter governed context, stronger interference resistance, and auditable
  execution state.

Cloud work starts only after the local path is stable and externally validated.

## Product Position

Runtime:

- Real-time execution memory and context compiler.
- Local or self-hosted.
- Produces guide context, decision trace, feedback attribution, and measurement.

Substrate:

- Durable evidence substrate.
- Mirrors Runtime evidence without taking over Runtime decisions.
- Stores decision trace, feedback, snapshots, restore metadata, backup state,
  migration state, and future admission dataset exports.

Substrate Cloud:

- Hosted durable evidence, audit, backup, continuity, and team collaboration.
- Commercial product surface.
- Optional for local users.

The key product boundary is:

```text
Runtime decides what the Agent should see now.
Substrate preserves why that decision happened and how to recover or audit it later.
```

## Why This Can Be Paid

Substrate Cloud creates value that local single-user Runtime does not fully cover:

- Cross-device continuity.
- Team/project evidence sharing.
- Long-term decision trace retention.
- Backup and restore-plan history.
- Audit search across runs and memories.
- Admission dataset accumulation.
- Compliance export.
- Production incident replay.
- Migration from local Runtime to hosted or self-hosted deployments.

This is a better paid wedge than forcing Runtime itself into a hosted product too
early. Local Runtime drives adoption; Substrate Cloud captures long-term value.

## Proposed Product Tiers

Free / Local:

- Local Runtime.
- Local SDK, HTTP, MCP, AIFS, and plugin integrations.
- Local SQLite storage.
- Local Substrate mirror.
- Local backup and restore-plan.

Pro / Team:

- Cloud evidence backup.
- Project and team scopes.
- Cross-device sync.
- Snapshot history.
- Restore-plan history.
- Search over decision traces and feedback records.
- Retention policies.
- Webhook ingest for CI, agent hosts, and verifier systems.

Enterprise:

- SSO.
- BYOK or customer-managed encryption.
- Private deployment option.
- Audit export.
- Compliance logs.
- Dedicated storage.
- Data retention controls.
- Team-level Flight Recorder reports.

## Minimal Hosted MVP

The first paid version should be small and evidence-focused.

Required:

1. Runtime evidence ingest endpoint.
2. Project-scoped API key.
3. Append-only evidence bundle storage.
4. Snapshot listing.
5. Restore-plan generation from cloud evidence.
6. Basic audit search by project, scope, run, memory id, and time.
7. CLI sync command.
8. A visible dashboard for:
   - recent runs
   - snapshots
   - used memories
   - suppressed memories
   - feedback attribution
   - restore-plan status

Explicitly not required for MVP:

- Hosted guide execution.
- Hosted Runtime replacement.
- Multi-tenant policy engine.
- Learned admission policy serving.
- Full operator console.
- Complex billing metering.

## Architecture Direction

Initial architecture:

```text
Local Runtime
  -> local SQLite source of truth
  -> local Substrate mirror-runtime
  -> optional Substrate Cloud sync

Substrate Cloud
  -> evidence ingest API
  -> append-only evidence store
  -> query/search API
  -> restore-plan API
  -> audit dashboard
```

Safety rule:

Cloud evidence must not silently override local Runtime guide decisions.

Governance rule:

If cloud evidence is later used to influence Runtime admission, it must pass the
same Runtime authority, lifecycle, scope, and source gates as local evidence.

## Data Assets

Substrate Cloud can become the long-term source for:

- Memory Admission Records.
- Decision trace history.
- Feedback attribution history.
- Counter-evidence records.
- Restore-plan outcomes.
- Snapshot lineage.
- Admission dataset exports.

These are future training/evaluation assets for admission policy improvement.
They should be treated as strategic product data, not disposable logs.

## Privacy And Trust Requirements

Before any hosted launch:

- Clear local-first positioning.
- Explicit data categories sent to cloud.
- Project-level API keys.
- Redaction controls.
- Retention controls.
- Export and delete controls.
- No hidden prompt or raw code upload beyond configured evidence sync.
- Clear distinction between evidence metadata, memory content, and raw artifacts.

## Current Local-First Priorities

Before starting Cloud implementation, finish these local tasks:

1. Stabilize Runtime + Substrate mirror-runtime on real local Runtime data.
2. Validate backup and restore-plan on repeated local runs.
3. Keep Zvec optional and prove it does not change governance semantics.
4. Run external benchmark evidence focused on:
   - shorter governed context
   - interference resistance
   - audit coverage
   - continuity across sessions and agents
5. Document the local integration path clearly:
   - Runtime is required.
   - Substrate is optional but useful for durable evidence.
   - Cloud is future paid continuity/audit/backup.

## Go / No-Go Gates

Do not start Substrate Cloud until:

- Local `mirror-runtime` is stable on multiple real Runtime projects.
- `restore-plan` works on real backups and detects incomplete evidence.
- External benchmark or real host evidence shows Aionis improves context quality
  or reliability versus raw recall / long context / naive summary.
- Docs clearly explain Runtime vs Substrate without making Substrate feel
  required for local adoption.

Start Cloud MVP when:

- Local mirror has repeated real-run evidence.
- Users have a clear reason to keep evidence across machines or teams.
- A first dashboard can show real value from existing evidence data.

## Positioning

Recommended phrasing:

> Aionis Runtime gives Agents governed execution memory in the moment.
> Aionis Substrate preserves the evidence trail so teams can audit, recover,
> migrate, and improve that memory over time.

Avoid:

- Presenting Substrate Cloud as required to use Aionis.
- Presenting Cloud as a replacement for Runtime.
- Starting with enterprise SaaS before the local path is proven.
