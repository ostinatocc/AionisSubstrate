import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  openSqliteAionisSubstrate,
  runRuntimeLiveSidecarOnce,
} from "../../dist/index.js";

const scope = "repo-a";
const workspace = await mkdtemp(join(tmpdir(), "aionis-substrate-live-sidecar-"));

function createRuntimeLiteSource(path) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE lite_memory_nodes (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        client_id TEXT,
        type TEXT NOT NULL,
        tier TEXT NOT NULL,
        title TEXT,
        text_summary TEXT,
        slots_json TEXT NOT NULL,
        raw_ref TEXT,
        evidence_ref TEXT,
        embedding_vector_json TEXT,
        embedding_model TEXT,
        memory_lane TEXT NOT NULL,
        producer_agent_id TEXT,
        owner_agent_id TEXT,
        owner_team_id TEXT,
        embedding_status TEXT NOT NULL,
        embedding_last_error TEXT,
        salience REAL NOT NULL,
        importance REAL NOT NULL,
        confidence REAL NOT NULL,
        redaction_version INTEGER NOT NULL,
        commit_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  } finally {
    db.close();
  }
}

function insertRuntimeNode(path, row) {
  const db = new DatabaseSync(path);
  try {
    db.prepare(`
      INSERT INTO lite_memory_nodes (
        id, scope, client_id, type, tier, title, text_summary, slots_json, raw_ref, evidence_ref,
        embedding_vector_json, embedding_model, memory_lane, producer_agent_id, owner_agent_id,
        owner_team_id, embedding_status, embedding_last_error, salience, importance, confidence,
        redaction_version, commit_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      scope,
      `client-${row.id}`,
      row.type,
      row.tier,
      row.title,
      row.summary,
      JSON.stringify(row.slots),
      row.rawRef ?? null,
      row.evidenceRef ?? null,
      null,
      "demo-embedding",
      "execution",
      "agent-a",
      "agent-a",
      "team-a",
      "ready",
      null,
      0.8,
      0.85,
      row.confidence,
      1,
      "demo-commit",
      row.createdAt,
    );
  } finally {
    db.close();
  }
}

try {
  const runtimeSource = join(workspace, "runtime-lite.sqlite");
  const substrateTarget = join(workspace, "substrate.sqlite");
  const checkpoint = join(workspace, "runtime-live-checkpoint.json");
  createRuntimeLiteSource(runtimeSource);

  insertRuntimeNode(runtimeSource, {
    id: "current-route",
    type: "procedure",
    tier: "hot",
    title: "Current route",
    summary: "Use src/runtime.ts after verifier passed.",
    confidence: 0.95,
    createdAt: "2026-06-26T00:00:00.000Z",
    slots: {
      summary_kind: "workflow_anchor",
      contract_trust: "trusted",
      target_files: ["src/runtime.ts", "tests/runtime.test.ts"],
      execution_result_summary: { status: "passed" },
    },
  });

  insertRuntimeNode(runtimeSource, {
    id: "failed-branch",
    type: "procedure",
    tier: "hot",
    title: "Failed branch",
    summary: "The legacy src/legacy.ts path failed the verifier and should not steer the next turn.",
    confidence: 0.9,
    createdAt: "2026-06-26T00:01:00.000Z",
    slots: {
      summary_kind: "workflow_anchor",
      contract_trust: "rejected",
      target_files: ["src/legacy.ts"],
      execution_result_summary: { status: "failed" },
    },
  });

  insertRuntimeNode(runtimeSource, {
    id: "raw-trace",
    type: "trace_pointer",
    tier: "cold",
    title: "Raw terminal trace",
    summary: "Full terminal trace is retained as payload evidence but should only be rehydrated on demand.",
    rawRef: "file://trace.log",
    confidence: 0.88,
    createdAt: "2026-06-26T00:02:00.000Z",
    slots: {
      summary_kind: "raw_trace_pointer",
      target_files: ["src/runtime.ts"],
    },
  });

  const store = await openSqliteAionisSubstrate({ path: substrateTarget });
  try {
    const first = await runRuntimeLiveSidecarOnce({
      sourcePath: runtimeSource,
      target: store,
      checkpointPath: checkpoint,
      scope,
    });
    const second = await runRuntimeLiveSidecarOnce({
      sourcePath: runtimeSource,
      target: store,
      checkpointPath: checkpoint,
      scope,
    });

    const context = await store.previewContext({
      scope,
      query: "continue the current runtime implementation route",
      maxPerBucket: 8,
    });

    assert.equal(first.apply_summary.nodes.applied, 3);
    assert.equal(second.apply_summary.nodes.applied, 0);
    assert.deepEqual(context.use_now.map((node) => node.id), ["current-route"]);
    assert.deepEqual(context.do_not_use.map((node) => node.id), ["failed-branch"]);
    assert.deepEqual(context.rehydrate.map((node) => node.id), ["raw-trace"]);

    console.log(JSON.stringify({
      ok: true,
      runtime_source: runtimeSource,
      substrate_target: substrateTarget,
      first_sidecar_run: first.apply_summary.nodes,
      second_sidecar_run: second.apply_summary.nodes,
      governed_context: {
        use_now: context.use_now.map((node) => node.id),
        inspect_before_use: context.inspect_before_use.map((node) => node.id),
        do_not_use: context.do_not_use.map((node) => node.id),
        rehydrate: context.rehydrate.map((node) => node.id),
      },
    }, null, 2));
  } finally {
    await store.close();
  }
} finally {
  await rm(workspace, { recursive: true, force: true });
}
