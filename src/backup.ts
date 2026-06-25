import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openSqliteAionisSubstrate } from "./sqlite-substrate.ts";
import {
  AIONIS_SUBSTRATE_SCHEMA_VERSION,
  type AionisDecisionTrace,
  type AionisEvent,
  type AionisFeedback,
  type AionisMemoryNode,
  type AionisRelation,
  type AionisSubstrate,
  type AionisSubstrateSnapshot,
  type AionisSubstrateStoreInfo,
} from "./types.ts";

export const AIONIS_SUBSTRATE_BACKUP_FORMAT = "aionis_substrate_backup";
export const AIONIS_SUBSTRATE_BACKUP_VERSION = 1;

export type AionisSubstrateBackup = {
  format: typeof AIONIS_SUBSTRATE_BACKUP_FORMAT;
  backupVersion: typeof AIONIS_SUBSTRATE_BACKUP_VERSION;
  schemaVersion: number;
  createdAt: string;
  source: AionisSubstrateStoreInfo;
  eventCount: number;
  lastSequence: number;
  checksum: {
    algorithm: "sha256";
    eventsSha256: string;
  };
  events: AionisEvent[];
};

export type AionisSubstrateBackupIntegrityReport = {
  ok: boolean;
  errors: string[];
  schemaVersion: number | null;
  eventCount: number;
  lastSequence: number;
  eventsSha256: string | null;
  snapshot: AionisSubstrateSnapshot | null;
};

export type RestoreAionisSubstrateBackupOptions = {
  overwrite?: boolean;
};

type ReplayState = {
  lastSequence: number;
  nodes: Map<string, AionisMemoryNode>;
  relations: Map<string, AionisRelation>;
  feedback: Map<string, AionisFeedback>;
  decisions: Map<string, AionisDecisionTrace>;
  events: AionisEvent[];
};

function key(scope: string, id: string): string {
  return `${scope}\u0000${id}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([name, item]) => `${JSON.stringify(name)}:${stableStringify(item)}`).join(",")}}`;
}

function checksumEvents(events: AionisEvent[]): string {
  return createHash("sha256").update(stableStringify(events)).digest("hex");
}

function emptyState(): ReplayState {
  return {
    lastSequence: 0,
    nodes: new Map(),
    relations: new Map(),
    feedback: new Map(),
    decisions: new Map(),
    events: [],
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

function applyEvent(state: ReplayState, event: AionisEvent): void {
  validateEventShape(event);
  const expectedSequence = state.lastSequence + 1;
  if (event.sequence !== expectedSequence) {
    throw new Error(`event sequence gap at ${event.sequence}; expected ${expectedSequence}`);
  }

  if (state.events.some((item) => item.id === event.id)) {
    throw new Error(`duplicate event id: ${event.id}`);
  }

  if (event.type === "memory.node.upsert") {
    const node = event.payload;
    state.nodes.set(key(node.scope, node.id), node);
  } else if (event.type === "memory.lifecycle.transition") {
    const nodeKey = key(event.payload.scope, event.payload.memoryId);
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
    if (!state.nodes.has(key(relation.scope, relation.sourceId))) {
      throw new Error(`cannot relate missing source memory node: ${relation.sourceId}`);
    }
    if (!state.nodes.has(key(relation.scope, relation.targetId))) {
      throw new Error(`cannot relate missing target memory node: ${relation.targetId}`);
    }
    state.relations.set(key(relation.scope, relation.id), relation);
  } else if (event.type === "memory.feedback.recorded") {
    const feedback = event.payload;
    if (!state.nodes.has(key(feedback.scope, feedback.memoryId))) {
      throw new Error(`cannot record feedback for missing memory node: ${feedback.memoryId}`);
    }
    state.feedback.set(key(feedback.scope, feedback.id), feedback);
  } else if (event.type === "memory.decision.recorded") {
    const decision = event.payload;
    state.decisions.set(key(decision.scope, decision.id), decision);
  } else {
    throw new Error(`unsupported event type: ${(event as { type?: string }).type}`);
  }

  state.lastSequence = event.sequence;
  state.events.push(event);
}

function replayEvents(events: AionisEvent[]): ReplayState {
  const state = emptyState();
  for (const event of events) applyEvent(state, event);
  return state;
}

function snapshotFromReplay(state: ReplayState): AionisSubstrateSnapshot {
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

function assertValidBackup(backup: AionisSubstrateBackup): AionisSubstrateSnapshot {
  const report = verifyAionisSubstrateBackup(backup);
  if (!report.ok) throw new Error(`invalid Aionis Substrate backup: ${report.errors.join("; ")}`);
  return report.snapshot!;
}

export async function exportAionisSubstrateBackup(
  store: AionisSubstrate,
  options: { createdAt?: string } = {},
): Promise<AionisSubstrateBackup> {
  const [source, events] = await Promise.all([store.getStoreInfo(), store.listEvents()]);
  const state = replayEvents(events);
  const eventsSha256 = checksumEvents(events);
  return {
    format: AIONIS_SUBSTRATE_BACKUP_FORMAT,
    backupVersion: AIONIS_SUBSTRATE_BACKUP_VERSION,
    schemaVersion: AIONIS_SUBSTRATE_SCHEMA_VERSION,
    createdAt: options.createdAt ?? new Date().toISOString(),
    source,
    eventCount: events.length,
    lastSequence: state.lastSequence,
    checksum: {
      algorithm: "sha256",
      eventsSha256,
    },
    events,
  };
}

export function verifyAionisSubstrateBackup(backup: AionisSubstrateBackup): AionisSubstrateBackupIntegrityReport {
  const errors: string[] = [];
  let snapshot: AionisSubstrateSnapshot | null = null;
  let eventsSha256: string | null = null;
  let lastSequence = 0;

  if (backup.format !== AIONIS_SUBSTRATE_BACKUP_FORMAT) errors.push(`unsupported backup format: ${String(backup.format)}`);
  if (backup.backupVersion !== AIONIS_SUBSTRATE_BACKUP_VERSION) errors.push(`unsupported backup version: ${String(backup.backupVersion)}`);
  if (backup.schemaVersion !== AIONIS_SUBSTRATE_SCHEMA_VERSION) {
    errors.push(`unsupported schema version: ${String(backup.schemaVersion)}`);
  }
  if (!Array.isArray(backup.events)) errors.push("events must be an array");

  if (Array.isArray(backup.events)) {
    try {
      const state = replayEvents(backup.events);
      snapshot = snapshotFromReplay(state);
      lastSequence = state.lastSequence;
      eventsSha256 = checksumEvents(backup.events);
      if (backup.eventCount !== backup.events.length) {
        errors.push(`eventCount mismatch: header=${backup.eventCount}, actual=${backup.events.length}`);
      }
      if (backup.lastSequence !== state.lastSequence) {
        errors.push(`lastSequence mismatch: header=${backup.lastSequence}, actual=${state.lastSequence}`);
      }
      if (backup.checksum?.algorithm !== "sha256") {
        errors.push(`unsupported checksum algorithm: ${String(backup.checksum?.algorithm)}`);
      }
      if (backup.checksum?.eventsSha256 !== eventsSha256) {
        errors.push("eventsSha256 mismatch");
      }
    } catch (err) {
      errors.push((err as Error).message);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    schemaVersion: typeof backup.schemaVersion === "number" ? backup.schemaVersion : null,
    eventCount: Array.isArray(backup.events) ? backup.events.length : 0,
    lastSequence,
    eventsSha256,
    snapshot,
  };
}

export async function writeAionisSubstrateBackupFile(path: string, backup: AionisSubstrateBackup): Promise<void> {
  assertValidBackup(backup);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(backup, null, 2)}\n`, "utf8");
}

export async function readAionisSubstrateBackupFile(path: string): Promise<AionisSubstrateBackup> {
  return JSON.parse(await readFile(path, "utf8")) as AionisSubstrateBackup;
}

export async function restoreAionisSubstrateBackupToFile(
  backup: AionisSubstrateBackup,
  dir: string,
  options: RestoreAionisSubstrateBackupOptions = {},
): Promise<AionisSubstrateSnapshot> {
  const snapshot = assertValidBackup(backup);
  const eventsPath = join(dir, "events.jsonl");
  const snapshotPath = join(dir, "snapshot.json");
  if (options.overwrite) {
    await rm(dir, { recursive: true, force: true });
  } else {
    await assertFileRestoreTargetEmpty(eventsPath, snapshotPath);
  }
  await mkdir(dir, { recursive: true });
  await writeFile(eventsPath, backup.events.map((event) => JSON.stringify(event)).join("\n") + (backup.events.length > 0 ? "\n" : ""), "utf8");
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return snapshot;
}

export async function restoreAionisSubstrateBackupToSqlite(
  backup: AionisSubstrateBackup,
  path: string,
  options: RestoreAionisSubstrateBackupOptions = {},
): Promise<AionisSubstrateSnapshot> {
  const snapshot = assertValidBackup(backup);
  if (options.overwrite) {
    await rm(path, { force: true });
    await rm(`${path}-wal`, { force: true });
    await rm(`${path}-shm`, { force: true });
  } else {
    await assertSqliteRestoreTargetEmpty(path);
  }

  const store = await openSqliteAionisSubstrate({ path });
  await store.close();

  const db = new DatabaseSync(path);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      DELETE FROM decision_traces;
      DELETE FROM memory_feedback;
      DELETE FROM memory_relations;
      DELETE FROM memory_nodes;
      DELETE FROM substrate_events;
    `);

    for (const event of backup.events) {
      db.prepare("INSERT INTO substrate_events (sequence, id, type, created_at, payload_json) VALUES (?, ?, ?, ?, ?)")
        .run(event.sequence, event.id, event.type, event.createdAt, JSON.stringify(event.payload));
    }
    for (const node of snapshot.nodes) insertSqliteNodeRow(db, node);
    for (const relation of snapshot.relations) insertSqliteRelationRow(db, relation);
    for (const feedback of snapshot.feedback) insertSqliteFeedbackRow(db, feedback);
    for (const decision of snapshot.decisions) insertSqliteDecisionRow(db, decision);

    db.prepare(`
      INSERT INTO substrate_metadata (key, value)
      VALUES ('last_restored_at', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(new Date().toISOString());
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.close();
  }

  return snapshot;
}

async function assertFileRestoreTargetEmpty(eventsPath: string, snapshotPath: string): Promise<void> {
  const existing = await Promise.all([fileExists(eventsPath), fileExists(snapshotPath)]);
  if (existing.some(Boolean)) throw new Error("restore target file store is not empty; pass overwrite=true to replace it");
}

async function assertSqliteRestoreTargetEmpty(path: string): Promise<void> {
  if (await fileExists(path)) throw new Error("restore target SQLite store already exists; pass overwrite=true to replace it");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function insertSqliteNodeRow(db: DatabaseSync, node: AionisMemoryNode): void {
  db.prepare(`
    INSERT INTO memory_nodes (
      scope, id, kind, title, summary, lifecycle, authority, confidence, target_files_json,
      payload_ref, agent_id, team_id, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    node.scope,
    node.id,
    node.kind,
    node.title ?? null,
    node.summary,
    node.lifecycle,
    node.authority,
    node.confidence,
    JSON.stringify(node.targetFiles ?? []),
    node.payloadRef ?? null,
    node.agentId ?? null,
    node.teamId ?? null,
    JSON.stringify(node.metadata ?? {}),
    node.createdAt,
    node.updatedAt,
  );
}

function insertSqliteRelationRow(db: DatabaseSync, relation: AionisRelation): void {
  db.prepare(`
    INSERT INTO memory_relations (
      scope, id, kind, source_id, target_id, confidence, reasons_json, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    relation.scope,
    relation.id,
    relation.kind,
    relation.sourceId,
    relation.targetId,
    relation.confidence,
    JSON.stringify(relation.reasons),
    JSON.stringify(relation.metadata ?? {}),
    relation.createdAt,
  );
}

function insertSqliteFeedbackRow(db: DatabaseSync, feedback: AionisFeedback): void {
  db.prepare(`
    INSERT INTO memory_feedback (
      scope, id, memory_id, outcome, strength, run_id, evidence_ref, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    feedback.scope,
    feedback.id,
    feedback.memoryId,
    feedback.outcome,
    feedback.strength,
    feedback.runId ?? null,
    feedback.evidenceRef ?? null,
    feedback.createdAt,
  );
}

function insertSqliteDecisionRow(db: DatabaseSync, trace: AionisDecisionTrace): void {
  db.prepare(`
    INSERT INTO decision_traces (scope, id, query, decisions_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(trace.scope, trace.id, trace.query ?? null, JSON.stringify(trace.decisions), trace.createdAt);
}
