import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openSqliteAionisSubstrate } from "../src/index.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "aionis-substrate-cli-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runCli(args: string[], cwd = process.cwd()): unknown {
  const output = execFileSync("node", ["src/cli.ts", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output);
}

test("published CLI entrypoints expose root and sidecar help", () => {
  const rootHelp = execFileSync("node", ["src/cli.ts", "--help"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.match(rootHelp, /Aionis Substrate CLI/);
  assert.match(rootHelp, /aionis-substrate sidecar/);
  assert.match(rootHelp, /live-sidecar/);

  const sidecarHelp = execFileSync("node", ["src/cli.ts", "sidecar", "--help"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.match(sidecarHelp, /Aionis Substrate sidecar check/);
  assert.match(sidecarHelp, /--source-root/);
  assert.match(rootHelp, /preview-context/);
  assert.match(rootHelp, /backup/);

  const liveSidecarHelp = execFileSync("node", ["src/cli.ts", "live-sidecar", "--help"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.match(liveSidecarHelp, /Runtime live sidecar/);
  assert.match(liveSidecarHelp, /--checkpoint/);
});

test("CLI store commands inspect preview backup restore and compact a real SQLite store", async () => {
  await withTempDir(async (dir) => {
    const storePath = join(dir, "substrate.sqlite");
    const store = await openSqliteAionisSubstrate({ path: storePath });
    await store.putNode({
      id: "current-route",
      scope: "repo-a",
      kind: "procedure",
      summary: "Use src/runtime.ts after verifier passed.",
      lifecycle: "active",
      authority: "trusted",
      confidence: 0.95,
      targetFiles: ["src/runtime.ts"],
    });
    await store.putNode({
      id: "old-route",
      scope: "repo-a",
      kind: "procedure",
      summary: "Old src/legacy.ts route retained as evidence.",
      lifecycle: "active",
      authority: "trusted",
      confidence: 0.7,
      targetFiles: ["src/legacy.ts"],
    });
    await store.putRelation({
      scope: "repo-a",
      kind: "supersedes",
      sourceId: "current-route",
      targetId: "old-route",
      confidence: 0.9,
      reasons: ["newer verifier evidence replaced old route"],
    });
    await store.close();

    const inspect = runCli(["inspect", "--adapter", "sqlite", "--path", storePath, "--scope", "repo-a"]) as {
      counts: { nodes: number; relations: number };
    };
    assert.equal(inspect.counts.nodes, 2);
    assert.equal(inspect.counts.relations, 1);

    const preview = runCli([
      "preview-context",
      "--adapter",
      "sqlite",
      "--path",
      storePath,
      "--scope",
      "repo-a",
      "--query",
      "runtime verifier",
    ]) as {
      read_only: boolean;
      context: { use_now: Array<{ id: string }>; do_not_use: Array<{ id: string }> };
    };
    assert.equal(preview.read_only, true);
    assert.deepEqual(preview.context.use_now.map((node) => node.id), ["current-route"]);
    assert.deepEqual(preview.context.do_not_use.map((node) => node.id), ["old-route"]);

    const backupPath = join(dir, "backup.json");
    const backup = runCli(["backup", "--adapter", "sqlite", "--path", storePath, "--output", backupPath]) as {
      ok: boolean;
      eventCount: number;
    };
    assert.equal(backup.ok, true);
    assert.equal(backup.eventCount, 3);

    const restoredPath = join(dir, "restored.sqlite");
    const restore = runCli(["restore", "--adapter", "sqlite", "--path", restoredPath, "--input", backupPath]) as {
      restored: boolean;
      counts: { nodes: number; relations: number };
    };
    assert.equal(restore.restored, true);
    assert.equal(restore.counts.nodes, 2);
    assert.equal(restore.counts.relations, 1);

    const compact = runCli(["compact", "--adapter", "sqlite", "--path", restoredPath]) as {
      contract_version: string;
      compacted: boolean;
      after: { eventCount: number };
    };
    assert.equal(compact.contract_version, "aionis_substrate_compaction_report_v1");
    assert.equal(compact.compacted, true);
    assert.equal(compact.after.eventCount, 1);
  });
});

function createRuntimeLiteSource(path: string): void {
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
  db.prepare(`
    INSERT INTO lite_memory_nodes (
      id, scope, client_id, type, tier, title, text_summary, slots_json, raw_ref, evidence_ref,
      embedding_vector_json, embedding_model, memory_lane, producer_agent_id, owner_agent_id,
      owner_team_id, embedding_status, embedding_last_error, salience, importance, confidence,
      redaction_version, commit_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "runtime-current",
    "repo-a",
    "client-current",
    "procedure",
    "hot",
    "Runtime current route",
    "Use src/runtime.ts after verifier passed.",
    JSON.stringify({ summary_kind: "workflow_anchor", contract_trust: "trusted", target_files: ["src/runtime.ts"] }),
    null,
    null,
    null,
    null,
    "execution",
    "agent-a",
    "agent-a",
    "team-a",
    "ready",
    null,
    0.8,
    0.8,
    0.95,
    1,
    "commit-a",
    "2026-06-01T00:00:00.000Z",
  );
  db.close();
}

test("CLI imports a Runtime Lite snapshot into a separate Substrate store", async () => {
  await withTempDir(async (dir) => {
    const source = join(dir, "runtime.sqlite");
    const target = join(dir, "substrate.sqlite");
    createRuntimeLiteSource(source);
    const report = runCli([
      "import-runtime-snapshot",
      "--source",
      source,
      "--target",
      target,
      "--adapter",
      "sqlite",
      "--scope",
      "repo-a",
    ]) as {
      contract_version: string;
      nodesImported: number;
      scopes: string[];
    };
    assert.equal(report.contract_version, "aionis_runtime_lite_snapshot_import_summary_v1");
    assert.equal(report.nodesImported, 1);
    assert.deepEqual(report.scopes, ["repo-a"]);
  });
});

test("CLI live-sidecar incrementally mirrors Runtime Lite evidence with a checkpoint", async () => {
  await withTempDir(async (dir) => {
    const source = join(dir, "runtime.sqlite");
    const target = join(dir, "substrate.sqlite");
    const checkpoint = join(dir, "checkpoint.json");
    createRuntimeLiteSource(source);
    const first = runCli([
      "live-sidecar",
      "--source",
      source,
      "--target",
      target,
      "--adapter",
      "sqlite",
      "--checkpoint",
      checkpoint,
      "--scope",
      "repo-a",
    ]) as {
      contract_version: string;
      apply_summary: { nodes: { applied: number; unchanged: number } };
      store_after: { eventCount: number };
    };
    assert.equal(first.contract_version, "aionis_runtime_live_sidecar_report_v1");
    assert.equal(first.apply_summary.nodes.applied, 1);
    assert.equal(first.apply_summary.nodes.unchanged, 0);

    const second = runCli([
      "live-sidecar",
      "--source",
      source,
      "--target",
      target,
      "--adapter",
      "sqlite",
      "--checkpoint",
      checkpoint,
      "--scope",
      "repo-a",
    ]) as {
      apply_summary: { nodes: { applied: number; unchanged: number } };
      store_after: { eventCount: number };
    };
    assert.equal(second.apply_summary.nodes.applied, 0);
    assert.equal(second.apply_summary.nodes.unchanged, 1);
    assert.equal(second.store_after.eventCount, first.store_after.eventCount);
  });
});

test("CLI live-sidecar watch runs bounded iterations and reports aggregate stats", async () => {
  await withTempDir(async (dir) => {
    const source = join(dir, "runtime.sqlite");
    const target = join(dir, "substrate.sqlite");
    const checkpoint = join(dir, "checkpoint.json");
    const lock = join(dir, "sidecar.lock");
    createRuntimeLiteSource(source);
    const report = runCli([
      "live-sidecar",
      "--source",
      source,
      "--target",
      target,
      "--adapter",
      "sqlite",
      "--checkpoint",
      checkpoint,
      "--scope",
      "repo-a",
      "--watch",
      "--iterations",
      "2",
      "--interval-ms",
      "1",
      "--lock",
      lock,
    ]) as {
      contract_version: string;
      iterations_completed: number;
      lock_path: string;
      apply_summary: { nodes: { attempted: number; applied: number; unchanged: number } };
      reports: Array<{ apply_summary: { nodes: { applied: number; unchanged: number } } }>;
    };
    assert.equal(report.contract_version, "aionis_runtime_live_sidecar_watch_report_v1");
    assert.equal(report.iterations_completed, 2);
    assert.equal(report.lock_path, lock);
    assert.equal(report.apply_summary.nodes.attempted, 2);
    assert.equal(report.apply_summary.nodes.applied, 1);
    assert.equal(report.apply_summary.nodes.unchanged, 1);
    assert.equal(report.reports[0].apply_summary.nodes.applied, 1);
    assert.equal(report.reports[1].apply_summary.nodes.unchanged, 1);
  });
});
