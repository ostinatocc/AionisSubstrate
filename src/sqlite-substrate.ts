import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { applyAionisEvent, checksumAionisEvents, emptyReplayState } from "./event-log.ts";
import { searchMemoryNodes } from "./search.ts";
import { AIONIS_SUBSTRATE_SCHEMA_VERSION as CURRENT_SCHEMA_VERSION } from "./types.ts";
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

export type SqliteAionisSubstrateOptions = {
  path: string;
  now?: () => Date;
};

type SqliteMemoryNodeRow = {
  id: string;
  scope: string;
  kind: AionisMemoryNode["kind"];
  title: string | null;
  summary: string;
  lifecycle: AionisMemoryNode["lifecycle"];
  authority: AionisMemoryNode["authority"];
  confidence: number;
  target_files_json: string;
  payload_ref: string | null;
  agent_id: string | null;
  team_id: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
};

type SqliteRelationRow = {
  id: string;
  scope: string;
  kind: AionisRelation["kind"];
  source_id: string;
  target_id: string;
  confidence: number;
  reasons_json: string;
  metadata_json: string;
  created_at: string;
};

type SqliteFeedbackRow = {
  id: string;
  scope: string;
  memory_id: string;
  outcome: AionisFeedback["outcome"];
  strength: AionisFeedback["strength"];
  run_id: string | null;
  evidence_ref: string | null;
  created_at: string;
};

type SqliteDecisionRow = {
  id: string;
  scope: string;
  query: string | null;
  decisions_json: string;
  created_at: string;
};

type SqliteMetadataRow = {
  value: string;
};

type SqliteEventRow = {
  sequence: number;
  id: string;
  type: AionisEvent["type"];
  created_at: string;
  payload_json: string;
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

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function parseJsonArray(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function stringify(value: unknown): string {
  return JSON.stringify(value);
}

function rowToNode(row: SqliteMemoryNodeRow): AionisMemoryNode {
  return {
    id: row.id,
    scope: row.scope,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    lifecycle: row.lifecycle,
    authority: row.authority,
    confidence: row.confidence,
    targetFiles: parseJsonArray(row.target_files_json).filter((item): item is string => typeof item === "string"),
    payloadRef: row.payload_ref,
    agentId: row.agent_id,
    teamId: row.team_id,
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRelation(row: SqliteRelationRow): AionisRelation {
  return {
    id: row.id,
    scope: row.scope,
    kind: row.kind,
    sourceId: row.source_id,
    targetId: row.target_id,
    confidence: row.confidence,
    reasons: parseJsonArray(row.reasons_json).filter((item): item is string => typeof item === "string"),
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
  };
}

function rowToFeedback(row: SqliteFeedbackRow): AionisFeedback {
  return {
    id: row.id,
    scope: row.scope,
    memoryId: row.memory_id,
    outcome: row.outcome,
    strength: row.strength,
    runId: row.run_id,
    evidenceRef: row.evidence_ref,
    createdAt: row.created_at,
  };
}

function rowToDecision(row: SqliteDecisionRow): AionisDecisionTrace {
  return {
    id: row.id,
    scope: row.scope,
    query: row.query,
    decisions: parseJsonArray(row.decisions_json) as AionisAdmissionDecision[],
    createdAt: row.created_at,
  };
}

function rowToEvent(row: SqliteEventRow): AionisEvent {
  return {
    id: row.id,
    sequence: row.sequence,
    type: row.type,
    createdAt: row.created_at,
    payload: JSON.parse(row.payload_json),
  } as AionisEvent;
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

function reasonsFor(node: AionisMemoryNode, relations: AionisRelation[]): { action: AionisAdmissionAction; reasons: AionisDecisionReason[] } {
  const incoming = relations.filter((relation) => relation.scope === node.scope && relation.targetId === node.id);
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
      reasons: [{ code: "lifecycle_blocks_direct_use", detail: `lifecycle=${node.lifecycle}, authority=${node.authority}` }],
    };
  }

  if (node.lifecycle === "active" && (node.authority === "trusted" || node.authority === "verified")) {
    return {
      action: "use_now",
      reasons: [{ code: "active_authoritative_memory", detail: `lifecycle=${node.lifecycle}, authority=${node.authority}` }],
    };
  }

  return {
    action: "inspect_before_use",
    reasons: [{ code: "insufficient_authority", detail: `lifecycle=${node.lifecycle}, authority=${node.authority}` }],
  };
}

function readMetadataValue(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM substrate_metadata WHERE key = ?").get(key) as SqliteMetadataRow | undefined;
  return row?.value ?? null;
}

function writeMetadataValue(db: DatabaseSync, key: string, value: string): void {
  db.prepare(`
    INSERT INTO substrate_metadata (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function migrateSchema(db: DatabaseSync, migratedAt: string): void {
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS substrate_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const existingVersionRaw = readMetadataValue(db, "schema_version");
  const existingVersion = existingVersionRaw === null ? null : Number(existingVersionRaw);
  if (existingVersion !== null && (!Number.isInteger(existingVersion) || existingVersion < 1)) {
    throw new Error(`invalid Aionis Substrate schema version: ${existingVersionRaw}`);
  }
  if (existingVersion !== null && existingVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(`unsupported Aionis Substrate schema version ${existingVersion}; current runtime supports ${CURRENT_SCHEMA_VERSION}`);
  }

  const userVersion = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  if (userVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(`unsupported SQLite user_version ${userVersion}; current runtime supports ${CURRENT_SCHEMA_VERSION}`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS substrate_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_nodes (
      scope TEXT NOT NULL,
      id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT,
      summary TEXT NOT NULL,
      lifecycle TEXT NOT NULL,
      authority TEXT NOT NULL,
      confidence REAL NOT NULL,
      target_files_json TEXT NOT NULL,
      payload_ref TEXT,
      agent_id TEXT,
      team_id TEXT,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(scope, id)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_nodes_scope_updated ON memory_nodes(scope, updated_at DESC, id);
    CREATE INDEX IF NOT EXISTS idx_memory_nodes_scope_lifecycle ON memory_nodes(scope, lifecycle, authority);

    CREATE TABLE IF NOT EXISTS memory_relations (
      scope TEXT NOT NULL,
      id TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      confidence REAL NOT NULL,
      reasons_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(scope, id)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_relations_target ON memory_relations(scope, target_id, kind);
    CREATE INDEX IF NOT EXISTS idx_memory_relations_source ON memory_relations(scope, source_id, kind);

    CREATE TABLE IF NOT EXISTS memory_feedback (
      scope TEXT NOT NULL,
      id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      strength TEXT NOT NULL,
      run_id TEXT,
      evidence_ref TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY(scope, id)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_feedback_memory ON memory_feedback(scope, memory_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS decision_traces (
      scope TEXT NOT NULL,
      id TEXT NOT NULL,
      query TEXT,
      decisions_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(scope, id)
    );
    CREATE INDEX IF NOT EXISTS idx_decision_traces_scope_created ON decision_traces(scope, created_at DESC, id);
  `);

  if (existingVersion === null) {
    writeMetadataValue(db, "created_at", migratedAt);
  }
  writeMetadataValue(db, "adapter", "sqlite");
  writeMetadataValue(db, "schema_version", String(CURRENT_SCHEMA_VERSION));
  writeMetadataValue(db, "last_migrated_at", migratedAt);
  db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
}

export async function openSqliteAionisSubstrate(options: SqliteAionisSubstrateOptions): Promise<AionisSubstrate> {
  await mkdir(dirname(options.path), { recursive: true });
  const db = new DatabaseSync(options.path);
  const now = options.now ?? (() => new Date());
  let tail: Promise<unknown> = Promise.resolve();
  migrateSchema(db, now().toISOString());

  function isoNow(): string {
    return now().toISOString();
  }

  function enqueue<T>(fn: () => T): Promise<T> {
    const next = tail.then(fn, fn);
    tail = next.then(() => undefined, () => undefined);
    return next;
  }

  function transaction<T>(fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  function appendEvent(type: AionisEvent["type"], createdAt: string, payload: unknown): AionisEvent {
    const id = randomUUID();
    db.prepare("INSERT INTO substrate_events (id, type, created_at, payload_json) VALUES (?, ?, ?, ?)")
      .run(id, type, createdAt, stringify(payload));
    const sequence = Number((db.prepare("SELECT last_insert_rowid() AS sequence").get() as { sequence: number }).sequence);
    return { id, sequence, type, createdAt, payload } as AionisEvent;
  }

  function listEventsSync(): AionisEvent[] {
    return (db.prepare(`
      SELECT sequence, id, type, created_at, payload_json
      FROM substrate_events
      ORDER BY sequence ASC
    `).all() as SqliteEventRow[]).map(rowToEvent);
  }

  function listAllNodesSync(): AionisMemoryNode[] {
    return (db.prepare(`
      SELECT *
      FROM memory_nodes
      ORDER BY scope ASC, id ASC
    `).all() as SqliteMemoryNodeRow[]).map(rowToNode);
  }

  function listAllRelationsSync(): AionisRelation[] {
    return (db.prepare(`
      SELECT *
      FROM memory_relations
      ORDER BY scope ASC, id ASC
    `).all() as SqliteRelationRow[]).map(rowToRelation);
  }

  function listAllFeedbackSync(): AionisFeedback[] {
    return (db.prepare(`
      SELECT *
      FROM memory_feedback
      ORDER BY scope ASC, id ASC
    `).all() as SqliteFeedbackRow[]).map(rowToFeedback);
  }

  function listAllDecisionsSync(): AionisDecisionTrace[] {
    return (db.prepare(`
      SELECT *
      FROM decision_traces
      ORDER BY scope ASC, id ASC
    `).all() as SqliteDecisionRow[]).map(rowToDecision);
  }

  function getNodeSync(scope: string, id: string): AionisMemoryNode | null {
    const row = db.prepare("SELECT * FROM memory_nodes WHERE scope = ? AND id = ?").get(scope, id) as SqliteMemoryNodeRow | undefined;
    return row ? rowToNode(row) : null;
  }

  function insertNodeRow(node: AionisMemoryNode): void {
    db.prepare(`
      INSERT INTO memory_nodes (
        scope, id, kind, title, summary, lifecycle, authority, confidence, target_files_json,
        payload_ref, agent_id, team_id, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, id) DO UPDATE SET
        kind = excluded.kind,
        title = excluded.title,
        summary = excluded.summary,
        lifecycle = excluded.lifecycle,
        authority = excluded.authority,
        confidence = excluded.confidence,
        target_files_json = excluded.target_files_json,
        payload_ref = excluded.payload_ref,
        agent_id = excluded.agent_id,
        team_id = excluded.team_id,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      node.scope,
      node.id,
      node.kind,
      node.title ?? null,
      node.summary,
      node.lifecycle,
      node.authority,
      node.confidence,
      stringify(node.targetFiles ?? []),
      node.payloadRef ?? null,
      node.agentId ?? null,
      node.teamId ?? null,
      stringify(node.metadata ?? {}),
      node.createdAt,
      node.updatedAt,
    );
  }

  function insertRelationRow(relation: AionisRelation): void {
    db.prepare(`
      INSERT INTO memory_relations (
        scope, id, kind, source_id, target_id, confidence, reasons_json, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, id) DO UPDATE SET
        kind = excluded.kind,
        source_id = excluded.source_id,
        target_id = excluded.target_id,
        confidence = excluded.confidence,
        reasons_json = excluded.reasons_json,
        metadata_json = excluded.metadata_json
    `).run(
      relation.scope,
      relation.id,
      relation.kind,
      relation.sourceId,
      relation.targetId,
      relation.confidence,
      stringify(relation.reasons),
      stringify(relation.metadata ?? {}),
      relation.createdAt,
    );
  }

  function insertFeedbackRow(feedback: AionisFeedback): void {
    db.prepare(`
      INSERT INTO memory_feedback (
        scope, id, memory_id, outcome, strength, run_id, evidence_ref, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, id) DO UPDATE SET
        memory_id = excluded.memory_id,
        outcome = excluded.outcome,
        strength = excluded.strength,
        run_id = excluded.run_id,
        evidence_ref = excluded.evidence_ref
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

  function insertDecisionRow(trace: AionisDecisionTrace): void {
    db.prepare(`
      INSERT INTO decision_traces (scope, id, query, decisions_json, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(scope, id) DO UPDATE SET
        query = excluded.query,
        decisions_json = excluded.decisions_json
    `).run(trace.scope, trace.id, trace.query ?? null, stringify(trace.decisions), trace.createdAt);
  }

  return {
    async getStoreInfo() {
      return await enqueue(() => {
        const eventCount = Number((db.prepare("SELECT count(*) AS count FROM substrate_events").get() as { count: number }).count);
        const lastSequence = Number((db.prepare("SELECT coalesce(max(sequence), 0) AS sequence FROM substrate_events").get() as { sequence: number }).sequence);
        const schemaVersion = Number(readMetadataValue(db, "schema_version") ?? CURRENT_SCHEMA_VERSION);
        return {
          adapter: "sqlite",
          schemaVersion,
          lastSequence,
          eventCount,
        };
      });
    },

    async compact() {
      return await enqueue(() => transaction(() => {
        const beforeEvents = listEventsSync();
        const before = {
          eventCount: beforeEvents.length,
          lastSequence: Number((db.prepare("SELECT coalesce(max(sequence), 0) AS sequence FROM substrate_events").get() as { sequence: number }).sequence),
          eventsSha256: checksumAionisEvents(beforeEvents),
        };
        if (beforeEvents.length === 0) {
          return {
            adapter: "sqlite",
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
            coveredLastSequence: before.lastSequence,
            coveredEventsSha256: before.eventsSha256,
            state: {
              nodes: listAllNodesSync(),
              relations: listAllRelationsSync(),
              feedback: listAllFeedbackSync(),
              decisions: listAllDecisionsSync(),
            },
          },
        };
        applyAionisEvent(emptyReplayState(), checkpoint);

        db.exec(`
          DELETE FROM substrate_events;
          DELETE FROM sqlite_sequence WHERE name = 'substrate_events';
        `);
        db.prepare(`
          INSERT INTO substrate_events (sequence, id, type, created_at, payload_json)
          VALUES (?, ?, ?, ?, ?)
        `).run(checkpoint.sequence, checkpoint.id, checkpoint.type, checkpoint.createdAt, stringify(checkpoint.payload));
        writeMetadataValue(db, "last_compacted_at", checkpoint.createdAt);
        writeMetadataValue(db, "last_compacted_event_count", String(before.eventCount));
        writeMetadataValue(db, "last_compacted_last_sequence", String(before.lastSequence));
        writeMetadataValue(db, "last_compacted_events_sha256", before.eventsSha256);

        return {
          adapter: "sqlite",
          schemaVersion: CURRENT_SCHEMA_VERSION,
          compacted: true,
          before,
          after: {
            eventCount: 1,
            lastSequence: 1,
            checkpointEventId: checkpoint.id,
          },
        };
      }));
    },

    async putNode(input: AionisMemoryNodeInput): Promise<AionisMemoryNode> {
      return await enqueue(() => transaction(() => {
        const ts = isoNow();
        const id = requireNonEmpty(input.id ?? randomUUID(), "memory id");
        const existing = getNodeSync(input.scope, id);
        const createdAt = existing?.createdAt ?? input.createdAt ?? ts;
        const updatedAt = input.updatedAt ?? ts;
        const node: AionisMemoryNode = {
          id,
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
        appendEvent("memory.node.upsert", ts, node);
        insertNodeRow(node);
        return node;
      }));
    },

    async transitionLifecycle(input): Promise<AionisMemoryNode> {
      return await enqueue(() => transaction(() => {
        const ts = isoNow();
        const current = getNodeSync(input.scope, input.memoryId);
        if (!current) throw new Error(`cannot transition missing memory node: ${input.memoryId}`);
        const node: AionisMemoryNode = {
          ...current,
          lifecycle: input.lifecycle,
          authority: input.authority ?? current.authority,
          confidence: input.confidence === undefined ? current.confidence : clampConfidence(input.confidence),
          updatedAt: ts,
          metadata: {
            ...(current.metadata ?? {}),
            last_lifecycle_transition_reason: requireNonEmpty(input.reason, "reason"),
          },
        };
        appendEvent("memory.lifecycle.transition", ts, {
          scope: requireNonEmpty(input.scope, "scope"),
          memoryId: requireNonEmpty(input.memoryId, "memoryId"),
          lifecycle: input.lifecycle,
          authority: input.authority,
          confidence: input.confidence,
          reason: requireNonEmpty(input.reason, "reason"),
        });
        insertNodeRow(node);
        return node;
      }));
    },

    async putRelation(input: AionisRelationInput): Promise<AionisRelation> {
      return await enqueue(() => transaction(() => {
        const ts = isoNow();
        const scope = requireNonEmpty(input.scope, "scope");
        const sourceId = requireNonEmpty(input.sourceId, "sourceId");
        const targetId = requireNonEmpty(input.targetId, "targetId");
        if (!getNodeSync(scope, sourceId)) throw new Error(`cannot relate missing source memory node: ${sourceId}`);
        if (!getNodeSync(scope, targetId)) throw new Error(`cannot relate missing target memory node: ${targetId}`);
        const relation: AionisRelation = {
          id: requireNonEmpty(input.id ?? randomUUID(), "relation id"),
          scope,
          kind: input.kind,
          sourceId,
          targetId,
          confidence: clampConfidence(input.confidence ?? 0.7),
          reasons: normalizeStrings(input.reasons),
          metadata: input.metadata ?? {},
          createdAt: input.createdAt ?? ts,
        };
        appendEvent("memory.relation.upsert", ts, relation);
        insertRelationRow(relation);
        return relation;
      }));
    },

    async recordFeedback(input: AionisFeedbackInput): Promise<AionisFeedback> {
      return await enqueue(() => transaction(() => {
        const ts = isoNow();
        const scope = requireNonEmpty(input.scope, "scope");
        const memoryId = requireNonEmpty(input.memoryId, "memoryId");
        if (!getNodeSync(scope, memoryId)) throw new Error(`cannot record feedback for missing memory node: ${memoryId}`);
        const feedback: AionisFeedback = {
          id: requireNonEmpty(input.id ?? randomUUID(), "feedback id"),
          scope,
          memoryId,
          outcome: input.outcome,
          strength: input.strength,
          runId: input.runId ?? null,
          evidenceRef: input.evidenceRef ?? null,
          createdAt: input.createdAt ?? ts,
        };
        appendEvent("memory.feedback.recorded", ts, feedback);
        insertFeedbackRow(feedback);
        return feedback;
      }));
    },

    async recordDecision(input: AionisDecisionTraceInput): Promise<AionisDecisionTrace> {
      return await enqueue(() => transaction(() => {
        const trace: AionisDecisionTrace = {
          id: requireNonEmpty(input.id ?? randomUUID(), "decision trace id"),
          scope: requireNonEmpty(input.scope, "scope"),
          query: input.query ?? null,
          decisions: input.decisions,
          createdAt: input.createdAt ?? isoNow(),
        };
        appendEvent("memory.decision.recorded", trace.createdAt, trace);
        insertDecisionRow(trace);
        return trace;
      }));
    },

    async compileContext(input): Promise<AionisCompiledContext> {
      return await enqueue(() => transaction(() => {
        const maxPerBucket = input.maxPerBucket ?? Number.POSITIVE_INFINITY;
        const nodes = sortNodes((db.prepare("SELECT * FROM memory_nodes WHERE scope = ?").all(input.scope) as SqliteMemoryNodeRow[]).map(rowToNode));
        const relations = (db.prepare("SELECT * FROM memory_relations WHERE scope = ?").all(input.scope) as SqliteRelationRow[]).map(rowToRelation);
        const buckets: Record<AionisAdmissionAction, AionisMemoryNode[]> = {
          use_now: [],
          inspect_before_use: [],
          do_not_use: [],
          rehydrate: [],
        };
        const decisions: AionisAdmissionDecision[] = [];
        for (const node of nodes) {
          const decision = reasonsFor(node, relations);
          decisions.push({ memoryId: node.id, action: decision.action, reasons: decision.reasons });
          buckets[decision.action].push(node);
        }
        for (const action of Object.keys(buckets) as AionisAdmissionAction[]) {
          buckets[action] = buckets[action].slice(0, maxPerBucket);
        }
        const ts = isoNow();
        const trace: AionisDecisionTrace = {
          id: randomUUID(),
          scope: input.scope,
          query: input.query ?? null,
          decisions,
          createdAt: ts,
        };
        appendEvent("memory.decision.recorded", ts, trace);
        insertDecisionRow(trace);
        return {
          scope: input.scope,
          use_now: buckets.use_now,
          inspect_before_use: buckets.inspect_before_use,
          do_not_use: buckets.do_not_use,
          rehydrate: buckets.rehydrate,
          decision_trace: trace,
        };
      }));
    },

    async getNode(scope: string, id: string): Promise<AionisMemoryNode | null> {
      return await enqueue(() => getNodeSync(scope, id));
    },

    async listNodes(scope: string): Promise<AionisMemoryNode[]> {
      return await enqueue(() => sortNodes((db.prepare("SELECT * FROM memory_nodes WHERE scope = ?").all(scope) as SqliteMemoryNodeRow[]).map(rowToNode)));
    },

    async searchNodes(input) {
      return await enqueue(() => {
        const nodes = (db.prepare("SELECT * FROM memory_nodes WHERE scope = ?").all(input.scope) as SqliteMemoryNodeRow[]).map(rowToNode);
        return searchMemoryNodes(nodes, input);
      });
    },

    async listRelations(scope: string): Promise<AionisRelation[]> {
      return await enqueue(() => (db.prepare("SELECT * FROM memory_relations WHERE scope = ?").all(scope) as SqliteRelationRow[]).map(rowToRelation));
    },

    async listEvents(): Promise<AionisEvent[]> {
      return await enqueue(() => listEventsSync());
    },

    async close(): Promise<void> {
      await tail.catch(() => undefined);
      db.close();
    },
  };
}
