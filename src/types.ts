export const AIONIS_SUBSTRATE_SCHEMA_VERSION = 1;

export type AionisMemoryKind =
  | "execution"
  | "procedure"
  | "fact"
  | "preference"
  | "claim"
  | "feedback"
  | "trace_pointer";

export type AionisLifecycleState =
  | "active"
  | "candidate"
  | "contested"
  | "suppressed"
  | "archived"
  | "retired"
  | "blocked"
  | "rehydrate_required";

export type AionisAuthorityState =
  | "verified"
  | "trusted"
  | "advisory"
  | "unknown"
  | "rejected";

export type AionisRelationKind =
  | "supports"
  | "derived_from"
  | "supersedes"
  | "contradicts"
  | "invalidates"
  | "requires_payload";

export type AionisAdmissionAction =
  | "use_now"
  | "inspect_before_use"
  | "do_not_use"
  | "rehydrate";

export type AionisSubstrateAdapterKind = "file" | "sqlite";

export type JsonObject = Record<string, unknown>;

export type AionisMemoryNode = {
  id: string;
  scope: string;
  kind: AionisMemoryKind;
  title?: string | null;
  summary: string;
  lifecycle: AionisLifecycleState;
  authority: AionisAuthorityState;
  confidence: number;
  targetFiles?: string[];
  payloadRef?: string | null;
  agentId?: string | null;
  teamId?: string | null;
  metadata?: JsonObject;
  createdAt: string;
  updatedAt: string;
};

export type AionisMemoryNodeInput = {
  id?: string;
  scope: string;
  kind: AionisMemoryKind;
  title?: string | null;
  summary: string;
  lifecycle?: AionisLifecycleState;
  authority?: AionisAuthorityState;
  confidence?: number;
  targetFiles?: string[];
  payloadRef?: string | null;
  agentId?: string | null;
  teamId?: string | null;
  metadata?: JsonObject;
  createdAt?: string;
  updatedAt?: string;
};

export type AionisRelation = {
  id: string;
  scope: string;
  kind: AionisRelationKind;
  sourceId: string;
  targetId: string;
  confidence: number;
  reasons: string[];
  metadata?: JsonObject;
  createdAt: string;
};

export type AionisRelationInput = {
  id?: string;
  scope: string;
  kind: AionisRelationKind;
  sourceId: string;
  targetId: string;
  confidence?: number;
  reasons?: string[];
  metadata?: JsonObject;
  createdAt?: string;
};

export type AionisFeedback = {
  id: string;
  scope: string;
  memoryId: string;
  outcome: "positive" | "negative" | "neutral";
  strength: "weak" | "strong";
  runId?: string | null;
  evidenceRef?: string | null;
  createdAt: string;
};

export type AionisFeedbackInput = Omit<AionisFeedback, "id" | "createdAt"> & {
  id?: string;
  createdAt?: string;
};

export type AionisDecisionReason = {
  code: string;
  detail: string;
  relationId?: string;
};

export type AionisAdmissionDecision = {
  memoryId: string;
  action: AionisAdmissionAction;
  reasons: AionisDecisionReason[];
};

export type AionisDecisionTrace = {
  id: string;
  scope: string;
  query?: string | null;
  decisions: AionisAdmissionDecision[];
  createdAt: string;
};

export type AionisDecisionTraceInput = {
  id?: string;
  scope: string;
  query?: string | null;
  decisions: AionisAdmissionDecision[];
  createdAt?: string;
};

export type AionisCompiledContext = {
  scope: string;
  use_now: AionisMemoryNode[];
  inspect_before_use: AionisMemoryNode[];
  do_not_use: AionisMemoryNode[];
  rehydrate: AionisMemoryNode[];
  decision_trace: AionisDecisionTrace;
};

export type AionisCheckpointState = {
  nodes: AionisMemoryNode[];
  relations: AionisRelation[];
  feedback: AionisFeedback[];
  decisions: AionisDecisionTrace[];
};

export type AionisSubstrateCheckpoint = {
  schemaVersion: number;
  coveredEventCount: number;
  coveredLastSequence: number;
  coveredEventsSha256: string;
  state: AionisCheckpointState;
};

export type AionisEvent =
  | {
      id: string;
      sequence: number;
      type: "substrate.checkpoint.created";
      createdAt: string;
      payload: AionisSubstrateCheckpoint;
    }
  | {
      id: string;
      sequence: number;
      type: "memory.node.upsert";
      createdAt: string;
      payload: AionisMemoryNode;
    }
  | {
      id: string;
      sequence: number;
      type: "memory.lifecycle.transition";
      createdAt: string;
      payload: {
        scope: string;
        memoryId: string;
        lifecycle: AionisLifecycleState;
        authority?: AionisAuthorityState;
        confidence?: number;
        reason: string;
      };
    }
  | {
      id: string;
      sequence: number;
      type: "memory.relation.upsert";
      createdAt: string;
      payload: AionisRelation;
    }
  | {
      id: string;
      sequence: number;
      type: "memory.feedback.recorded";
      createdAt: string;
      payload: AionisFeedback;
    }
  | {
      id: string;
      sequence: number;
      type: "memory.decision.recorded";
      createdAt: string;
      payload: AionisDecisionTrace;
    };

export type AionisSubstrateSnapshot = {
  version: 1;
  schemaVersion: number;
  lastSequence: number;
  nodes: AionisMemoryNode[];
  relations: AionisRelation[];
  feedback: AionisFeedback[];
  decisions: AionisDecisionTrace[];
};

export type AionisSubstrateStoreInfo = {
  adapter: AionisSubstrateAdapterKind;
  schemaVersion: number;
  lastSequence: number;
  eventCount: number;
};

export type AionisCompactionReport = {
  adapter: AionisSubstrateAdapterKind;
  schemaVersion: number;
  compacted: boolean;
  before: {
    eventCount: number;
    lastSequence: number;
    eventsSha256: string;
  };
  after: {
    eventCount: number;
    lastSequence: number;
    checkpointEventId: string | null;
  };
};

export type AionisSubstrate = {
  getStoreInfo(): Promise<AionisSubstrateStoreInfo>;
  compact(): Promise<AionisCompactionReport>;
  putNode(input: AionisMemoryNodeInput): Promise<AionisMemoryNode>;
  transitionLifecycle(input: {
    scope: string;
    memoryId: string;
    lifecycle: AionisLifecycleState;
    authority?: AionisAuthorityState;
    confidence?: number;
    reason: string;
  }): Promise<AionisMemoryNode>;
  putRelation(input: AionisRelationInput): Promise<AionisRelation>;
  recordFeedback(input: AionisFeedbackInput): Promise<AionisFeedback>;
  recordDecision(input: AionisDecisionTraceInput): Promise<AionisDecisionTrace>;
  compileContext(input: { scope: string; query?: string | null; maxPerBucket?: number }): Promise<AionisCompiledContext>;
  getNode(scope: string, id: string): Promise<AionisMemoryNode | null>;
  listNodes(scope: string): Promise<AionisMemoryNode[]>;
  listRelations(scope: string): Promise<AionisRelation[]>;
  listEvents(): Promise<AionisEvent[]>;
  close(): Promise<void>;
};
