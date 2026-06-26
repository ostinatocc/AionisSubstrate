import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  importRuntimeLiteSnapshot,
  type RuntimeSnapshotImportSummary,
} from "./runtime-snapshot-importer.ts";
import type {
  AionisDecisionTrace,
  AionisDecisionTraceInput,
  AionisFeedback,
  AionisFeedbackInput,
  AionisMemoryNode,
  AionisMemoryNodeInput,
  AionisRelation,
  AionisRelationInput,
  AionisSubstrate,
  AionisSubstrateStoreInfo,
} from "./types.ts";

export type RuntimeLiveSidecarCheckpoint = {
  contract_version: "aionis_runtime_live_sidecar_checkpoint_v1";
  source_path: string;
  scope: string | null;
  updated_at: string;
  last_run_id: string | null;
  fingerprints: {
    nodes: Record<string, string>;
    relations: Record<string, string>;
    feedback: Record<string, string>;
    decisions: Record<string, string>;
  };
};

export type RuntimeLiveSidecarApplyStats = {
  attempted: number;
  applied: number;
  unchanged: number;
};

export type RuntimeLiveSidecarReport = {
  contract_version: "aionis_runtime_live_sidecar_report_v1";
  run_id: string;
  generated_at: string;
  source_path: string;
  scope: string | null;
  checkpoint_path: string;
  dry_run: boolean;
  import_summary: RuntimeSnapshotImportSummary;
  apply_summary: {
    nodes: RuntimeLiveSidecarApplyStats;
    relations: RuntimeLiveSidecarApplyStats;
    feedback: RuntimeLiveSidecarApplyStats;
    decisions: RuntimeLiveSidecarApplyStats;
  };
  store_before: AionisSubstrateStoreInfo;
  store_after: AionisSubstrateStoreInfo;
  checkpoint_before: {
    present: boolean;
    fingerprint_counts: Record<keyof RuntimeLiveSidecarCheckpoint["fingerprints"], number>;
  };
  checkpoint_after: {
    fingerprint_counts: Record<keyof RuntimeLiveSidecarCheckpoint["fingerprints"], number>;
  };
  warnings: string[];
};

export type RuntimeLiveSidecarOptions = {
  sourcePath: string;
  target: AionisSubstrate;
  checkpointPath: string;
  scope?: string;
  limit?: number;
  dryRun?: boolean;
};

type RuntimeLiveFingerprintKind = keyof RuntimeLiveSidecarCheckpoint["fingerprints"];

function emptyStats(): RuntimeLiveSidecarApplyStats {
  return { attempted: 0, applied: 0, unchanged: 0 };
}

function emptyCheckpoint(sourcePath: string, scope: string | null): RuntimeLiveSidecarCheckpoint {
  return {
    contract_version: "aionis_runtime_live_sidecar_checkpoint_v1",
    source_path: sourcePath,
    scope,
    updated_at: new Date(0).toISOString(),
    last_run_id: null,
    fingerprints: {
      nodes: {},
      relations: {},
      feedback: {},
      decisions: {},
    },
  };
}

function fingerprintCounts(checkpoint: RuntimeLiveSidecarCheckpoint): Record<RuntimeLiveFingerprintKind, number> {
  return {
    nodes: Object.keys(checkpoint.fingerprints.nodes).length,
    relations: Object.keys(checkpoint.fingerprints.relations).length,
    feedback: Object.keys(checkpoint.fingerprints.feedback).length,
    decisions: Object.keys(checkpoint.fingerprints.decisions).length,
  };
}

function hasFingerprints(checkpoint: RuntimeLiveSidecarCheckpoint): boolean {
  const counts = fingerprintCounts(checkpoint);
  return counts.nodes > 0 || counts.relations > 0 || counts.feedback > 0 || counts.decisions > 0;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function scopedKey(scope: string, id: string): string {
  return `${scope}\u0000${id}`;
}

function checkpointKey(kind: RuntimeLiveFingerprintKind, input: AionisMemoryNodeInput | AionisRelationInput | AionisFeedbackInput | AionisDecisionTraceInput): string {
  if (kind === "nodes") {
    const node = input as AionisMemoryNodeInput;
    if (!node.id) throw new Error("Runtime live sidecar requires imported node ids");
    return scopedKey(node.scope, node.id);
  }
  if (kind === "relations") {
    const relation = input as AionisRelationInput;
    if (!relation.id) throw new Error("Runtime live sidecar requires imported relation ids");
    return scopedKey(relation.scope, relation.id);
  }
  if (kind === "feedback") {
    const feedback = input as AionisFeedbackInput;
    if (!feedback.id) throw new Error("Runtime live sidecar requires imported feedback ids");
    return scopedKey(feedback.scope, feedback.id);
  }
  const decision = input as AionisDecisionTraceInput;
  if (!decision.id) throw new Error("Runtime live sidecar requires imported decision ids");
  return scopedKey(decision.scope, decision.id);
}

async function loadCheckpoint(path: string, sourcePath: string, scope: string | null): Promise<{ present: boolean; checkpoint: RuntimeLiveSidecarCheckpoint }> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as RuntimeLiveSidecarCheckpoint;
    if (parsed.contract_version !== "aionis_runtime_live_sidecar_checkpoint_v1") {
      throw new Error(`unsupported checkpoint contract: ${(parsed as { contract_version?: unknown }).contract_version}`);
    }
    if (parsed.source_path !== sourcePath || parsed.scope !== scope) {
      throw new Error("checkpoint source_path/scope does not match the requested Runtime source");
    }
    return { present: true, checkpoint: parsed };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { present: false, checkpoint: emptyCheckpoint(sourcePath, scope) };
    }
    throw err;
  }
}

async function writeCheckpoint(path: string, checkpoint: RuntimeLiveSidecarCheckpoint): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tempPath, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

function makeUnchangedNode(input: AionisMemoryNodeInput, existing: AionisMemoryNode | null): AionisMemoryNode {
  if (existing) return existing;
  return {
    id: input.id as string,
    scope: input.scope,
    kind: input.kind,
    title: input.title ?? null,
    summary: input.summary,
    lifecycle: input.lifecycle ?? "candidate",
    authority: input.authority ?? "unknown",
    confidence: input.confidence ?? 0.5,
    targetFiles: input.targetFiles ?? [],
    payloadRef: input.payloadRef ?? null,
    agentId: input.agentId ?? null,
    teamId: input.teamId ?? null,
    metadata: input.metadata ?? {},
    createdAt: input.createdAt ?? new Date(0).toISOString(),
    updatedAt: input.updatedAt ?? input.createdAt ?? new Date(0).toISOString(),
  };
}

function makeUnchangedRelation(input: AionisRelationInput): AionisRelation {
  return {
    id: input.id as string,
    scope: input.scope,
    kind: input.kind,
    sourceId: input.sourceId,
    targetId: input.targetId,
    confidence: input.confidence ?? 0.7,
    reasons: input.reasons ?? [],
    metadata: input.metadata ?? {},
    createdAt: input.createdAt ?? new Date(0).toISOString(),
  };
}

function makeUnchangedFeedback(input: AionisFeedbackInput): AionisFeedback {
  return {
    id: input.id as string,
    scope: input.scope,
    memoryId: input.memoryId,
    outcome: input.outcome,
    strength: input.strength,
    runId: input.runId ?? null,
    evidenceRef: input.evidenceRef ?? null,
    createdAt: input.createdAt ?? new Date(0).toISOString(),
  };
}

function makeUnchangedDecision(input: AionisDecisionTraceInput): AionisDecisionTrace {
  return {
    id: input.id as string,
    scope: input.scope,
    query: input.query ?? null,
    decisions: input.decisions,
    createdAt: input.createdAt ?? new Date(0).toISOString(),
  };
}

function decorateTarget(
  target: AionisSubstrate,
  checkpoint: RuntimeLiveSidecarCheckpoint,
  nextCheckpoint: RuntimeLiveSidecarCheckpoint,
  stats: RuntimeLiveSidecarReport["apply_summary"],
  dryRun: boolean,
): AionisSubstrate {
  async function shouldApply(
    kind: RuntimeLiveFingerprintKind,
    key: string,
    value: unknown,
    stat: RuntimeLiveSidecarApplyStats,
    forceApply = false,
  ): Promise<boolean> {
    stat.attempted += 1;
    const hash = fingerprint(value);
    if (checkpoint.fingerprints[kind][key] === hash && !forceApply) {
      stat.unchanged += 1;
      nextCheckpoint.fingerprints[kind][key] = hash;
      return false;
    }
    stat.applied += 1;
    nextCheckpoint.fingerprints[kind][key] = hash;
    return !dryRun;
  }

  return {
    ...target,
    async putNode(input): Promise<AionisMemoryNode> {
      const key = checkpointKey("nodes", input);
      const existing = await target.getNode(input.scope, input.id as string);
      const apply = await shouldApply("nodes", key, input, stats.nodes, existing === null);
      if (!apply) return makeUnchangedNode(input, existing);
      return await target.putNode(input);
    },
    async putRelation(input): Promise<AionisRelation> {
      const key = checkpointKey("relations", input);
      const existing = (await target.listRelations(input.scope)).some((relation) => relation.id === input.id);
      const apply = await shouldApply("relations", key, input, stats.relations, !existing);
      if (!apply) return makeUnchangedRelation(input);
      return await target.putRelation(input);
    },
    async recordFeedback(input): Promise<AionisFeedback> {
      const key = checkpointKey("feedback", input);
      const existing = (await target.listFeedback({ scope: input.scope, memoryId: input.memoryId }))
        .some((feedback) => feedback.id === input.id);
      const apply = await shouldApply("feedback", key, input, stats.feedback, !existing);
      if (!apply) return makeUnchangedFeedback(input);
      return await target.recordFeedback(input);
    },
    async recordDecision(input): Promise<AionisDecisionTrace> {
      const key = checkpointKey("decisions", input);
      const existing = (await target.listDecisions(input.scope)).some((decision) => decision.id === input.id);
      const apply = await shouldApply("decisions", key, input, stats.decisions, !existing);
      if (!apply) return makeUnchangedDecision(input);
      return await target.recordDecision(input);
    },
  };
}

export async function runRuntimeLiveSidecarOnce(options: RuntimeLiveSidecarOptions): Promise<RuntimeLiveSidecarReport> {
  const sourcePath = resolve(options.sourcePath);
  const checkpointPath = resolve(options.checkpointPath);
  const scope = options.scope?.trim() || null;
  const checkpointResult = await loadCheckpoint(checkpointPath, sourcePath, scope);
  const checkpointBeforeCounts = fingerprintCounts(checkpointResult.checkpoint);
  const runId = randomUUID();
  const generatedAt = new Date().toISOString();
  const stats = {
    nodes: emptyStats(),
    relations: emptyStats(),
    feedback: emptyStats(),
    decisions: emptyStats(),
  };
  const storeBefore = await options.target.getStoreInfo();
  const warnings: string[] = [];
  let checkpoint = checkpointResult.checkpoint;
  if (checkpointResult.present && storeBefore.eventCount === 0 && hasFingerprints(checkpoint)) {
    warnings.push("checkpoint ignored because target store is empty; replaying Runtime snapshot into target");
    checkpoint = emptyCheckpoint(sourcePath, scope);
  }
  const nextCheckpoint: RuntimeLiveSidecarCheckpoint = JSON.parse(JSON.stringify(checkpoint)) as RuntimeLiveSidecarCheckpoint;
  const decorated = decorateTarget(options.target, checkpoint, nextCheckpoint, stats, Boolean(options.dryRun));
  const importSummary = await importRuntimeLiteSnapshot({
    sourcePath,
    target: decorated,
    scope: scope ?? undefined,
    limit: options.limit,
  });
  nextCheckpoint.source_path = sourcePath;
  nextCheckpoint.scope = scope;
  nextCheckpoint.updated_at = generatedAt;
  nextCheckpoint.last_run_id = runId;
  if (!options.dryRun) await writeCheckpoint(checkpointPath, nextCheckpoint);
  const storeAfter = await options.target.getStoreInfo();
  return {
    contract_version: "aionis_runtime_live_sidecar_report_v1",
    run_id: runId,
    generated_at: generatedAt,
    source_path: sourcePath,
    scope,
    checkpoint_path: checkpointPath,
    dry_run: Boolean(options.dryRun),
    import_summary: importSummary,
    apply_summary: stats,
    store_before: storeBefore,
    store_after: storeAfter,
    checkpoint_before: {
      present: checkpointResult.present,
      fingerprint_counts: checkpointBeforeCounts,
    },
    checkpoint_after: {
      fingerprint_counts: fingerprintCounts(nextCheckpoint),
    },
    warnings: [...warnings, ...importSummary.warnings],
  };
}
