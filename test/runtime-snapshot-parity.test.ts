import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  extractRuntimeReferenceSurfaces,
  runRuntimeSnapshotParity,
} from "../src/index.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "aionis-runtime-snapshot-parity-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function createParityRuntimeFixture(path: string): void {
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

test("extracts Runtime reference surfaces from nested guide and trace records", () => {
  const surfaces = extractRuntimeReferenceSurfaces({
    after_guide: {
      agent_context: {
        use_now_memory_ids: ["mem-use"],
        inspect_before_use_memory_ids: ["mem-inspect"],
        do_not_use_memory_ids: ["mem-block"],
        rehydrate_hints: [{ memory_id: "mem-rehydrate" }],
      },
      memory_decision_trace: {
        memory_decisions: [
          { memory_id: "mem-use", agent_surface: "use_now" },
          { memory_id: "mem-block", agent_surface: "do_not_use" },
        ],
      },
    },
  });
  assert.deepEqual(surfaces, {
    use_now: ["mem-use"],
    inspect_before_use: ["mem-inspect"],
    do_not_use: ["mem-block"],
    rehydrate: ["mem-rehydrate"],
  });
});

test("runs Runtime snapshot parity against a real SQLite source and Runtime reference JSON", async () => {
  await withTempDir(async (dir) => {
    const source = join(dir, "runtime.sqlite");
    const target = join(dir, "substrate.sqlite");
    const reference = join(dir, "reference.json");
    createParityRuntimeFixture(source);
    await writeFile(reference, JSON.stringify({
      agent_context: {
        use_now_memory_ids: ["mem-use"],
        inspect_before_use_memory_ids: ["mem-inspect"],
        do_not_use_memory_ids: ["mem-block"],
        rehydrate_hints: [{ memory_id: "mem-rehydrate" }],
      },
    }), "utf8");

    const report = await runRuntimeSnapshotParity({
      sourcePath: source,
      targetPath: target,
      scope: "scope-a",
      referencePath: reference,
    });

    assert.equal(report.import_summary.nodesImported, 4);
    assert.equal(report.reference_present, true);
    assert.equal(report.parity.exact, true);
    assert.deepEqual(report.parity.bucket_reports.map((bucket) => [bucket.bucket, bucket.exact]), [
      ["use_now", true],
      ["inspect_before_use", true],
      ["do_not_use", true],
      ["rehydrate", true],
    ]);
  });
});
