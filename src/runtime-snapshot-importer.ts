import { DatabaseSync } from "node:sqlite";
import type {
  AionisAdmissionAction,
  AionisAdmissionDecision,
  AionisAuthorityState,
  AionisLifecycleState,
  AionisMemoryKind,
  AionisMemoryNodeInput,
  AionisRelationKind,
  AionisSubstrate,
  JsonObject,
} from "./types.ts";

export type RuntimeSnapshotImportOptions = {
  sourcePath: string;
  target: AionisSubstrate;
  scope?: string;
  limit?: number;
};

export type RuntimeSnapshotImportSummary = {
  sourcePath: string;
  scope: string | null;
  nodesRead: number;
  nodesImported: number;
  nodesSkipped: number;
  relationsRead: number;
  relationsImported: number;
  relationsSkipped: number;
  feedbackRead: number;
  feedbackImported: number;
  feedbackSkipped: number;
  decisionsRead: number;
  decisionsImported: number;
  decisionsSkipped: number;
  scopes: string[];
  warnings: string[];
  diagnostics: RuntimeSnapshotImportDiagnostics;
};

export type RuntimeSnapshotImportTableName =
  | "lite_memory_nodes"
  | "lite_memory_edges"
  | "lite_memory_execution_native_index"
  | "lite_memory_rule_feedback"
  | "lite_memory_execution_decisions";

export type RuntimeSnapshotNodeSkipReason = "not_agent_facing" | "empty_summary";
export type RuntimeSnapshotRelationSkipReason = "missing_imported_endpoint";
export type RuntimeSnapshotFeedbackSkipReason = "missing_imported_rule_node";
export type RuntimeSnapshotDecisionSkipReason = "no_imported_source_rules";
export type RuntimeSnapshotJsonIssueReason = "json_parse_failed" | "json_not_object" | "json_not_array";

export type RuntimeSnapshotImportDiagnostics = {
  sourceTables: Record<RuntimeSnapshotImportTableName, boolean>;
  skipReasons: {
    nodes: Record<RuntimeSnapshotNodeSkipReason, number>;
    relations: Record<RuntimeSnapshotRelationSkipReason, number>;
    feedback: Record<RuntimeSnapshotFeedbackSkipReason, number>;
    decisions: Record<RuntimeSnapshotDecisionSkipReason, number>;
  };
  jsonIssues: Record<RuntimeSnapshotJsonIssueReason, number>;
};

type RuntimeNodeRow = {
  id: string;
  scope: string;
  client_id: string | null;
  type: string;
  tier: string;
  title: string | null;
  text_summary: string | null;
  slots_json: string;
  raw_ref: string | null;
  evidence_ref: string | null;
  embedding_model: string | null;
  memory_lane: string;
  producer_agent_id: string | null;
  owner_agent_id: string | null;
  owner_team_id: string | null;
  embedding_status: string;
  embedding_last_error: string | null;
  salience: number;
  importance: number;
  confidence: number;
  redaction_version: number;
  commit_id: string;
  created_at: string;
};

type RuntimeEdgeRow = {
  id: string;
  scope: string;
  type: string;
  src_id: string;
  dst_id: string;
  weight: number;
  confidence: number;
  decay_rate: number;
  metadata_json: string;
  commit_id: string;
  created_at: string;
};

type RuntimeFeedbackRow = {
  id: string;
  scope: string;
  rule_node_id: string;
  run_id: string | null;
  outcome: string;
  note: string | null;
  source: string;
  decision_id: string | null;
  commit_id: string | null;
  created_at: string;
};

type RuntimeExecutionDecisionRow = {
  id: string;
  scope: string;
  decision_kind: string;
  run_id: string | null;
  selected_tool: string | null;
  candidates_json: string;
  context_sha256: string;
  policy_sha256: string;
  source_rule_ids_json: string;
  metadata_json: string;
  commit_id: string | null;
  created_at: string;
};

type RuntimeExecutionIndexRow = {
  scope: string;
  node_id: string;
  execution_kind: string | null;
  anchor_kind: string | null;
  pattern_state: string | null;
  task_signature: string | null;
  task_family: string | null;
  error_signature: string | null;
  workflow_signature: string | null;
  pattern_signature: string | null;
  repo_signature: string | null;
  file_cluster: string | null;
  target_files_text: string | null;
  tool_chain_signature: string | null;
  failure_mode: string | null;
  verification_signature: string | null;
  acceptance_check_signature: string | null;
  compression_layer: string | null;
  created_at: string;
  updated_at: string;
};

type RuntimeImportState = {
  db: DatabaseSync;
  scope: string | null;
  limit: number | null;
  warnings: string[];
  importedNodeIds: Set<string>;
  importedScopes: Set<string>;
  executionIndex: Map<string, RuntimeExecutionIndexRow>;
  diagnostics: RuntimeSnapshotImportDiagnostics;
};

type RuntimeExecutionOutcome = "passed" | "failed" | null;

function scopeKey(scope: string, id: string): string {
  return `${scope}\u0000${id}`;
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as { name?: string } | undefined;
  return row?.name === tableName;
}

function createImportDiagnostics(db: DatabaseSync): RuntimeSnapshotImportDiagnostics {
  return {
    sourceTables: {
      lite_memory_nodes: tableExists(db, "lite_memory_nodes"),
      lite_memory_edges: tableExists(db, "lite_memory_edges"),
      lite_memory_execution_native_index: tableExists(db, "lite_memory_execution_native_index"),
      lite_memory_rule_feedback: tableExists(db, "lite_memory_rule_feedback"),
      lite_memory_execution_decisions: tableExists(db, "lite_memory_execution_decisions"),
    },
    skipReasons: {
      nodes: {
        not_agent_facing: 0,
        empty_summary: 0,
      },
      relations: {
        missing_imported_endpoint: 0,
      },
      feedback: {
        missing_imported_rule_node: 0,
      },
      decisions: {
        no_imported_source_rules: 0,
      },
    },
    jsonIssues: {
      json_parse_failed: 0,
      json_not_object: 0,
      json_not_array: 0,
    },
  };
}

function recordJsonIssue(diagnostics: RuntimeSnapshotImportDiagnostics | undefined, reason: RuntimeSnapshotJsonIssueReason): void {
  if (diagnostics) diagnostics.jsonIssues[reason] += 1;
}

function clamp(value: number, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  if (numeric < 0) return 0;
  if (numeric > 1) return 1;
  return numeric;
}

function normalizeToken(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseObject(raw: string | null | undefined, warnings: string[], label: string, diagnostics?: RuntimeSnapshotImportDiagnostics): JsonObject {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    const record = asRecord(parsed);
    if (!record) {
      warnings.push(`${label}: JSON was not an object`);
      recordJsonIssue(diagnostics, "json_not_object");
      return {};
    }
    return record;
  } catch (err) {
    warnings.push(`${label}: failed to parse JSON (${(err as Error).message})`);
    recordJsonIssue(diagnostics, "json_parse_failed");
    return {};
  }
}

function parseArray(raw: string | null | undefined, warnings: string[], label: string, diagnostics?: RuntimeSnapshotImportDiagnostics): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    warnings.push(`${label}: JSON was not an array`);
    recordJsonIssue(diagnostics, "json_not_array");
    return [];
  } catch (err) {
    warnings.push(`${label}: failed to parse JSON (${(err as Error).message})`);
    recordJsonIssue(diagnostics, "json_parse_failed");
    return [];
  }
}

function valueAt(record: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = record;
  for (const part of path) {
    const currentRecord = asRecord(current);
    if (!currentRecord) return undefined;
    current = currentRecord[part];
  }
  return current;
}

function firstStringAt(record: Record<string, unknown>, paths: string[][]): string | null {
  for (const path of paths) {
    const value = valueAt(record, path);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function firstBooleanAt(record: Record<string, unknown>, paths: string[][]): boolean | null {
  for (const path of paths) {
    const value = valueAt(record, path);
    if (typeof value === "boolean") return value;
  }
  return null;
}

function stringsAt(record: Record<string, unknown>, paths: string[][]): string[] {
  const out: string[] = [];
  for (const path of paths) {
    const value = valueAt(record, path);
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim()) out.push(item.trim());
      }
    } else if (typeof value === "string" && value.trim()) {
      out.push(...value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean));
    }
  }
  return Array.from(new Set(out));
}

function hasTruthyAt(record: Record<string, unknown>, paths: string[][]): boolean {
  for (const path of paths) {
    const value = valueAt(record, path);
    if (value === true) return true;
  }
  return false;
}

function normalizeLifecycle(value: string | null): AionisLifecycleState | null {
  const token = normalizeToken(value);
  if (!token) return null;
  if (token === "active" || token === "current" || token === "accepted" || token === "promoted" || token === "trusted") return "active";
  if (token === "candidate" || token === "pending" || token === "advisory" || token === "draft") return "candidate";
  if (token === "contested" || token === "ambiguous" || token === "inspect" || token === "inspect_before_use") return "contested";
  if (token === "suppressed" || token === "quarantined" || token === "filtered") return "suppressed";
  if (token === "archived" || token === "archive" || token === "cold_archive") return "archived";
  if (token === "retired" || token === "deprecated") return "retired";
  if (token === "blocked" || token === "do_not_use" || token === "invalid" || token === "rejected") return "blocked";
  if (token === "rehydrate" || token === "rehydrate_required" || token === "payload_required") return "rehydrate_required";
  return null;
}

function runtimeTokenIndicatesFailed(token: string): boolean {
  return token === "failed"
    || token === "failure"
    || token === "fail"
    || token === "failed_branch"
    || token === "rejected_branch"
    || token === "invalid"
    || token.includes("failed")
    || token.includes("failure")
    || token.includes("failed_branch");
}

function runtimeTokenIndicatesPassed(token: string): boolean {
  return token === "passed"
    || token === "pass"
    || token === "succeeded"
    || token === "success"
    || token === "passed_solution"
    || token === "accepted_solution"
    || token === "verified"
    || token.includes("passed")
    || token.includes("succeeded")
    || token.includes("passed_solution");
}

function deriveRuntimeExecutionOutcome(
  slots: JsonObject,
  executionIndex: RuntimeExecutionIndexRow | undefined,
): RuntimeExecutionOutcome {
  const passedBoolean = firstBooleanAt(slots, [
    ["verification", "passed"],
    ["execution_native_v1", "verification", "passed"],
    ["execution_contract_v1", "verification", "passed"],
  ]);
  if (passedBoolean === false) return "failed";

  const tokens = [
    firstStringAt(slots, [["execution_result_summary", "status"]]),
    firstStringAt(slots, [["execution_observation_v1", "outcome"]]),
    firstStringAt(slots, [["execution_observation_v1", "execution_outcome_role"]]),
    firstStringAt(slots, [["execution_native_v1", "execution_outcome_role"]]),
    firstStringAt(slots, [["execution_contract_v1", "execution_outcome_role"]]),
    executionIndex?.pattern_state ?? null,
    executionIndex?.failure_mode ?? null,
    executionIndex?.verification_signature ?? null,
  ].map(normalizeToken).filter(Boolean);

  if (tokens.some(runtimeTokenIndicatesFailed)) return "failed";
  if (passedBoolean === true) return "passed";
  if (tokens.some(runtimeTokenIndicatesPassed)) return "passed";
  return null;
}

function isRuntimeAuditOnlyNode(slots: JsonObject): boolean {
  return hasTruthyAt(slots, [
    ["not_agent_facing"],
    ["guide_exposure_v1", "not_agent_facing"],
    ["product_measure_v1", "not_agent_facing"],
    ["runtime_audit_v1", "not_agent_facing"],
  ]);
}

function normalizeAuthority(value: string | null): AionisAuthorityState | null {
  const token = normalizeToken(value);
  if (!token) return null;
  if (token === "verified") return "verified";
  if (token === "trusted" || token === "accepted" || token === "promoted" || token === "stable") return "trusted";
  if (token === "advisory" || token === "candidate" || token === "draft" || token === "inspect") return "advisory";
  if (token === "unknown" || token === "none") return "unknown";
  if (token === "rejected" || token === "blocked" || token === "invalid" || token === "suppressed") return "rejected";
  return null;
}

function deriveKind(row: RuntimeNodeRow, slots: JsonObject): AionisMemoryKind {
  const type = normalizeToken(row.type);
  const summaryKind = normalizeToken(firstStringAt(slots, [["summary_kind"], ["execution_native_v1", "summary_kind"]]));
  const executionKind = normalizeToken(firstStringAt(slots, [["execution_native_v1", "execution_kind"]]));
  const hasPayloadPointer = Boolean(row.raw_ref || row.evidence_ref);

  if (hasPayloadPointer && (
    type.includes("trace")
    || summaryKind.includes("trace")
    || summaryKind.includes("raw")
    || summaryKind.includes("payload")
  )) return "trace_pointer";

  if (type === "procedure" || summaryKind.includes("workflow") || summaryKind.includes("procedure")) return "procedure";
  if (type === "preference" || summaryKind.includes("preference")) return "preference";
  if (type === "claim" || summaryKind.includes("claim")) return "claim";
  if (type === "feedback" || summaryKind.includes("feedback")) return "feedback";
  if (executionKind || summaryKind.includes("handoff") || summaryKind.includes("execution") || summaryKind.includes("current")) return "execution";
  return "fact";
}

function deriveAuthority(
  row: RuntimeNodeRow,
  slots: JsonObject,
  lifecycle: AionisLifecycleState | null,
  executionOutcome: RuntimeExecutionOutcome,
): AionisAuthorityState {
  if (lifecycle === "suppressed" || lifecycle === "retired" || lifecycle === "blocked") return "rejected";
  if (executionOutcome === "failed") return "rejected";
  if (executionOutcome === "passed" && row.confidence >= 0.55) return "trusted";
  const explicit = normalizeAuthority(firstStringAt(slots, [
    ["authority"],
    ["authority_state"],
    ["contract_trust"],
    ["trust"],
    ["execution_native_v1", "contract_trust"],
    ["execution_native_v1", "authority"],
    ["workflow_promotion", "promotion_state"],
    ["execution_native_v1", "workflow_promotion", "promotion_state"],
  ]));
  if (explicit) return explicit;

  const summaryKind = normalizeToken(firstStringAt(slots, [["summary_kind"], ["execution_native_v1", "summary_kind"]]));
  if ((summaryKind === "workflow_anchor" || summaryKind === "current_state" || summaryKind === "current_route") && row.confidence >= 0.7) {
    return "trusted";
  }
  return "unknown";
}

function deriveLifecycle(
  row: RuntimeNodeRow,
  slots: JsonObject,
  authority: AionisAuthorityState,
  executionOutcome: RuntimeExecutionOutcome,
): AionisLifecycleState {
  const explicit = normalizeLifecycle(firstStringAt(slots, [
    ["lifecycle"],
    ["lifecycle_state"],
    ["memory_lifecycle"],
    ["admission_lifecycle"],
    ["execution_native_v1", "lifecycle"],
    ["execution_native_v1", "lifecycle_state"],
    ["workflow_promotion", "promotion_state"],
    ["execution_native_v1", "workflow_promotion", "promotion_state"],
  ]));
  if (explicit === "suppressed" || explicit === "retired" || explicit === "blocked" || explicit === "archived" || explicit === "rehydrate_required") {
    return explicit;
  }

  if (executionOutcome === "failed") return "blocked";
  if (executionOutcome === "passed") return "active";
  if (explicit) return explicit;

  const tier = normalizeToken(row.tier);
  if (tier === "archive" || tier === "archived") return "archived";
  if ((tier === "cold" || tier === "payload") && (row.raw_ref || row.evidence_ref)) return "rehydrate_required";

  const summaryKind = normalizeToken(firstStringAt(slots, [["summary_kind"], ["execution_native_v1", "summary_kind"]]));
  if (summaryKind.includes("candidate")) return "candidate";
  if (summaryKind === "workflow_anchor" || summaryKind === "current_state" || summaryKind === "current_route") return "active";

  if (authority === "trusted" || authority === "verified") return "active";
  if (authority === "rejected") return "blocked";
  return "candidate";
}

function deriveTargetFiles(row: RuntimeNodeRow, slots: JsonObject, executionIndex: RuntimeExecutionIndexRow | undefined): string[] {
  const fromSlots = stringsAt(slots, [
    ["target_files"],
    ["anchor_v1", "target_files"],
    ["execution_native_v1", "target_files"],
    ["execution_contract_v1", "target_files"],
    ["handoff", "target_files"],
    ["contract", "target_files"],
  ]);
  const fromIndex = executionIndex?.target_files_text
    ? executionIndex.target_files_text.split(/[\n,]/).map((item) => item.trim()).filter(Boolean)
    : [];
  return Array.from(new Set([...fromSlots, ...fromIndex]));
}

function metadataForNode(row: RuntimeNodeRow, slots: JsonObject, executionIndex: RuntimeExecutionIndexRow | undefined): JsonObject {
  return {
    imported_from: "aionis_runtime_lite_snapshot",
    runtime: {
      client_id: row.client_id,
      type: row.type,
      tier: row.tier,
      memory_lane: row.memory_lane,
      embedding_model: row.embedding_model,
      embedding_status: row.embedding_status,
      embedding_last_error: row.embedding_last_error,
      salience: row.salience,
      importance: row.importance,
      redaction_version: row.redaction_version,
      commit_id: row.commit_id,
      created_at: row.created_at,
    },
    runtime_slots: slots,
    runtime_execution_index: executionIndex ?? null,
  };
}

function mapNode(row: RuntimeNodeRow, executionIndex: RuntimeExecutionIndexRow | undefined, state: RuntimeImportState): AionisMemoryNodeInput | null {
  const slots = parseObject(row.slots_json, state.warnings, `node ${row.id} slots_json`, state.diagnostics);
  if (isRuntimeAuditOnlyNode(slots)) {
    state.diagnostics.skipReasons.nodes.not_agent_facing += 1;
    state.warnings.push(`node ${row.id}: skipped because Runtime marked it not_agent_facing`);
    return null;
  }
  const executionOutcome = deriveRuntimeExecutionOutcome(slots, executionIndex);
  const authorityProbe = deriveAuthority(row, slots, null, executionOutcome);
  const lifecycle = deriveLifecycle(row, slots, authorityProbe, executionOutcome);
  const authority = deriveAuthority(row, slots, lifecycle, executionOutcome);
  const summary = row.text_summary?.trim() || row.title?.trim();
  if (!summary) {
    state.diagnostics.skipReasons.nodes.empty_summary += 1;
    state.warnings.push(`node ${row.id}: skipped because title/text_summary are empty`);
    return null;
  }

  return {
    id: row.id,
    scope: row.scope,
    kind: deriveKind(row, slots),
    title: row.title,
    summary,
    lifecycle,
    authority,
    confidence: clamp(row.confidence, 0.5),
    targetFiles: deriveTargetFiles(row, slots, executionIndex),
    payloadRef: row.raw_ref ?? row.evidence_ref ?? null,
    agentId: row.owner_agent_id ?? row.producer_agent_id ?? null,
    teamId: row.owner_team_id,
    metadata: metadataForNode(row, slots, executionIndex),
    createdAt: row.created_at,
    updatedAt: executionIndex?.updated_at ?? row.created_at,
  };
}

function mapRelationKind(type: string): AionisRelationKind {
  const token = normalizeToken(type).replaceAll("-", "_");
  if (token.includes("supersed") || token.includes("replace")) return "supersedes";
  if (token.includes("contradict") || token.includes("conflict")) return "contradicts";
  if (token.includes("invalid")) return "invalidates";
  if (token.includes("payload") || token.includes("rehydrate")) return "requires_payload";
  if (token.includes("derive") || token.includes("lineage")) return "derived_from";
  return "supports";
}

function feedbackOutcome(value: string): "positive" | "negative" | "neutral" {
  const token = normalizeToken(value);
  if (["positive", "success", "succeeded", "pass", "passed", "accepted", "win"].includes(token)) return "positive";
  if (["negative", "failure", "failed", "fail", "error", "rejected", "loss"].includes(token)) return "negative";
  return "neutral";
}

function decisionActionForRuntimeDecision(row: RuntimeExecutionDecisionRow): AionisAdmissionAction {
  const kind = normalizeToken(row.decision_kind);
  if (kind.includes("block") || kind.includes("reject")) return "do_not_use";
  if (kind.includes("payload") || kind.includes("rehydrate")) return "rehydrate";
  if (kind.includes("use") || kind.includes("select")) return "inspect_before_use";
  return "inspect_before_use";
}

function readExecutionIndex(state: RuntimeImportState): Map<string, RuntimeExecutionIndexRow> {
  if (!tableExists(state.db, "lite_memory_execution_native_index")) return new Map();
  const rows = (state.scope
    ? state.db.prepare("SELECT * FROM lite_memory_execution_native_index WHERE scope = ?").all(state.scope)
    : state.db.prepare("SELECT * FROM lite_memory_execution_native_index").all()) as RuntimeExecutionIndexRow[];
  return new Map(rows.map((row) => [scopeKey(row.scope, row.node_id), row]));
}

function readNodes(state: RuntimeImportState): RuntimeNodeRow[] {
  if (!tableExists(state.db, "lite_memory_nodes")) throw new Error("source Runtime SQLite is missing lite_memory_nodes");
  const limitClause = state.limit === null ? "" : " LIMIT ?";
  if (state.scope) {
    const sql = `SELECT * FROM lite_memory_nodes WHERE scope = ? ORDER BY created_at ASC, id ASC${limitClause}`;
    return (state.limit === null
      ? state.db.prepare(sql).all(state.scope)
      : state.db.prepare(sql).all(state.scope, state.limit)) as RuntimeNodeRow[];
  }
  const sql = `SELECT * FROM lite_memory_nodes ORDER BY created_at ASC, id ASC${limitClause}`;
  return (state.limit === null ? state.db.prepare(sql).all() : state.db.prepare(sql).all(state.limit)) as RuntimeNodeRow[];
}

function readEdges(state: RuntimeImportState): RuntimeEdgeRow[] {
  if (!tableExists(state.db, "lite_memory_edges")) return [];
  if (state.scope) {
    return state.db.prepare("SELECT * FROM lite_memory_edges WHERE scope = ? ORDER BY created_at ASC, id ASC").all(state.scope) as RuntimeEdgeRow[];
  }
  return state.db.prepare("SELECT * FROM lite_memory_edges ORDER BY created_at ASC, id ASC").all() as RuntimeEdgeRow[];
}

function readFeedback(state: RuntimeImportState): RuntimeFeedbackRow[] {
  if (!tableExists(state.db, "lite_memory_rule_feedback")) return [];
  if (state.scope) {
    return state.db.prepare("SELECT * FROM lite_memory_rule_feedback WHERE scope = ? ORDER BY created_at ASC, id ASC").all(state.scope) as RuntimeFeedbackRow[];
  }
  return state.db.prepare("SELECT * FROM lite_memory_rule_feedback ORDER BY created_at ASC, id ASC").all() as RuntimeFeedbackRow[];
}

function readExecutionDecisions(state: RuntimeImportState): RuntimeExecutionDecisionRow[] {
  if (!tableExists(state.db, "lite_memory_execution_decisions")) return [];
  if (state.scope) {
    return state.db.prepare("SELECT * FROM lite_memory_execution_decisions WHERE scope = ? ORDER BY created_at ASC, id ASC").all(state.scope) as RuntimeExecutionDecisionRow[];
  }
  return state.db.prepare("SELECT * FROM lite_memory_execution_decisions ORDER BY created_at ASC, id ASC").all() as RuntimeExecutionDecisionRow[];
}

export async function importRuntimeLiteSnapshot(options: RuntimeSnapshotImportOptions): Promise<RuntimeSnapshotImportSummary> {
  const sourcePath = options.sourcePath.trim();
  if (!sourcePath) throw new Error("sourcePath is required");
  const db = new DatabaseSync(sourcePath, { readOnly: true });
  const diagnostics = createImportDiagnostics(db);
  const state: RuntimeImportState = {
    db,
    scope: options.scope?.trim() || null,
    limit: options.limit === undefined ? null : Math.max(0, Math.trunc(options.limit)),
    warnings: [],
    importedNodeIds: new Set(),
    importedScopes: new Set(),
    executionIndex: new Map(),
    diagnostics,
  };

  const summary: RuntimeSnapshotImportSummary = {
    sourcePath,
    scope: state.scope,
    nodesRead: 0,
    nodesImported: 0,
    nodesSkipped: 0,
    relationsRead: 0,
    relationsImported: 0,
    relationsSkipped: 0,
    feedbackRead: 0,
    feedbackImported: 0,
    feedbackSkipped: 0,
    decisionsRead: 0,
    decisionsImported: 0,
    decisionsSkipped: 0,
    scopes: [],
    warnings: state.warnings,
    diagnostics,
  };

  try {
    state.executionIndex = readExecutionIndex(state);
    const nodes = readNodes(state);
    summary.nodesRead = nodes.length;
    for (const row of nodes) {
      const mapped = mapNode(row, state.executionIndex.get(scopeKey(row.scope, row.id)), state);
      if (!mapped) {
        summary.nodesSkipped += 1;
        continue;
      }
      await options.target.putNode(mapped);
      state.importedNodeIds.add(scopeKey(mapped.scope, mapped.id ?? row.id));
      state.importedScopes.add(mapped.scope);
      summary.nodesImported += 1;
    }

    const edges = readEdges(state);
    summary.relationsRead = edges.length;
    for (const row of edges) {
      const srcKey = scopeKey(row.scope, row.src_id);
      const dstKey = scopeKey(row.scope, row.dst_id);
      if (!state.importedNodeIds.has(srcKey) || !state.importedNodeIds.has(dstKey)) {
        summary.relationsSkipped += 1;
        state.diagnostics.skipReasons.relations.missing_imported_endpoint += 1;
        state.warnings.push(`edge ${row.id}: skipped because source or target node was not imported`);
        continue;
      }
      await options.target.putRelation({
        id: row.id,
        scope: row.scope,
        kind: mapRelationKind(row.type),
        sourceId: row.src_id,
        targetId: row.dst_id,
        confidence: clamp(row.confidence, clamp(row.weight, 0.7)),
        reasons: [`imported Runtime edge type=${row.type}`],
        metadata: {
          imported_from: "aionis_runtime_lite_snapshot",
          runtime: {
            type: row.type,
            weight: row.weight,
            decay_rate: row.decay_rate,
            commit_id: row.commit_id,
            metadata: parseObject(row.metadata_json, state.warnings, `edge ${row.id} metadata_json`, state.diagnostics),
          },
        },
        createdAt: row.created_at,
      });
      summary.relationsImported += 1;
    }

    const feedbackRows = readFeedback(state);
    summary.feedbackRead = feedbackRows.length;
    for (const row of feedbackRows) {
      if (!state.importedNodeIds.has(scopeKey(row.scope, row.rule_node_id))) {
        summary.feedbackSkipped += 1;
        state.diagnostics.skipReasons.feedback.missing_imported_rule_node += 1;
        state.warnings.push(`feedback ${row.id}: skipped because rule node ${row.rule_node_id} was not imported`);
        continue;
      }
      const outcome = feedbackOutcome(row.outcome);
      await options.target.recordFeedback({
        id: row.id,
        scope: row.scope,
        memoryId: row.rule_node_id,
        outcome,
        strength: outcome === "neutral" ? "weak" : "strong",
        runId: row.run_id,
        evidenceRef: row.decision_id ?? row.commit_id ?? null,
        createdAt: row.created_at,
      });
      summary.feedbackImported += 1;
    }

    const decisions = readExecutionDecisions(state);
    summary.decisionsRead = decisions.length;
    for (const row of decisions) {
      const sourceRuleIds = parseArray(row.source_rule_ids_json, state.warnings, `decision ${row.id} source_rule_ids_json`, state.diagnostics)
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0);
      const action = decisionActionForRuntimeDecision(row);
      const mappedDecisions: AionisAdmissionDecision[] = sourceRuleIds
        .filter((id) => state.importedNodeIds.has(scopeKey(row.scope, id)))
        .map((id) => ({
          memoryId: id,
          action,
          reasons: [{
            code: "runtime_execution_decision_source_rule",
            detail: `Runtime decision ${row.decision_kind} referenced source rule ${id}`,
          }],
        }));
      if (mappedDecisions.length === 0) {
        summary.decisionsSkipped += 1;
        state.diagnostics.skipReasons.decisions.no_imported_source_rules += 1;
        continue;
      }
      await options.target.recordDecision({
        id: row.id,
        scope: row.scope,
        query: [
          `decision_kind=${row.decision_kind}`,
          row.run_id ? `run_id=${row.run_id}` : "",
          row.selected_tool ? `selected_tool=${row.selected_tool}` : "",
        ].filter(Boolean).join("; "),
        decisions: mappedDecisions,
        createdAt: row.created_at,
      });
      summary.decisionsImported += 1;
    }

    summary.nodesSkipped = summary.nodesRead - summary.nodesImported;
    summary.scopes = Array.from(state.importedScopes).sort();
    return summary;
  } finally {
    db.close();
  }
}
