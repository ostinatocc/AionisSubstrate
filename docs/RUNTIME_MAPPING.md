# Aionis Runtime to Substrate Mapping

This document maps current Aionis Runtime product capabilities onto the Substrate contract. It is a design map only. It does not imply Runtime is already using Substrate.

## Product Loop Mapping

| Runtime surface | Substrate primitive | Notes |
|---|---|---|
| `observe` | `memory.node.upsert`, `memory.relation.upsert`, `memory.feedback.recorded` | Runtime observations become durable evidence events. Execution memory, ordinary memory, feedback, and trace pointers are all nodes or events. |
| `guide` | `compileContext` | Runtime guide is a governed context compile: `use_now`, `inspect_before_use`, `do_not_use`, and `rehydrate`. |
| `feedback` | `memory.feedback.recorded`, optional `memory.lifecycle.transition` | Feedback is evidence first. Authority changes require substrate-visible transitions. |
| `forget` | `memory.lifecycle.transition`, `requires_payload` relation | Forgetting is suppress/archive/rehydrate/revalidate state, not physical deletion. |
| `measure` | `memory.decision.recorded`, feedback and transition events | Measure reads decision traces and evidence history. It does not silently mutate memory. |

## Runtime Data Mapping

| Current Runtime concept | Substrate representation |
|---|---|
| Execution memory | `AionisMemoryNode(kind="execution")` |
| Workflow/procedure memory | `AionisMemoryNode(kind="procedure")` |
| Ordinary facts/preferences | `kind="fact"` / `kind="preference"` |
| Claim ledger item | `kind="claim"` |
| Handoff or trace pointer | `kind="trace_pointer"` with `payloadRef` |
| Lifecycle relation | `AionisRelation(kind="supersedes" | "contradicts" | "invalidates")` |
| Rehydrate hook | `lifecycle="rehydrate_required"` or `requires_payload` relation |
| Suppression/archive | `memory.lifecycle.transition` |
| Decision trace | `memory.decision.recorded` |
| Outcome attribution | `memory.feedback.recorded` |

## Admission Boundary

Runtime currently owns the richer product policy. Substrate owns the minimum storage-level contract:

- authoritative active memory may be directly used.
- unknown/candidate memory must be inspected.
- rejected/suppressed/retired memory must not be used.
- archived/payload-required memory must be a rehydrate hook.
- supersede/contradict/invalidate relations can block direct use.

This separation matters:

- Runtime can evolve admission policy without changing the storage event model.
- Substrate can remain deterministic and auditable.
- Future adapters can be tested against the same contract.

## Safe Integration Sequence

1. Keep Substrate independent.
2. Export a small read-only Runtime snapshot into Substrate.
3. Compare Runtime guide buckets with Substrate compiled buckets.
4. Add experimental dual-write outside Runtime core.
5. Only after repeated parity runs, consider a Runtime adapter.

## Explicit Non-goals

- Do not replace Runtime SQLite/Zvec yet.
- Do not add benchmark-specific rules to Substrate.
- Do not make Substrate responsible for LLM reasoning.
- Do not let Substrate output source-code repair procedures.
