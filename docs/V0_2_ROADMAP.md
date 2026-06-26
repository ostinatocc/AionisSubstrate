# Aionis Substrate v0.2 Roadmap

This roadmap freezes the intended scope for the next Substrate release.

Substrate remains an independent storage-contract layer. It is not the full Aionis Runtime policy engine, not a vector database, and not an Agent framework.

## v0.2 Principles

- Keep append-only evidence as the source of truth.
- Keep lifecycle, relation, feedback, and decision receipts inspectable.
- Preserve file and SQLite adapter parity for every public API.
- Add product hardening only where it improves durability, auditability, or Runtime sidecar integration.
- Do not encode task-specific benchmark fixtures or one-off Runtime policies in Substrate.

## Included

### 1. Migration Scaffold

Add a small schema-migration boundary for future SQLite changes:

- explicit migration registry;
- current schema guard remains strict;
- migration tests for already-created stores;
- no best-effort reads of unsupported future schemas.

Initial implementation status: SQLite now has a registry-backed v1 migration ledger. Future schema changes should add migrations through that registry instead of editing open-time schema creation ad hoc.

### 2. Read API Hardening

Expose scoped audit reads that do not mutate the event log:

- `listRelations(scope, memoryId?)`
- `listFeedback({ scope, memoryId? })`
- `listDecisions(scope)`

These APIs are for audit/debug/measure surfaces and adapter parity checks. They do not replace `compileContext`, and they do not make admission decisions.

### 3. Durability Negative Tests

Extend failure-mode coverage:

- corrupt event references;
- interrupted writes;
- relation and feedback edge cases after compaction;
- checkpoint reopen after mixed read/write traffic.

Initial implementation status: decision trace references are validated like relation and feedback references. File and SQLite adapters reject missing decision targets before persisting events or rows; backup verification rejects checksum-valid orphan decision receipts; checkpoint reopen rejects corrupt decision references; post-checkpoint invalid relation, feedback, and decision writes stay atomic.

### 4. Runtime Sidecar Stabilization

Keep Runtime experiments isolated:

- read-only Runtime snapshot import remains separate from Runtime source;
- dual-write sidecar continues to write into a separate Substrate store;
- no replacement of Aionis Runtime storage in v0.2.

Initial implementation status: `check:runtime-sidecar` now combines read-only Runtime snapshot parity and same-source reference corpus parity into a single report contract. `live-sidecar` adds a checkpointed external mirror from Runtime Lite SQLite into a separate Substrate target for repeated host-managed sync, including bounded watch polling and a checkpoint lock. Real Runtime dual-write remains an explicit separate gate through `check:runtime-dual-write` because it starts focused Runtime.

### 5. Product CLI and Docs

Make the substrate boundary easier to consume without widening policy scope:

- publish a package CLI entrypoint for read-only sidecar checks;
- document install, minimal API usage, and sidecar reports separately;
- keep repository-only Runtime process experiments explicit and separate.

Initial implementation status: the package exposes `aionis-substrate sidecar` for read-only snapshot/reference checks, `aionis-substrate live-sidecar` for checkpointed external mirroring, and store commands for inspect, preview-context, backup, restore, compact, and Runtime snapshot import. These commands do not start Runtime, mutate Runtime storage, or implement Runtime admission policy.

## Excluded

- Vector search, ANN, embeddings, or semantic recall.
- Full Aionis Runtime admission policy.
- LLM-as-judge or model-generated lifecycle policy.
- Agent orchestration or external Agent harnesses.
- SaaS tenancy, auth, billing, or cloud service behavior.
- Replacing `AionisRuntime-focused` storage.

## Release Gates

Before v0.2 can be tagged:

- `npm run typecheck`
- `npm test`
- `npm run bench:contract`
- `npm run check:release`
- `npm run check:scale -- --nodes 10000 --scopes 10 --relations 2000 --feedback 1000`
- adapter parity tests for every new public API;
- package install smoke from tarball;
- published registry smoke after release.

## v0.1 Baseline

v0.1 already provides:

- file and SQLite adapters;
- append-only event log;
- governed context buckets;
- decision receipts;
- read-only context preview;
- backup and restore;
- checkpoint compaction;
- deterministic scoped search;
- Runtime snapshot import;
- external admission parity;
- isolated Runtime dual-write sidecar experiments;
- npm package and registry smoke checks.

v0.2 should harden this substrate boundary instead of broadening the product surface.
