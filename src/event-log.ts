import { createHash } from "node:crypto";
import { AIONIS_SUBSTRATE_SCHEMA_VERSION } from "./types.ts";
import type {
  AionisDecisionTrace,
  AionisEvent,
  AionisFeedback,
  AionisMemoryNode,
  AionisRelation,
  AionisSubstrateSnapshot,
} from "./types.ts";

export type AionisReplayState = {
  lastSequence: number;
  nodes: Map<string, AionisMemoryNode>;
  relations: Map<string, AionisRelation>;
  feedback: Map<string, AionisFeedback>;
  decisions: Map<string, AionisDecisionTrace>;
  events: AionisEvent[];
};

export function eventKey(scope: string, id: string): string {
  return `${scope}\u0000${id}`;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([name, item]) => `${JSON.stringify(name)}:${stableStringify(item)}`).join(",")}}`;
}

export function checksumAionisEvents(events: AionisEvent[]): string {
  return createHash("sha256").update(stableStringify(events)).digest("hex");
}

export function emptyReplayState(): AionisReplayState {
  return {
    lastSequence: 0,
    nodes: new Map(),
    relations: new Map(),
    feedback: new Map(),
    decisions: new Map(),
    events: [],
  };
}

export function cloneReplayState(state: AionisReplayState): AionisReplayState {
  return {
    lastSequence: state.lastSequence,
    nodes: new Map(state.nodes),
    relations: new Map(state.relations),
    feedback: new Map(state.feedback),
    decisions: new Map(state.decisions),
    events: [...state.events],
  };
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function validateEventShape(event: AionisEvent): void {
  requireString(event.id, "event.id");
  requireNumber(event.sequence, "event.sequence");
  if (!Number.isInteger(event.sequence) || event.sequence < 1) throw new Error(`invalid event sequence: ${event.sequence}`);
  requireString(event.createdAt, "event.createdAt");
  requireString(event.type, "event.type");
  if (!event.payload || typeof event.payload !== "object") throw new Error(`event payload is required for sequence ${event.sequence}`);
}

function validateCheckpointState(
  nodes: AionisMemoryNode[],
  relations: AionisRelation[],
  feedback: AionisFeedback[],
  decisions: AionisDecisionTrace[],
): void {
  const nodeKeys = new Set(nodes.map((node) => eventKey(node.scope, node.id)));
  for (const relation of relations) {
    if (!nodeKeys.has(eventKey(relation.scope, relation.sourceId))) {
      throw new Error(`checkpoint relation references missing source memory node: ${relation.sourceId}`);
    }
    if (!nodeKeys.has(eventKey(relation.scope, relation.targetId))) {
      throw new Error(`checkpoint relation references missing target memory node: ${relation.targetId}`);
    }
  }
  for (const item of feedback) {
    if (!nodeKeys.has(eventKey(item.scope, item.memoryId))) {
      throw new Error(`checkpoint feedback references missing memory node: ${item.memoryId}`);
    }
  }
  for (const trace of decisions) {
    validateDecisionTraceReferences(
      trace,
      (scope, memoryId) => nodeKeys.has(eventKey(scope, memoryId)),
      (memoryId) => `checkpoint decision references missing memory node: ${memoryId}`,
    );
  }
}

function validateDecisionTraceReferences(
  trace: AionisDecisionTrace,
  hasNode: (scope: string, memoryId: string) => boolean,
  missingMessage: (memoryId: string) => string,
): void {
  for (const decision of trace.decisions) {
    if (!hasNode(trace.scope, decision.memoryId)) {
      throw new Error(missingMessage(decision.memoryId));
    }
  }
}

export function applyAionisEvent(state: AionisReplayState, event: AionisEvent): void {
  validateEventShape(event);
  const expectedSequence = state.lastSequence + 1;
  if (event.sequence !== expectedSequence) {
    throw new Error(`event sequence gap at ${event.sequence}; expected ${expectedSequence}`);
  }
  if (state.events.some((item) => item.id === event.id)) throw new Error(`duplicate event id: ${event.id}`);

  if (event.type === "substrate.checkpoint.created") {
    if (event.payload.schemaVersion !== AIONIS_SUBSTRATE_SCHEMA_VERSION) {
      throw new Error(`unsupported checkpoint schema version: ${event.payload.schemaVersion}`);
    }
    validateCheckpointState(
      event.payload.state.nodes,
      event.payload.state.relations,
      event.payload.state.feedback,
      event.payload.state.decisions,
    );
    state.nodes = new Map(event.payload.state.nodes.map((node) => [eventKey(node.scope, node.id), node]));
    state.relations = new Map(event.payload.state.relations.map((relation) => [eventKey(relation.scope, relation.id), relation]));
    state.feedback = new Map(event.payload.state.feedback.map((item) => [eventKey(item.scope, item.id), item]));
    state.decisions = new Map(event.payload.state.decisions.map((item) => [eventKey(item.scope, item.id), item]));
  } else if (event.type === "memory.node.upsert") {
    state.nodes.set(eventKey(event.payload.scope, event.payload.id), event.payload);
  } else if (event.type === "memory.lifecycle.transition") {
    const nodeKey = eventKey(event.payload.scope, event.payload.memoryId);
    const current = state.nodes.get(nodeKey);
    if (!current) throw new Error(`cannot transition missing memory node: ${event.payload.memoryId}`);
    state.nodes.set(nodeKey, {
      ...current,
      lifecycle: event.payload.lifecycle,
      authority: event.payload.authority ?? current.authority,
      confidence: event.payload.confidence ?? current.confidence,
      updatedAt: event.createdAt,
      metadata: {
        ...(current.metadata ?? {}),
        last_lifecycle_transition_reason: event.payload.reason,
      },
    });
  } else if (event.type === "memory.relation.upsert") {
    const relation = event.payload;
    if (!state.nodes.has(eventKey(relation.scope, relation.sourceId))) {
      throw new Error(`cannot relate missing source memory node: ${relation.sourceId}`);
    }
    if (!state.nodes.has(eventKey(relation.scope, relation.targetId))) {
      throw new Error(`cannot relate missing target memory node: ${relation.targetId}`);
    }
    state.relations.set(eventKey(relation.scope, relation.id), relation);
  } else if (event.type === "memory.feedback.recorded") {
    const feedback = event.payload;
    if (!state.nodes.has(eventKey(feedback.scope, feedback.memoryId))) {
      throw new Error(`cannot record feedback for missing memory node: ${feedback.memoryId}`);
    }
    state.feedback.set(eventKey(feedback.scope, feedback.id), feedback);
  } else if (event.type === "memory.decision.recorded") {
    const decision = event.payload;
    validateDecisionTraceReferences(
      decision,
      (scope, memoryId) => state.nodes.has(eventKey(scope, memoryId)),
      (memoryId) => `cannot record decision for missing memory node: ${memoryId}`,
    );
    state.decisions.set(eventKey(decision.scope, decision.id), decision);
  } else {
    throw new Error(`unsupported event type: ${(event as { type?: string }).type}`);
  }

  state.lastSequence = event.sequence;
  state.events.push(event);
}

export function replayAionisEvents(events: AionisEvent[]): AionisReplayState {
  const state = emptyReplayState();
  for (const event of events) applyAionisEvent(state, event);
  return state;
}

export function snapshotFromReplayState(state: AionisReplayState): AionisSubstrateSnapshot {
  return {
    version: 1,
    schemaVersion: AIONIS_SUBSTRATE_SCHEMA_VERSION,
    lastSequence: state.lastSequence,
    nodes: Array.from(state.nodes.values()),
    relations: Array.from(state.relations.values()),
    feedback: Array.from(state.feedback.values()),
    decisions: Array.from(state.decisions.values()),
  };
}
