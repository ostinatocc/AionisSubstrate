import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runRuntimeReferenceCorpus } from "../src/index.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "aionis-runtime-reference-corpus-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function createRuntimeSource(path: string): void {
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
  const insert = db.prepare(`
    INSERT INTO lite_memory_nodes (
      id, scope, client_id, type, tier, title, text_summary, slots_json, raw_ref, evidence_ref,
      embedding_vector_json, embedding_model, memory_lane, producer_agent_id, owner_agent_id,
      owner_team_id, embedding_status, embedding_last_error, salience, importance, confidence,
      redaction_version, commit_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const common = [
    null,
    null,
    null,
    "fixture",
    "shared",
    "agent-a",
    "agent-a",
    "team-a",
    "ready",
    null,
    0.7,
    0.7,
  ] as const;
  insert.run(
    "mem-use",
    "scope-a",
    "client-use",
    "procedure",
    "hot",
    "Use",
    "Active trusted route.",
    JSON.stringify({ summary_kind: "workflow_anchor", contract_trust: "trusted", target_files: ["src/a.ts"] }),
    ...common,
    0.9,
    1,
    "commit-a",
    "2026-06-01T00:00:00.000Z",
  );
  insert.run(
    "mem-inspect",
    "scope-a",
    "client-inspect",
    "concept",
    "warm",
    "Inspect",
    "Candidate note.",
    JSON.stringify({ summary_kind: "note", target_files: ["src/a.ts"] }),
    ...common,
    0.55,
    1,
    "commit-a",
    "2026-06-01T00:01:00.000Z",
  );
  insert.run(
    "mem-block",
    "scope-a",
    "client-block",
    "procedure",
    "hot",
    "Block",
    "Blocked route.",
    JSON.stringify({ lifecycle_state: "blocked", authority: "rejected", target_files: ["src/old.ts"] }),
    ...common,
    0.8,
    1,
    "commit-a",
    "2026-06-01T00:02:00.000Z",
  );
  insert.run(
    "mem-rehydrate",
    "scope-a",
    "client-rehydrate",
    "event",
    "archive",
    "Trace",
    "Raw evidence pointer.",
    JSON.stringify({ summary_kind: "raw_trace", target_files: ["src/a.ts"] }),
    "file://trace.log",
    null,
    null,
    "fixture",
    "shared",
    "agent-a",
    "agent-a",
    "team-a",
    "ready",
    null,
    0.7,
    0.7,
    0.75,
    1,
    "commit-a",
    "2026-06-01T00:03:00.000Z",
  );
  db.close();
}

test("matches Runtime reference JSON to source scopes by concrete memory id overlap", async () => {
  await withTempDir(async (dir) => {
    const sourceRoot = join(dir, "sources");
    const referenceRoot = join(dir, "references");
    await mkdir(sourceRoot);
    await mkdir(referenceRoot);
    const source = join(sourceRoot, "runtime.sqlite");
    createRuntimeSource(source);
    await writeFile(join(referenceRoot, "matched.json"), JSON.stringify({
      agent_context: {
        use_now_memory_ids: ["mem-use"],
        inspect_before_use_memory_ids: ["mem-inspect"],
        do_not_use_memory_ids: ["mem-block"],
        rehydrate_hints: [{ memory_id: "mem-rehydrate" }],
      },
    }), "utf8");
    await writeFile(join(referenceRoot, "unmatched.json"), JSON.stringify({
      agent_context: {
        use_now_memory_ids: ["external-id"],
      },
    }), "utf8");

    const report = await runRuntimeReferenceCorpus({
      sourceRootPaths: [sourceRoot],
      referenceRootPaths: [referenceRoot],
      maxScopesPerFile: 10,
      minNodes: 1,
    });

    assert.equal(report.discovered_reference_files, 2);
    assert.equal(report.reference_files_with_surfaces, 2);
    assert.equal(report.matched_references, 1);
    assert.equal(report.unmatched_references, 1);
    assert.equal(report.exact_matches, 1);
    assert.equal(report.matched_reports[0]?.scope, "scope-a");
    assert.equal(report.matched_reports[0]?.overlap_count, 4);
    assert.equal(report.unmatched_reference_reports[0]?.reason, "no_runtime_scope_overlap");
  });
});
