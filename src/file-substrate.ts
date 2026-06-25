import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
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
  AionisSubstrateSnapshot,
} from "./types.ts";
import { AIONIS_SUBSTRATE_SCHEMA_VERSION as CURRENT_SCHEMA_VERSION } from "./types.ts";

type FileSubstrateState = {
  lastSequence: number;
  nodes: Map<string, AionisMemoryNode>;
  relations: Map<string, AionisRelation>;
  feedback: Map<string, AionisFeedback>;
  decisions: Map<string, AionisDecisionTrace>;
  events: AionisEvent[];
};

export type FileAionisSubstrateOptions = {
  dir: string;
  now?: () => Date;
};

function key(scope: string, id: string): string {
  return `${scope}\u0000${id}`;
}

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

function emptyState(): FileSubstrateState {
  return {
    lastSequence: 0,
    nodes: new Map(),
    relations: new Map(),
    feedback: new Map(),
    decisions: new Map(),
    events: [],
  };
}

function cloneState(state: FileSubstrateState): FileSubstrateState {
  return {
    lastSequence: state.lastSequence,
    nodes: new Map(state.nodes),
    relations: new Map(state.relations),
    feedback: new Map(state.feedback),
    decisions: new Map(state.decisions),
    events: [...state.events],
  };
}

function snapshotFromState(state: FileSubstrateState): AionisSubstrateSnapshot {
  return {
    version: 1,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    lastSequence: state.lastSequence,
    nodes: Array.from(state.nodes.values()),
    relations: Array.from(state.relations.values()),
    feedback: Array.from(state.feedback.values()),
    decisions: Array.from(state.decisions.values()),
  };
}

function validateEvent(state: FileSubstrateState, event: AionisEvent): void {
  if (event.type === "memory.lifecycle.transition") {
    const nodeKey = key(event.payload.scope, event.payload.memoryId);
    if (!state.nodes.has(nodeKey)) throw new Error(`cannot transition missing memory node: ${event.payload.memoryId}`);
  } else if (event.type === "memory.relation.upsert") {
    const sourceKey = key(event.payload.scope, event.payload.sourceId);
    const targetKey = key(event.payload.scope, event.payload.targetId);
    if (!state.nodes.has(sourceKey)) throw new Error(`cannot relate missing source memory node: ${event.payload.sourceId}`);
    if (!state.nodes.has(targetKey)) throw new Error(`cannot relate missing target memory node: ${event.payload.targetId}`);
  } else if (event.type === "memory.feedback.recorded") {
    const nodeKey = key(event.payload.scope, event.payload.memoryId);
    if (!state.nodes.has(nodeKey)) throw new Error(`cannot record feedback for missing memory node: ${event.payload.memoryId}`);
  }
}

function applyEvent(state: FileSubstrateState, event: AionisEvent): void {
  validateEvent(state, event);
  if (event.type === "memory.node.upsert") {
    state.nodes.set(key(event.payload.scope, event.payload.id), event.payload);
  } else if (event.type === "memory.lifecycle.transition") {
    const nodeKey = key(event.payload.scope, event.payload.memoryId);
    const current = state.nodes.get(nodeKey)!;
    state.nodes.set(nodeKey, {
      ...current,
      lifecycle: event.payload.lifecycle,
      authority: event.payload.authority ?? current.authority,
      confidence: event.payload.confidence === undefined ? current.confidence : clampConfidence(event.payload.confidence),
      updatedAt: event.createdAt,
      metadata: {
        ...(current.metadata ?? {}),
        last_lifecycle_transition_reason: event.payload.reason,
      },
    });
  } else if (event.type === "memory.relation.upsert") {
    state.relations.set(key(event.payload.scope, event.payload.id), event.payload);
  } else if (event.type === "memory.feedback.recorded") {
    state.feedback.set(key(event.payload.scope, event.payload.id), event.payload);
  } else if (event.type === "memory.decision.recorded") {
    state.decisions.set(key(event.payload.scope, event.payload.id), event.payload);
  }
  state.lastSequence = Math.max(state.lastSequence, event.sequence);
  state.events.push(event);
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

export async function openFileAionisSubstrate(options: FileAionisSubstrateOptions): Promise<AionisSubstrate> {
  const dir = options.dir;
  const now = options.now ?? (() => new Date());
  const eventsPath = join(dir, "events.jsonl");
  const snapshotPath = join(dir, "snapshot.json");
  const state = emptyState();
  let tail: Promise<unknown> = Promise.resolve();

  await mkdir(dir, { recursive: true });
  for (const event of await readEvents(eventsPath)) {
    applyEvent(state, event);
  }
  await persistSnapshot();

  function isoNow(): string {
    return now().toISOString();
  }

  async function persistSnapshot(): Promise<void> {
    const snapshot = snapshotFromState(state);
    const tempPath = `${snapshotPath}.tmp-${process.pid}-${randomUUID()}`;
    await mkdir(dirname(snapshotPath), { recursive: true });
    await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await rename(tempPath, snapshotPath);
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
      applyEvent(cloneState(state), fullEvent);
      await appendFile(eventsPath, `${JSON.stringify(fullEvent)}\n`, "utf8");
      applyEvent(state, fullEvent);
      await persistSnapshot();
      return fullEvent;
    });
  }

  function nodeRelations(scope: string, nodeId: string): AionisRelation[] {
    return Array.from(state.relations.values()).filter((relation) => relation.scope === scope && relation.targetId === nodeId);
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

  return {
    async getStoreInfo() {
      return {
        adapter: "file",
        schemaVersion: CURRENT_SCHEMA_VERSION,
        lastSequence: state.lastSequence,
        eventCount: state.events.length,
      };
    },

    async putNode(input: AionisMemoryNodeInput): Promise<AionisMemoryNode> {
      const ts = isoNow();
      const id = input.id ?? randomUUID();
      const existing = state.nodes.get(key(input.scope, id));
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
          confidence: input.confidence,
          reason: requireNonEmpty(input.reason, "reason"),
        },
      });
      const node = state.nodes.get(key(input.scope, input.memoryId));
      if (!node) throw new Error(`missing memory node after lifecycle transition: ${input.memoryId}`);
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

    async compileContext(input): Promise<AionisCompiledContext> {
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
      await append({
        id: randomUUID(),
        type: "memory.decision.recorded",
        createdAt: trace.createdAt,
        payload: trace,
      });
      return {
        scope: input.scope,
        use_now: buckets.use_now,
        inspect_before_use: buckets.inspect_before_use,
        do_not_use: buckets.do_not_use,
        rehydrate: buckets.rehydrate,
        decision_trace: trace,
      };
    },

    async getNode(scope: string, id: string): Promise<AionisMemoryNode | null> {
      return state.nodes.get(key(scope, id)) ?? null;
    },

    async listNodes(scope: string): Promise<AionisMemoryNode[]> {
      return sortNodes(Array.from(state.nodes.values()).filter((node) => node.scope === scope));
    },

    async listRelations(scope: string): Promise<AionisRelation[]> {
      return Array.from(state.relations.values()).filter((relation) => relation.scope === scope);
    },

    async listEvents(): Promise<AionisEvent[]> {
      return [...state.events];
    },

    async close(): Promise<void> {
      await tail.catch(() => undefined);
    },
  };
}
