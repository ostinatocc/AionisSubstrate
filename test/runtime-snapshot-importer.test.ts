import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { importRuntimeLiteSnapshot, openSqliteAionisSubstrate } from "../src/index.ts";

async function withSqlitePair<T>(fn: (paths: { source: string; target: string }) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "aionis-runtime-snapshot-import-"));
  try {
    return await fn({
      source: join(dir, "runtime-lite.sqlite"),
      target: join(dir, "substrate.sqlite"),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function createRuntimeLiteFixture(path: string): void {
  const db = new DatabaseSync(path);
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

    CREATE TABLE lite_memory_execution_native_index (
      scope TEXT NOT NULL,
      node_id TEXT NOT NULL,
      execution_kind TEXT,
      anchor_kind TEXT,
      pattern_state TEXT,
      task_signature TEXT,
      task_family TEXT,
      error_signature TEXT,
      workflow_signature TEXT,
      pattern_signature TEXT,
      repo_signature TEXT,
      file_cluster TEXT,
      target_files_text TEXT,
      tool_chain_signature TEXT,
      failure_mode TEXT,
      verification_signature TEXT,
      acceptance_check_signature TEXT,
      compression_layer TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(scope, node_id)
    );

    CREATE TABLE lite_memory_edges (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      type TEXT NOT NULL,
      src_id TEXT NOT NULL,
      dst_id TEXT NOT NULL,
      weight REAL NOT NULL,
      confidence REAL NOT NULL,
      decay_rate REAL NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      commit_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(scope, type, src_id, dst_id)
    );

    CREATE TABLE lite_memory_rule_feedback (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      rule_node_id TEXT NOT NULL,
      run_id TEXT,
      outcome TEXT NOT NULL,
      note TEXT,
      source TEXT NOT NULL,
      decision_id TEXT,
      commit_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE lite_memory_execution_decisions (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      decision_kind TEXT NOT NULL,
      run_id TEXT,
      selected_tool TEXT,
      candidates_json TEXT NOT NULL,
      context_sha256 TEXT NOT NULL,
      policy_sha256 TEXT NOT NULL,
      source_rule_ids_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      commit_id TEXT,
      created_at TEXT NOT NULL
    );
  `);

  const insertNode = db.prepare(`
    INSERT INTO lite_memory_nodes (
      id, scope, client_id, type, tier, title, text_summary, slots_json, raw_ref, evidence_ref,
      embedding_vector_json, embedding_model, memory_lane, producer_agent_id, owner_agent_id,
      owner_team_id, embedding_status, embedding_last_error, salience, importance, confidence,
      redaction_version, commit_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertNode.run(
    "runtime-current",
    "repo-a",
    "client-current",
    "procedure",
    "hot",
    "Current route",
    "Use src/runtime.ts as the validated current route.",
    JSON.stringify({
      summary_kind: "workflow_anchor",
      execution_native_v1: {
        summary_kind: "workflow_anchor",
        execution_kind: "workflow_anchor",
        contract_trust: "trusted",
        target_files: ["src/runtime.ts"],
      },
    }),
    null,
    null,
    null,
    "fixture-embedding",
    "shared",
    "agent-writer",
    "agent-owner",
    "team-a",
    "ready",
    null,
    0.9,
    0.8,
    0.92,
    1,
    "commit-1",
    "2026-06-01T00:00:00.000Z",
  );

  insertNode.run(
    "runtime-old",
    "repo-a",
    "client-old",
    "procedure",
    "hot",
    "Old route",
    "Use src/legacy.ts as the old route.",
    JSON.stringify({
      summary_kind: "workflow_anchor",
      execution_native_v1: {
        summary_kind: "workflow_anchor",
        execution_kind: "workflow_anchor",
        contract_trust: "trusted",
        target_files: ["src/legacy.ts"],
      },
    }),
    null,
    null,
    null,
    "fixture-embedding",
    "shared",
    "agent-writer",
    "agent-owner",
    "team-a",
    "ready",
    null,
    0.7,
    0.7,
    0.82,
    1,
    "commit-1",
    "2026-05-30T00:00:00.000Z",
  );

  insertNode.run(
    "runtime-candidate",
    "repo-a",
    "client-candidate",
    "concept",
    "warm",
    "Candidate note",
    "Reviewer mentioned a possible fallback, but no outcome was attributed.",
    JSON.stringify({ summary_kind: "note", target_files: ["src/runtime.ts"] }),
    null,
    null,
    null,
    "fixture-embedding",
    "shared",
    "agent-writer",
    "agent-owner",
    "team-a",
    "ready",
    null,
    0.5,
    0.4,
    0.55,
    1,
    "commit-1",
    "2026-06-02T00:00:00.000Z",
  );

  insertNode.run(
    "runtime-trace",
    "repo-a",
    "client-trace",
    "event",
    "archive",
    "Raw trace",
    "Full terminal trace from the prior run.",
    JSON.stringify({ summary_kind: "raw_trace", target_files: ["src/runtime.ts"] }),
    "file://runtime/traces/run-1.log",
    null,
    null,
    "fixture-embedding",
    "shared",
    "agent-writer",
    "agent-owner",
    "team-a",
    "ready",
    null,
    0.4,
    0.4,
    0.8,
    1,
    "commit-1",
    "2026-06-02T01:00:00.000Z",
  );

  insertNode.run(
    "other-scope-current",
    "repo-b",
    "client-other",
    "procedure",
    "hot",
    "Other scope",
    "Other scope current route.",
    JSON.stringify({ summary_kind: "workflow_anchor", contract_trust: "trusted" }),
    null,
    null,
    null,
    "fixture-embedding",
    "shared",
    "agent-writer",
    "agent-owner",
    "team-b",
    "ready",
    null,
    0.7,
    0.7,
    0.9,
    1,
    "commit-1",
    "2026-06-02T02:00:00.000Z",
  );

  db.prepare(`
    INSERT INTO lite_memory_execution_native_index (
      scope, node_id, execution_kind, anchor_kind, pattern_state, task_signature, task_family,
      error_signature, workflow_signature, pattern_signature, repo_signature, file_cluster,
      target_files_text, tool_chain_signature, failure_mode, verification_signature,
      acceptance_check_signature, compression_layer, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "repo-a",
    "runtime-current",
    "workflow_anchor",
    "workflow",
    "active",
    "task-a",
    "runtime",
    null,
    "workflow-a",
    "pattern-a",
    "repo-a",
    "src/runtime.ts",
    "src/runtime.ts,tests/runtime.test.ts",
    "test",
    null,
    "passed",
    "npm test",
    "workflow",
    "2026-06-01T00:00:00.000Z",
    "2026-06-03T00:00:00.000Z",
  );

  db.prepare(`
    INSERT INTO lite_memory_edges (
      id, scope, type, src_id, dst_id, weight, confidence, decay_rate, metadata_json, commit_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "edge-current-supersedes-old",
    "repo-a",
    "supersedes",
    "runtime-current",
    "runtime-old",
    0.9,
    0.88,
    0,
    JSON.stringify({ reason: "newer verifier evidence" }),
    "commit-2",
    "2026-06-03T00:00:00.000Z",
  );

  db.prepare(`
    INSERT INTO lite_memory_rule_feedback (
      id, scope, rule_node_id, run_id, outcome, note, source, decision_id, commit_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "feedback-current-pass",
    "repo-a",
    "runtime-current",
    "run-1",
    "passed",
    "verifier passed",
    "product_facade",
    "decision-1",
    "commit-3",
    "2026-06-03T01:00:00.000Z",
  );

  db.prepare(`
    INSERT INTO lite_memory_execution_decisions (
      id, scope, decision_kind, run_id, selected_tool, candidates_json, context_sha256,
      policy_sha256, source_rule_ids_json, metadata_json, commit_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "decision-1",
    "repo-a",
    "tool_selection",
    "run-1",
    "npm test",
    JSON.stringify(["npm test", "node --test"]),
    "ctx-sha",
    "policy-sha",
    JSON.stringify(["runtime-current", "runtime-missing"]),
    JSON.stringify({ reason: "selected verifier" }),
    "commit-3",
    "2026-06-03T01:10:00.000Z",
  );

  db.close();
}

function insertRuntimeProductOutcomeRows(path: string): void {
  const db = new DatabaseSync(path);
  const insertNode = db.prepare(`
    INSERT INTO lite_memory_nodes (
      id, scope, client_id, type, tier, title, text_summary, slots_json, raw_ref, evidence_ref,
      embedding_vector_json, embedding_model, memory_lane, producer_agent_id, owner_agent_id,
      owner_team_id, embedding_status, embedding_last_error, salience, importance, confidence,
      redaction_version, commit_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertNode.run(
    "runtime-passed-advisory",
    "repo-a",
    "client-passed-advisory",
    "procedure",
    "hot",
    "Accepted current runtime route",
    "Current route: continue src/runtime/current-route.ts; verifier passed.",
    JSON.stringify({
      summary_kind: "workflow_anchor",
      memory_kind: "execution_workflow",
      execution_result_summary: { status: "passed" },
      execution_observation_v1: {
        outcome: "succeeded",
        execution_outcome_role: "passed_solution",
      },
      execution_native_v1: {
        summary_kind: "workflow_anchor",
        execution_outcome_role: "passed_solution",
        contract_trust: "advisory",
        target_files: ["src/runtime/current-route.ts"],
      },
      execution_contract_v1: {
        contract_trust: "advisory",
        target_files: ["src/runtime/current-route.ts"],
      },
    }),
    null,
    null,
    null,
    "fixture-embedding",
    "shared",
    "agent-writer",
    "agent-owner",
    "team-a",
    "ready",
    null,
    0.9,
    0.9,
    0.96,
    1,
    "commit-product",
    "2026-06-04T00:00:00.000Z",
  );

  insertNode.run(
    "runtime-failed-advisory",
    "repo-a",
    "client-failed-advisory",
    "procedure",
    "hot",
    "Rejected legacy route",
    "Failed branch: src/runtime/failed-legacy-route.ts failed verifier and must not be direct-use context.",
    JSON.stringify({
      summary_kind: "workflow_anchor",
      memory_kind: "execution_workflow",
      verification: { passed: false },
      execution_result_summary: { status: "failed" },
      execution_observation_v1: {
        outcome: "failed",
        execution_outcome_role: "failed_branch",
      },
      execution_native_v1: {
        summary_kind: "workflow_anchor",
        execution_outcome_role: "failed_branch",
        contract_trust: "advisory",
        target_files: ["src/runtime/failed-legacy-route.ts"],
      },
      execution_contract_v1: {
        contract_trust: "advisory",
        target_files: ["src/runtime/failed-legacy-route.ts"],
      },
    }),
    "trace://repo-a/failed/raw",
    "evidence://repo-a/failed-route",
    null,
    "fixture-embedding",
    "shared",
    "agent-writer",
    "agent-owner",
    "team-a",
    "ready",
    null,
    0.6,
    0.7,
    0.31,
    1,
    "commit-product",
    "2026-06-04T00:01:00.000Z",
  );

  insertNode.run(
    "runtime-guide-ledger",
    "repo-a",
    "client-guide-ledger",
    "evidence",
    "archive",
    "Guide exposure ledger",
    "Guide exposure ledger for audit only.",
    JSON.stringify({
      summary_kind: "guide_exposure_ledger",
      not_agent_facing: true,
      guide_exposure_v1: {
        not_agent_facing: true,
        use_now_memory_ids: ["runtime-passed-advisory"],
        do_not_use_memory_ids: ["runtime-failed-advisory"],
      },
      semantic_forgetting_v1: { lifecycle_state: "archived" },
    }),
    null,
    null,
    null,
    "fixture-embedding",
    "shared",
    "agent-writer",
    "agent-owner",
    "team-a",
    "ready",
    null,
    0.4,
    0.4,
    1,
    1,
    "commit-product",
    "2026-06-04T00:02:00.000Z",
  );
  db.close();
}

test("imports Runtime Lite snapshot into Substrate without mutating source SQLite", async () => {
  await withSqlitePair(async ({ source, target }) => {
    createRuntimeLiteFixture(source);
    const store = await openSqliteAionisSubstrate({ path: target });
    const summary = await importRuntimeLiteSnapshot({ sourcePath: source, target: store, scope: "repo-a" });

    assert.equal(summary.nodesRead, 4);
    assert.equal(summary.nodesImported, 4);
    assert.equal(summary.relationsImported, 1);
    assert.equal(summary.feedbackImported, 1);
    assert.equal(summary.decisionsImported, 1);
    assert.deepEqual(summary.scopes, ["repo-a"]);

    const context = await store.compileContext({ scope: "repo-a" });
    assert.deepEqual(context.use_now.map((node) => node.id), ["runtime-current"]);
    assert.deepEqual(context.inspect_before_use.map((node) => node.id), ["runtime-candidate"]);
    assert.deepEqual(context.do_not_use.map((node) => node.id), ["runtime-old"]);
    assert.deepEqual(context.rehydrate.map((node) => node.id), ["runtime-trace"]);

    const current = await store.getNode("repo-a", "runtime-current");
    assert.equal(current?.createdAt, "2026-06-01T00:00:00.000Z");
    assert.equal(current?.updatedAt, "2026-06-03T00:00:00.000Z");
    assert.deepEqual(current?.targetFiles, ["src/runtime.ts", "tests/runtime.test.ts"]);
    assert.equal(current?.metadata?.imported_from, "aionis_runtime_lite_snapshot");

    const events = await store.listEvents();
    assert.ok(events.some((event) => event.type === "memory.feedback.recorded" && event.payload.id === "feedback-current-pass"));
    assert.ok(events.some((event) => event.type === "memory.decision.recorded" && event.payload.id === "decision-1"));
    await store.close();

    const sourceDb = new DatabaseSync(source, { readOnly: true });
    const substrateTable = sourceDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_nodes'").get();
    const sourceNodeCount = sourceDb.prepare("SELECT count(*) AS count FROM lite_memory_nodes").get() as { count: number };
    sourceDb.close();
    assert.equal(substrateTable, undefined);
    assert.equal(sourceNodeCount.count, 5);
  });
});

test("maps Runtime product execution outcomes and skips audit-only ledgers", async () => {
  await withSqlitePair(async ({ source, target }) => {
    createRuntimeLiteFixture(source);
    insertRuntimeProductOutcomeRows(source);
    const store = await openSqliteAionisSubstrate({ path: target });
    const summary = await importRuntimeLiteSnapshot({ sourcePath: source, target: store, scope: "repo-a" });

    assert.equal(summary.nodesRead, 7);
    assert.equal(summary.nodesImported, 6);
    assert.equal(summary.nodesSkipped, 1);
    assert.ok(summary.warnings.some((warning) => warning.includes("runtime-guide-ledger") && warning.includes("not_agent_facing")));

    const context = await store.compileContext({ scope: "repo-a" });
    assert.ok(context.use_now.some((node) => node.id === "runtime-passed-advisory"));
    assert.ok(context.do_not_use.some((node) => node.id === "runtime-failed-advisory"));
    assert.ok(![
      ...context.use_now,
      ...context.inspect_before_use,
      ...context.do_not_use,
      ...context.rehydrate,
    ].some((node) => node.id === "runtime-guide-ledger"));

    const passed = await store.getNode("repo-a", "runtime-passed-advisory");
    assert.equal(passed?.lifecycle, "active");
    assert.equal(passed?.authority, "trusted");
    const failed = await store.getNode("repo-a", "runtime-failed-advisory");
    assert.equal(failed?.lifecycle, "blocked");
    assert.equal(failed?.authority, "rejected");
    await store.close();
  });
});

test("scope filter keeps imported snapshot local to the requested Runtime scope", async () => {
  await withSqlitePair(async ({ source, target }) => {
    createRuntimeLiteFixture(source);
    const store = await openSqliteAionisSubstrate({ path: target });
    const summary = await importRuntimeLiteSnapshot({ sourcePath: source, target: store, scope: "repo-b" });

    assert.equal(summary.nodesRead, 1);
    assert.equal(summary.nodesImported, 1);
    assert.deepEqual(summary.scopes, ["repo-b"]);
    assert.deepEqual((await store.listNodes("repo-a")).map((node) => node.id), []);
    assert.deepEqual((await store.compileContext({ scope: "repo-b" })).use_now.map((node) => node.id), ["other-scope-current"]);
    await store.close();
  });
});
