import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runRuntimeSnapshotCorpus } from "../src/index.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "aionis-runtime-corpus-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function createRuntimeLiteCorpusFixture(path: string): void {
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
  `);
  const insertNode = db.prepare(`
    INSERT INTO lite_memory_nodes (
      id, scope, client_id, type, tier, title, text_summary, slots_json, raw_ref, evidence_ref,
      embedding_vector_json, embedding_model, memory_lane, producer_agent_id, owner_agent_id,
      owner_team_id, embedding_status, embedding_last_error, salience, importance, confidence,
      redaction_version, commit_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const base = [
    null,
    null,
    "fixture-embedding",
    "shared",
    "agent-writer",
    "agent-owner",
    "team-a",
    "ready",
    null,
    0.8,
    0.8,
    0.9,
    1,
    "commit-1",
  ] as const;

  insertNode.run(
    "alpha-current",
    "repo-alpha",
    "client-current",
    "procedure",
    "hot",
    "Current route",
    "Use src/runtime.ts as the current route.",
    JSON.stringify({ summary_kind: "workflow_anchor", contract_trust: "trusted", target_files: ["src/runtime.ts"] }),
    null,
    ...base,
    "2026-06-01T00:00:00.000Z",
  );
  insertNode.run(
    "alpha-note",
    "repo-alpha",
    "client-note",
    "concept",
    "warm",
    "Candidate note",
    "Reviewer mentioned a possible fallback, but no outcome was attributed.",
    JSON.stringify({ summary_kind: "note", target_files: ["src/runtime.ts"] }),
    null,
    ...base,
    "2026-06-02T00:00:00.000Z",
  );
  insertNode.run(
    "alpha-trace",
    "repo-alpha",
    "client-trace",
    "event",
    "archive",
    "Raw trace",
    "Full terminal trace from the prior run.",
    JSON.stringify({ summary_kind: "raw_trace", target_files: ["src/runtime.ts"] }),
    "file://runtime/traces/run-1.log",
    ...base,
    "2026-06-03T00:00:00.000Z",
  );
  insertNode.run(
    "beta-current",
    "repo-beta",
    "client-beta",
    "procedure",
    "hot",
    "Other current route",
    "Use src/other.ts as the current route.",
    JSON.stringify({ summary_kind: "workflow_anchor", contract_trust: "trusted", target_files: ["src/other.ts"] }),
    null,
    ...base,
    "2026-06-04T00:00:00.000Z",
  );
  db.close();
}

test("runtime snapshot corpus scans Runtime SQLite files and imports selected scopes read-only", async () => {
  await withTempDir(async (dir) => {
    const source = join(dir, "runtime-lite.sqlite");
    const invalid = join(dir, "not-runtime.sqlite");
    const output = join(dir, "report.json");
    createRuntimeLiteCorpusFixture(source);
    await writeFile(invalid, "not a sqlite database", "utf8");

    const report = await runRuntimeSnapshotCorpus({
      rootPaths: [dir],
      outputPath: output,
      maxFiles: null,
      maxScopes: 1,
      maxScopesPerFile: 2,
      minNodes: 2,
      maxPerBucket: 10,
    });

    assert.equal(report.discovered_sqlite_files, 2);
    assert.equal(report.runtime_sqlite_files, 1);
    assert.equal(report.candidate_scopes.length, 1);
    assert.equal(report.candidate_scopes[0]?.scope, "repo-alpha");
    assert.equal(report.attempted_scopes, 1);
    assert.equal(report.passed_scopes, 1);
    assert.equal(report.failed_scopes, 0);
    assert.equal(report.total_nodes_read, 3);
    assert.equal(report.total_nodes_imported, 3);
    assert.equal(report.total_nodes_skipped, 0);
    assert.equal(report.total_relations_read, 0);
    assert.equal(report.total_feedback_read, 0);
    assert.equal(report.total_decisions_read, 0);
    assert.ok(report.scan_warnings.some((warning) => warning.includes("not-runtime.sqlite")));
    assert.deepEqual(report.bucket_totals, {
      use_now: 1,
      inspect_before_use: 1,
      do_not_use: 0,
      rehydrate: 1,
    });
    assert.deepEqual(report.diagnostics_summary.skip_reasons.nodes, {
      not_agent_facing: 0,
      empty_summary: 0,
    });
    assert.equal(report.diagnostics_summary.source_table_presence.lite_memory_nodes, 1);
    assert.equal(report.diagnostics_summary.source_table_presence.lite_memory_edges, 0);
    assert.deepEqual(report.scope_reports[0]?.bucket_counts, {
      use_now: 1,
      inspect_before_use: 1,
      do_not_use: 0,
      rehydrate: 1,
    });
    assert.equal(report.scope_reports[0]?.nodes_read, 3);
    assert.equal(report.scope_reports[0]?.nodes_imported, 3);
    assert.equal(report.scope_reports[0]?.nodes_skipped, 0);

    const persisted = JSON.parse(await readFile(output, "utf8")) as { attempted_scopes: number; bucket_totals: { use_now: number } };
    assert.equal(persisted.attempted_scopes, 1);
    assert.equal(persisted.bucket_totals.use_now, 1);

    const sourceDb = new DatabaseSync(source, { readOnly: true });
    const sourceNodeCount = sourceDb.prepare("SELECT count(*) AS count FROM lite_memory_nodes").get() as { count: number };
    const substrateTable = sourceDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_nodes'").get();
    sourceDb.close();
    assert.equal(sourceNodeCount.count, 4);
    assert.equal(substrateTable, undefined);
  });
});
