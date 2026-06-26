import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  applyAionisEvent,
  checksumAionisEvents,
  cloneReplayState,
  emptyReplayState,
  eventKey,
  snapshotFromReplayState,
  type AionisReplayState,
} from "./event-log.ts";
import { searchMemoryNodes, type AionisMemorySearchCandidateMatch } from "./search.ts";
import type { AionisCandidateIndex } from "./candidate-index.ts";
import type {
  AionisAdmissionAction,
  AionisAdmissionDecision,
  AionisCompiledContext,
  AionisDecisionReason,
  AionisDecisionTrace,
  AionisDecisionTraceInput,
  AionisEvent,
  AionisFeedback,
  AionisFeedbackInput,
  AionisMemoryNode,
  AionisMemoryNodeInput,
  AionisRelation,
  AionisRelationInput,
  AionisSubstrate,
} from "./types.ts";
import { AIONIS_SUBSTRATE_SCHEMA_VERSION as CURRENT_SCHEMA_VERSION } from "./types.ts";

export type FileAionisSubstrateOptions = {
  dir: string;
  now?: () => Date;
  candidateIndex?: AionisCandidateIndex | null;
  rebuildCandidateIndexOnOpen?: boolean;
};

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) throw new Error("confidence must be finite");
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeStrings(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
}

async function readEvents(path: string): Promise<AionisEvent[]> {
  try {
    const raw = await readFile(path, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AionisEvent);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

function relationBlocksDirectUse(kind: string): boolean {
  return kind === "supersedes" || kind === "contradicts" || kind === "invalidates";
}

function relationRequiresRehydrate(kind: string): boolean {
  return kind === "requires_payload";
}

function sortNodes(nodes: AionisMemoryNode[]): AionisMemoryNode[] {
  return [...nodes].sort((a, b) => {
    const byTime = b.updatedAt.localeCompare(a.updatedAt);
    if (byTime !== 0) return byTime;
    return a.id.localeCompare(b.id);
  });
}

function sortRelations(relations: AionisRelation[]): AionisRelation[] {
  return [...relations].sort((a, b) => {
    const byTime = a.createdAt.localeCompare(b.createdAt);
    if (byTime !== 0) return byTime;
    return a.id.localeCompare(b.id);
  });
}

function sortFeedback(feedback: AionisFeedback[]): AionisFeedback[] {
  return [...feedback].sort((a, b) => {
    const byTime = a.createdAt.localeCompare(b.createdAt);
    if (byTime !== 0) return byTime;
    return a.id.localeCompare(b.id);
  });
}

function sortDecisions(decisions: AionisDecisionTrace[]): AionisDecisionTrace[] {
  return [...decisions].sort((a, b) => {
    const byTime = a.createdAt.localeCompare(b.createdAt);
    if (byTime !== 0) return byTime;
    return a.id.localeCompare(b.id);
  });
}

export async function openFileAionisSubstrate(options: FileAionisSubstrateOptions): Promise<AionisSubstrate> {
  const dir = options.dir;
  const now = options.now ?? (() => new Date());
  const candidateIndex = options.candidateIndex ?? null;
  const eventsPath = join(dir, "events.jsonl");
  const snapshotPath = join(dir, "snapshot.json");
  const state = emptyReplayState();
  let tail: Promise<unknown> = Promise.resolve();

  await mkdir(dir, { recursive: true });
  for (const event of await readEvents(eventsPath)) {
    applyAionisEvent(state, event);
  }
  await persistSnapshot();

  function isoNow(): string {
    return now().toISOString();
  }

  async function persistSnapshot(): Promise<void> {
    const snapshot = snapshotFromReplayState(state);
    const tempPath = `${snapshotPath}.tmp-${process.pid}-${randomUUID()}`;
    await mkdir(dirname(snapshotPath), { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await rename(tempPath, snapshotPath);
  }

  async function replaceEventLog(events: AionisEvent[]): Promise<void> {
    const tempPath = `${eventsPath}.tmp-${process.pid}-${randomUUID()}`;
    await mkdir(dirname(eventsPath), { recursive: true });
    await writeFile(tempPath, events.map((event) => JSON.stringify(event)).join("\n") + (events.length > 0 ? "\n" : ""), "utf8");
    await rename(tempPath, eventsPath);
  }

  function replaceState(next: AionisReplayState): void {
    state.lastSequence = next.lastSequence;
    state.nodes = next.nodes;
    state.relations = next.relations;
    state.feedback = next.feedback;
    state.decisions = next.decisions;
    state.events = next.events;
  }

  async function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async function append(event: Omit<AionisEvent, "sequence">): Promise<AionisEvent> {
    return await enqueue(async () => {
      const fullEvent = { ...event, sequence: state.lastSequence + 1 } as AionisEvent;
      applyAionisEvent(cloneReplayState(state), fullEvent);
      await appendFile(eventsPath, `${JSON.stringify(fullEvent)}\n`, "utf8");
      applyAionisEvent(state, fullEvent);
      await persistSnapshot();
      return fullEvent;
    });
  }

  function nodeRelations(scope: string, nodeId: string): AionisRelation[] {
    return Array.from(state.relations.values()).filter((relation) => relation.scope === scope && relation.targetId === nodeId);
  }

  async function syncCandidateIndexNode(node: AionisMemoryNode): Promise<void> {
    if (!candidateIndex) return;
    await candidateIndex.upsertNode(node);
  }

  async function searchWithCandidateIndex(input: Parameters<typeof searchMemoryNodes>[1]) {
    if (!candidateIndex) return searchMemoryNodes(Array.from(state.nodes.values()), input);
    const indexLimit = input.candidateLimit ?? Math.max(input.limit ?? 50, 200);
    const candidates = await candidateIndex.search({ ...input, limit: indexLimit });
    if (candidates === null) return searchMemoryNodes(Array.from(state.nodes.values()), input);
    const candidateMatches = new Map<string, AionisMemorySearchCandidateMatch>();
    candidates.forEach((candidate, index) => {
      candidateMatches.set(eventKey(candidate.scope, candidate.memoryId), {
        score: candidate.score,
        rank: index + 1,
        total: candidates.length,
        reasons: [
          {
            code: "candidate_index_match",
            detail: "node was selected by the configured candidate index before substrate scoring",
          },
          ...candidate.reasons,
        ],
      });
    });
    const allNodes = Array.from(state.nodes.values());
    const lexicalSafetyLimit = Math.max(input.limit ?? 50, Math.min(indexLimit, 50));
    const lexicalSafetyResults = input.query?.trim()
      ? searchMemoryNodes(allNodes, { ...input, candidateMatches: undefined, limit: lexicalSafetyLimit })
      : [];
    const searchKeys = new Set([
      ...candidates.map((candidate) => eventKey(candidate.scope, candidate.memoryId)),
      ...lexicalSafetyResults.map((result) => eventKey(result.node.scope, result.node.id)),
    ]);
    const nodes = allNodes.filter((node) => searchKeys.has(eventKey(node.scope, node.id)));
    return searchMemoryNodes(nodes, { ...input, candidateMatches });
  }

  function reasonsFor(node: AionisMemoryNode): { action: AionisAdmissionAction; reasons: AionisDecisionReason[] } {
    const incoming = nodeRelations(node.scope, node.id);
    const blockingRelation = incoming.find((relation) => relation.confidence >= 0.65 && relationBlocksDirectUse(relation.kind));
    if (blockingRelation) {
      return {
        action: "do_not_use",
        reasons: [{
          code: "blocked_by_relation",
          detail: `${blockingRelation.kind} relation reached confidence ${blockingRelation.confidence}`,
          relationId: blockingRelation.id,
        }],
      };
    }

    const rehydrateRelation = incoming.find((relation) => relation.confidence >= 0.55 && relationRequiresRehydrate(relation.kind));
    if (node.lifecycle === "archived" || node.lifecycle === "rehydrate_required" || rehydrateRelation) {
      return {
        action: "rehydrate",
        reasons: [{
          code: rehydrateRelation ? "relation_requires_payload" : "payload_required",
          detail: rehydrateRelation
            ? `${rehydrateRelation.kind} relation requests payload recovery`
            : "memory is archived or marked as requiring payload rehydration",
          relationId: rehydrateRelation?.id,
        }],
      };
    }

    if (node.lifecycle === "suppressed" || node.lifecycle === "retired" || node.lifecycle === "blocked" || node.authority === "rejected") {
      return {
        action: "do_not_use",
        reasons: [{
          code: "lifecycle_blocks_direct_use",
          detail: `lifecycle=${node.lifecycle}, authority=${node.authority}`,
        }],
      };
    }

    if (node.lifecycle === "active" && (node.authority === "trusted" || node.authority === "verified")) {
      return {
        action: "use_now",
        reasons: [{
          code: "active_authoritative_memory",
          detail: `lifecycle=${node.lifecycle}, authority=${node.authority}`,
        }],
      };
    }

    return {
      action: "inspect_before_use",
      reasons: [{
        code: "insufficient_authority",
        detail: `lifecycle=${node.lifecycle}, authority=${node.authority}`,
      }],
    };
  }

  function buildContext(input: { scope: string; query?: string | null; maxPerBucket?: number }): AionisCompiledContext {
    const maxPerBucket = input.maxPerBucket ?? Number.POSITIVE_INFINITY;
    const buckets: Record<AionisAdmissionAction, AionisMemoryNode[]> = {
      use_now: [],
      inspect_before_use: [],
      do_not_use: [],
      rehydrate: [],
    };
    const decisions: AionisAdmissionDecision[] = [];
    for (const node of sortNodes(Array.from(state.nodes.values()).filter((item) => item.scope === input.scope))) {
      const decision = reasonsFor(node);
      decisions.push({ memoryId: node.id, action: decision.action, reasons: decision.reasons });
      buckets[decision.action].push(node);
    }
    for (const action of Object.keys(buckets) as AionisAdmissionAction[]) {
      buckets[action] = buckets[action].slice(0, maxPerBucket);
    }
    const trace: AionisDecisionTrace = {
      id: randomUUID(),
      scope: input.scope,
      query: input.query ?? null,
      decisions,
      createdAt: isoNow(),
    };
    return {
      scope: input.scope,
      use_now: buckets.use_now,
      inspect_before_use: buckets.inspect_before_use,
      do_not_use: buckets.do_not_use,
      rehydrate: buckets.rehydrate,
      decision_trace: trace,
    };
  }

  if (candidateIndex && options.rebuildCandidateIndexOnOpen !== false) {
    await candidateIndex.rebuild(Array.from(state.nodes.values()));
  }

  return {
    async getStoreInfo() {
      return {
        adapter: "file",
        schemaVersion: CURRENT_SCHEMA_VERSION,
        lastSequence: state.lastSequence,
        eventCount: state.events.length,
      };
    },

    async compact() {
      return await enqueue(async () => {
        const beforeEvents = [...state.events];
        const before = {
          eventCount: beforeEvents.length,
          lastSequence: state.lastSequence,
          eventsSha256: checksumAionisEvents(beforeEvents),
        };
        if (beforeEvents.length === 0) {
          return {
            adapter: "file",
            schemaVersion: CURRENT_SCHEMA_VERSION,
            compacted: false,
            before,
            after: {
              eventCount: 0,
              lastSequence: 0,
              checkpointEventId: null,
            },
          };
        }

        const checkpoint: AionisEvent = {
          id: randomUUID(),
          sequence: 1,
          type: "substrate.checkpoint.created",
          createdAt: isoNow(),
          payload: {
            schemaVersion: CURRENT_SCHEMA_VERSION,
            coveredEventCount: beforeEvents.length,
            coveredLastSequence: state.lastSequence,
            coveredEventsSha256: before.eventsSha256,
            state: {
              nodes: Array.from(state.nodes.values()),
              relations: Array.from(state.relations.values()),
              feedback: Array.from(state.feedback.values()),
              decisions: Array.from(state.decisions.values()),
            },
          },
        };

        const compactedState = emptyReplayState();
        applyAionisEvent(compactedState, checkpoint);
        await replaceEventLog([checkpoint]);
        replaceState(compactedState);
        await persistSnapshot();
        return {
          adapter: "file",
          schemaVersion: CURRENT_SCHEMA_VERSION,
          compacted: true,
          before,
          after: {
            eventCount: state.events.length,
            lastSequence: state.lastSequence,
            checkpointEventId: checkpoint.id,
          },
        };
      });
    },

    async putNode(input: AionisMemoryNodeInput): Promise<AionisMemoryNode> {
      const ts = isoNow();
      const id = input.id ?? randomUUID();
      const existing = state.nodes.get(eventKey(input.scope, id));
      const createdAt = existing?.createdAt ?? input.createdAt ?? ts;
      const updatedAt = input.updatedAt ?? ts;
      const node: AionisMemoryNode = {
        id: requireNonEmpty(id, "memory id"),
        scope: requireNonEmpty(input.scope, "scope"),
        kind: input.kind,
        title: input.title ?? existing?.title ?? null,
        summary: requireNonEmpty(input.summary, "summary"),
        lifecycle: input.lifecycle ?? existing?.lifecycle ?? "candidate",
        authority: input.authority ?? existing?.authority ?? "unknown",
        confidence: clampConfidence(input.confidence ?? existing?.confidence ?? 0.5),
        targetFiles: normalizeStrings(input.targetFiles ?? existing?.targetFiles),
        payloadRef: input.payloadRef ?? existing?.payloadRef ?? null,
        agentId: input.agentId ?? existing?.agentId ?? null,
        teamId: input.teamId ?? existing?.teamId ?? null,
        metadata: input.metadata ?? existing?.metadata ?? {},
        createdAt,
        updatedAt,
      };
      await append({
        id: randomUUID(),
        type: "memory.node.upsert",
        createdAt: ts,
        payload: node,
      });
      await syncCandidateIndexNode(node);
      return node;
    },

    async transitionLifecycle(input): Promise<AionisMemoryNode> {
      const ts = isoNow();
      await append({
        id: randomUUID(),
        type: "memory.lifecycle.transition",
        createdAt: ts,
        payload: {
          scope: requireNonEmpty(input.scope, "scope"),
          memoryId: requireNonEmpty(input.memoryId, "memoryId"),
          lifecycle: input.lifecycle,
          authority: input.authority,
          confidence: input.confidence === undefined ? undefined : clampConfidence(input.confidence),
          reason: requireNonEmpty(input.reason, "reason"),
        },
      });
      const node = state.nodes.get(eventKey(input.scope, input.memoryId));
      if (!node) throw new Error(`missing memory node after lifecycle transition: ${input.memoryId}`);
      await syncCandidateIndexNode(node);
      return node;
    },

    async putRelation(input: AionisRelationInput): Promise<AionisRelation> {
      const ts = isoNow();
      const relation: AionisRelation = {
        id: requireNonEmpty(input.id ?? randomUUID(), "relation id"),
        scope: requireNonEmpty(input.scope, "scope"),
        kind: input.kind,
        sourceId: requireNonEmpty(input.sourceId, "sourceId"),
        targetId: requireNonEmpty(input.targetId, "targetId"),
        confidence: clampConfidence(input.confidence ?? 0.7),
        reasons: normalizeStrings(input.reasons),
        metadata: input.metadata ?? {},
        createdAt: input.createdAt ?? ts,
      };
      await append({
        id: randomUUID(),
        type: "memory.relation.upsert",
        createdAt: ts,
        payload: relation,
      });
      return relation;
    },

    async recordFeedback(input: AionisFeedbackInput): Promise<AionisFeedback> {
      const ts = isoNow();
      const feedback: AionisFeedback = {
        id: requireNonEmpty(input.id ?? randomUUID(), "feedback id"),
        scope: requireNonEmpty(input.scope, "scope"),
        memoryId: requireNonEmpty(input.memoryId, "memoryId"),
        outcome: input.outcome,
        strength: input.strength,
        runId: input.runId ?? null,
        evidenceRef: input.evidenceRef ?? null,
        createdAt: input.createdAt ?? ts,
      };
      await append({
        id: randomUUID(),
        type: "memory.feedback.recorded",
        createdAt: ts,
        payload: feedback,
      });
      return feedback;
    },

    async recordDecision(input: AionisDecisionTraceInput): Promise<AionisDecisionTrace> {
      const trace: AionisDecisionTrace = {
        id: requireNonEmpty(input.id ?? randomUUID(), "decision trace id"),
        scope: requireNonEmpty(input.scope, "scope"),
        query: input.query ?? null,
        decisions: input.decisions,
        createdAt: input.createdAt ?? isoNow(),
      };
      await append({
        id: randomUUID(),
        type: "memory.decision.recorded",
        createdAt: trace.createdAt,
        payload: trace,
      });
      return trace;
    },

    async previewContext(input): Promise<AionisCompiledContext> {
      return buildContext(input);
    },

    async compileContext(input): Promise<AionisCompiledContext> {
      const context = buildContext(input);
      await append({
        id: randomUUID(),
        type: "memory.decision.recorded",
        createdAt: context.decision_trace.createdAt,
        payload: context.decision_trace,
      });
      return context;
    },

    async getNode(scope: string, id: string): Promise<AionisMemoryNode | null> {
      return state.nodes.get(eventKey(scope, id)) ?? null;
    },

    async listNodes(scope: string): Promise<AionisMemoryNode[]> {
      return sortNodes(Array.from(state.nodes.values()).filter((node) => node.scope === scope));
    },

    async searchNodes(input) {
      return await searchWithCandidateIndex(input);
    },

    async listRelations(scope: string, memoryId?: string | null): Promise<AionisRelation[]> {
      const relations = Array.from(state.relations.values()).filter((relation) => {
        if (relation.scope !== scope) return false;
        if (!memoryId) return true;
        return relation.sourceId === memoryId || relation.targetId === memoryId;
      });
      return sortRelations(relations);
    },

    async listFeedback(input): Promise<AionisFeedback[]> {
      const feedback = Array.from(state.feedback.values()).filter((item) => {
        if (item.scope !== input.scope) return false;
        if (!input.memoryId) return true;
        return item.memoryId === input.memoryId;
      });
      return sortFeedback(feedback);
    },

    async listDecisions(scope: string): Promise<AionisDecisionTrace[]> {
      return sortDecisions(Array.from(state.decisions.values()).filter((decision) => decision.scope === scope));
    },

    async listEvents(): Promise<AionisEvent[]> {
      return [...state.events];
    },

    async close(): Promise<void> {
      await tail.catch(() => undefined);
      await candidateIndex?.close?.();
    },
  };
}
