import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
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

export type RuntimeLiveSidecarWatchOptions = RuntimeLiveSidecarOptions & {
  intervalMs: number;
  iterations: number;
  lockPath?: string | null;
};

export type RuntimeLiveSidecarWatchReport = {
  contract_version: "aionis_runtime_live_sidecar_watch_report_v1";
  run_id: string;
  started_at: string;
  finished_at: string;
  source_path: string;
  scope: string | null;
  checkpoint_path: string;
  lock_path: string | null;
  dry_run: boolean;
  interval_ms: number;
  iterations_requested: number;
  iterations_completed: number;
  reports: RuntimeLiveSidecarReport[];
  apply_summary: RuntimeLiveSidecarReport["apply_summary"];
  warnings: string[];
};

type RuntimeLiveFingerprintKind = keyof RuntimeLiveSidecarCheckpoint["fingerprints"];

type RuntimeLiveSidecarLock = {
  path: string;
  release(): Promise<void>;
};

function emptyStats(): RuntimeLiveSidecarApplyStats {
  return { attempted: 0, applied: 0, unchanged: 0 };
}

function addStats(left: RuntimeLiveSidecarApplyStats, right: RuntimeLiveSidecarApplyStats): RuntimeLiveSidecarApplyStats {
  return {
    attempted: left.attempted + right.attempted,
    applied: left.applied + right.applied,
    unchanged: left.unchanged + right.unchanged,
  };
}

function emptyApplySummary(): RuntimeLiveSidecarReport["apply_summary"] {
  return {
    nodes: emptyStats(),
    relations: emptyStats(),
    feedback: emptyStats(),
    decisions: emptyStats(),
  };
}

function addApplySummary(
  left: RuntimeLiveSidecarReport["apply_summary"],
  right: RuntimeLiveSidecarReport["apply_summary"],
): RuntimeLiveSidecarReport["apply_summary"] {
  return {
    nodes: addStats(left.nodes, right.nodes),
    relations: addStats(left.relations, right.relations),
    feedback: addStats(left.feedback, right.feedback),
    decisions: addStats(left.decisions, right.decisions),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
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

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) throw new Error("confidence must be finite");
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeStrings(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readStringRecord(value: unknown, label: string): Record<string, string> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw new Error(`${label}.${key} must be a string fingerprint`);
    out[key] = item;
  }
  return out;
}

function parseCheckpoint(raw: string, path: string): RuntimeLiveSidecarCheckpoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`failed to parse Runtime live sidecar checkpoint ${path}: ${(err as Error).message}`);
  }
  if (!isRecord(parsed)) throw new Error(`Runtime live sidecar checkpoint ${path} must be a JSON object`);
  if (parsed.contract_version !== "aionis_runtime_live_sidecar_checkpoint_v1") {
    throw new Error(`unsupported checkpoint contract: ${String(parsed.contract_version)}`);
  }
  if (typeof parsed.source_path !== "string") throw new Error(`Runtime live sidecar checkpoint ${path} source_path must be a string`);
  if (parsed.scope !== null && typeof parsed.scope !== "string") throw new Error(`Runtime live sidecar checkpoint ${path} scope must be a string or null`);
  if (typeof parsed.updated_at !== "string") throw new Error(`Runtime live sidecar checkpoint ${path} updated_at must be a string`);
  if (parsed.last_run_id !== null && typeof parsed.last_run_id !== "string") throw new Error(`Runtime live sidecar checkpoint ${path} last_run_id must be a string or null`);
  if (!isRecord(parsed.fingerprints)) throw new Error(`Runtime live sidecar checkpoint ${path} fingerprints must be an object`);
  return {
    contract_version: "aionis_runtime_live_sidecar_checkpoint_v1",
    source_path: parsed.source_path,
    scope: parsed.scope,
    updated_at: parsed.updated_at,
    last_run_id: parsed.last_run_id,
    fingerprints: {
      nodes: readStringRecord(parsed.fingerprints.nodes, `Runtime live sidecar checkpoint ${path} fingerprints.nodes`),
      relations: readStringRecord(parsed.fingerprints.relations, `Runtime live sidecar checkpoint ${path} fingerprints.relations`),
      feedback: readStringRecord(parsed.fingerprints.feedback, `Runtime live sidecar checkpoint ${path} fingerprints.feedback`),
      decisions: readStringRecord(parsed.fingerprints.decisions, `Runtime live sidecar checkpoint ${path} fingerprints.decisions`),
    },
  };
}

async function loadCheckpoint(path: string, sourcePath: string, scope: string | null): Promise<{ present: boolean; checkpoint: RuntimeLiveSidecarCheckpoint }> {
  try {
    const parsed = parseCheckpoint(await readFile(path, "utf8"), path);
    if (parsed.source_path !== sourcePath || parsed.scope !== scope) {
      throw new Error(`checkpoint source_path/scope does not match the requested Runtime source: ${path}`);
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

async function acquireLock(path: string, metadata: Record<string, unknown>): Promise<RuntimeLiveSidecarLock> {
  await mkdir(dirname(path), { recursive: true });
  let handle;
  try {
    handle = await open(path, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Runtime live sidecar lock already exists: ${path}`);
    }
    throw err;
  }

  try {
    await handle.writeFile(`${JSON.stringify({
      contract_version: "aionis_runtime_live_sidecar_lock_v1",
      pid: process.pid,
      acquired_at: new Date().toISOString(),
      ...metadata,
    }, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }

  let released = false;
  return {
    path,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      await rm(path, { force: true });
    },
  };
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

function nodeMatchesInput(existing: AionisMemoryNode, input: AionisMemoryNodeInput): boolean {
  const materialized: AionisMemoryNode = {
    id: input.id as string,
    scope: input.scope,
    kind: input.kind,
    title: input.title ?? existing.title ?? null,
    summary: input.summary,
    lifecycle: input.lifecycle ?? existing.lifecycle ?? "candidate",
    authority: input.authority ?? existing.authority ?? "unknown",
    confidence: clampConfidence(input.confidence ?? existing.confidence ?? 0.5),
    targetFiles: normalizeStrings(input.targetFiles ?? existing.targetFiles),
    payloadRef: input.payloadRef ?? existing.payloadRef ?? null,
    agentId: input.agentId ?? existing.agentId ?? null,
    teamId: input.teamId ?? existing.teamId ?? null,
    metadata: input.metadata ?? existing.metadata ?? {},
    createdAt: existing.createdAt,
    updatedAt: input.updatedAt ?? existing.updatedAt,
  };
  return stableJson(existing) === stableJson(materialized);
}

function relationMatchesInput(existing: AionisRelation, input: AionisRelationInput): boolean {
  const materialized: AionisRelation = {
    id: input.id as string,
    scope: input.scope,
    kind: input.kind,
    sourceId: input.sourceId,
    targetId: input.targetId,
    confidence: clampConfidence(input.confidence ?? 0.7),
    reasons: normalizeStrings(input.reasons),
    metadata: input.metadata ?? {},
    createdAt: input.createdAt ?? existing.createdAt,
  };
  return stableJson(existing) === stableJson(materialized);
}

function feedbackMatchesInput(existing: AionisFeedback, input: AionisFeedbackInput): boolean {
  const materialized: AionisFeedback = {
    id: input.id as string,
    scope: input.scope,
    memoryId: input.memoryId,
    outcome: input.outcome,
    strength: input.strength,
    runId: input.runId ?? null,
    evidenceRef: input.evidenceRef ?? null,
    createdAt: input.createdAt ?? existing.createdAt,
  };
  return stableJson(existing) === stableJson(materialized);
}

function decisionMatchesInput(existing: AionisDecisionTrace, input: AionisDecisionTraceInput): boolean {
  const materialized: AionisDecisionTrace = {
    id: input.id as string,
    scope: input.scope,
    query: input.query ?? null,
    decisions: input.decisions,
    createdAt: input.createdAt ?? existing.createdAt,
  };
  return stableJson(existing) === stableJson(materialized);
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
    targetAlreadyMatches = false,
    forceApply = false,
  ): Promise<boolean> {
    stat.attempted += 1;
    const hash = fingerprint(value);
    if ((checkpoint.fingerprints[kind][key] === hash || targetAlreadyMatches) && !forceApply) {
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
      const apply = await shouldApply("nodes", key, input, stats.nodes, existing !== null && nodeMatchesInput(existing, input), existing === null);
      if (!apply) return makeUnchangedNode(input, existing);
      return await target.putNode(input);
    },
    async putRelation(input): Promise<AionisRelation> {
      const key = checkpointKey("relations", input);
      const existing = (await target.listRelations(input.scope)).find((relation) => relation.id === input.id) ?? null;
      const apply = await shouldApply("relations", key, input, stats.relations, existing !== null && relationMatchesInput(existing, input), existing === null);
      if (!apply) return makeUnchangedRelation(input);
      return await target.putRelation(input);
    },
    async recordFeedback(input): Promise<AionisFeedback> {
      const key = checkpointKey("feedback", input);
      const existing = (await target.listFeedback({ scope: input.scope, memoryId: input.memoryId }))
        .find((feedback) => feedback.id === input.id) ?? null;
      const apply = await shouldApply("feedback", key, input, stats.feedback, existing !== null && feedbackMatchesInput(existing, input), existing === null);
      if (!apply) return makeUnchangedFeedback(input);
      return await target.recordFeedback(input);
    },
    async recordDecision(input): Promise<AionisDecisionTrace> {
      const key = checkpointKey("decisions", input);
      const existing = (await target.listDecisions(input.scope)).find((decision) => decision.id === input.id) ?? null;
      const apply = await shouldApply("decisions", key, input, stats.decisions, existing !== null && decisionMatchesInput(existing, input), existing === null);
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

export async function runRuntimeLiveSidecarWatch(options: RuntimeLiveSidecarWatchOptions): Promise<RuntimeLiveSidecarWatchReport> {
  if (!Number.isInteger(options.iterations) || options.iterations < 1) {
    throw new Error("Runtime live sidecar watch iterations must be a positive integer");
  }
  if (!Number.isInteger(options.intervalMs) || options.intervalMs < 0) {
    throw new Error("Runtime live sidecar watch intervalMs must be a non-negative integer");
  }

  const sourcePath = resolve(options.sourcePath);
  const checkpointPath = resolve(options.checkpointPath);
  const lockPath = options.lockPath === null ? null : resolve(options.lockPath ?? `${checkpointPath}.lock`);
  const scope = options.scope?.trim() || null;
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const reports: RuntimeLiveSidecarReport[] = [];
  let lock: RuntimeLiveSidecarLock | null = null;
  try {
    if (lockPath) {
      lock = await acquireLock(lockPath, {
        run_id: runId,
        source_path: sourcePath,
        checkpoint_path: checkpointPath,
        scope,
        iterations: options.iterations,
        interval_ms: options.intervalMs,
        dry_run: Boolean(options.dryRun),
      });
    }

    for (let index = 0; index < options.iterations; index += 1) {
      reports.push(await runRuntimeLiveSidecarOnce({
        sourcePath,
        target: options.target,
        checkpointPath,
        scope: scope ?? undefined,
        limit: options.limit,
        dryRun: options.dryRun,
      }));
      if (index < options.iterations - 1 && options.intervalMs > 0) await sleep(options.intervalMs);
    }
  } finally {
    await lock?.release();
  }

  const applySummary = reports.reduce(
    (summary, report) => addApplySummary(summary, report.apply_summary),
    emptyApplySummary(),
  );
  return {
    contract_version: "aionis_runtime_live_sidecar_watch_report_v1",
    run_id: runId,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    source_path: sourcePath,
    scope,
    checkpoint_path: checkpointPath,
    lock_path: lockPath,
    dry_run: Boolean(options.dryRun),
    interval_ms: options.intervalMs,
    iterations_requested: options.iterations,
    iterations_completed: reports.length,
    reports,
    apply_summary: applySummary,
    warnings: reports.flatMap((report) => report.warnings),
  };
}
