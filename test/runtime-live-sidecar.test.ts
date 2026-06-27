import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  openSqliteAionisSubstrate,
  runRuntimeLiveSidecarOnce,
  runRuntimeLiveSidecarWatch,
  type RuntimeLiveSidecarCheckpoint,
} from "../src/index.ts";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "aionis-runtime-live-sidecar-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

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
  db.close();
}

function insertRuntimeNode(path: string, id: string, summary: string, createdAt: string): void {
  const db = new DatabaseSync(path);
  db.prepare(`
    INSERT INTO lite_memory_nodes (
      id, scope, client_id, type, tier, title, text_summary, slots_json, raw_ref, evidence_ref,
      embedding_vector_json, embedding_model, memory_lane, producer_agent_id, owner_agent_id,
      owner_team_id, embedding_status, embedding_last_error, salience, importance, confidence,
      redaction_version, commit_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    "repo-a",
    `client-${id}`,
    "procedure",
    "hot",
    id,
    summary,
    JSON.stringify({
      summary_kind: "workflow_anchor",
      contract_trust: "trusted",
      target_files: ["src/runtime.ts"],
    }),
    null,
    null,
    null,
    "fixture-embedding",
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
    createdAt,
  );
  db.close();
}

function updateRuntimeNodeSummary(path: string, id: string, summary: string): void {
  const db = new DatabaseSync(path);
  db.prepare("UPDATE lite_memory_nodes SET text_summary = ? WHERE id = ?").run(summary, id);
  db.close();
}

async function readCheckpoint(path: string): Promise<RuntimeLiveSidecarCheckpoint> {
  return JSON.parse(await readFile(path, "utf8")) as RuntimeLiveSidecarCheckpoint;
}

test("Runtime live sidecar writes a snapshot once and skips unchanged evidence on restart", async () => {
  await withTempDir(async (dir) => {
    const source = join(dir, "runtime.sqlite");
    const target = join(dir, "substrate.sqlite");
    const checkpoint = join(dir, "checkpoint.json");
    createRuntimeLiteSource(source);
    insertRuntimeNode(source, "runtime-current", "Use src/runtime.ts after verifier passed.", "2026-06-01T00:00:00.000Z");

    const store = await openSqliteAionisSubstrate({ path: target });
    try {
      const first = await runRuntimeLiveSidecarOnce({ sourcePath: source, target: store, checkpointPath: checkpoint, scope: "repo-a" });
      assert.equal(first.apply_summary.nodes.attempted, 1);
      assert.equal(first.apply_summary.nodes.applied, 1);
      assert.equal(first.apply_summary.nodes.unchanged, 0);
      assert.equal(first.store_before.eventCount, 0);
      assert.equal(first.store_after.eventCount, 1);

      const second = await runRuntimeLiveSidecarOnce({ sourcePath: source, target: store, checkpointPath: checkpoint, scope: "repo-a" });
      assert.equal(second.apply_summary.nodes.attempted, 1);
      assert.equal(second.apply_summary.nodes.applied, 0);
      assert.equal(second.apply_summary.nodes.unchanged, 1);
      assert.equal(second.store_after.eventCount, first.store_after.eventCount);

      const persisted = await readCheckpoint(checkpoint);
      assert.equal(Object.keys(persisted.fingerprints.nodes).length, 1);
    } finally {
      await store.close();
    }
  });
});

test("Runtime live sidecar repairs a missing checkpoint after target writes without duplicating events", async () => {
  await withTempDir(async (dir) => {
    const source = join(dir, "runtime.sqlite");
    const target = join(dir, "substrate.sqlite");
    const checkpoint = join(dir, "checkpoint.json");
    createRuntimeLiteSource(source);
    insertRuntimeNode(source, "runtime-current", "Use src/runtime.ts after verifier passed.", "2026-06-01T00:00:00.000Z");

    const store = await openSqliteAionisSubstrate({ path: target });
    try {
      const first = await runRuntimeLiveSidecarOnce({ sourcePath: source, target: store, checkpointPath: checkpoint, scope: "repo-a" });
      assert.equal(first.store_after.eventCount, 1);
      await rm(checkpoint, { force: true });

      const recovered = await runRuntimeLiveSidecarOnce({ sourcePath: source, target: store, checkpointPath: checkpoint, scope: "repo-a" });
      assert.equal(recovered.checkpoint_before.present, false);
      assert.equal(recovered.apply_summary.nodes.attempted, 1);
      assert.equal(recovered.apply_summary.nodes.applied, 0);
      assert.equal(recovered.apply_summary.nodes.unchanged, 1);
      assert.equal(recovered.store_after.eventCount, 1);
      assert.equal(Object.keys((await readCheckpoint(checkpoint)).fingerprints.nodes).length, 1);
    } finally {
      await store.close();
    }
  });
});

test("Runtime live sidecar still applies changed Runtime evidence when checkpoint is missing", async () => {
  await withTempDir(async (dir) => {
    const source = join(dir, "runtime.sqlite");
    const target = join(dir, "substrate.sqlite");
    const checkpoint = join(dir, "checkpoint.json");
    createRuntimeLiteSource(source);
    insertRuntimeNode(source, "runtime-current", "Use src/runtime.ts after verifier passed.", "2026-06-01T00:00:00.000Z");

    const store = await openSqliteAionisSubstrate({ path: target });
    try {
      await runRuntimeLiveSidecarOnce({ sourcePath: source, target: store, checkpointPath: checkpoint, scope: "repo-a" });
      await rm(checkpoint, { force: true });
      updateRuntimeNodeSummary(source, "runtime-current", "Use src/runtime.ts after the updated verifier passed.");

      const report = await runRuntimeLiveSidecarOnce({ sourcePath: source, target: store, checkpointPath: checkpoint, scope: "repo-a" });
      assert.equal(report.apply_summary.nodes.attempted, 1);
      assert.equal(report.apply_summary.nodes.applied, 1);
      assert.equal(report.apply_summary.nodes.unchanged, 0);
      assert.equal(report.store_after.eventCount, 2);
      assert.equal((await store.getNode("repo-a", "runtime-current"))?.summary, "Use src/runtime.ts after the updated verifier passed.");

      const second = await runRuntimeLiveSidecarOnce({ sourcePath: source, target: store, checkpointPath: checkpoint, scope: "repo-a" });
      assert.equal(second.apply_summary.nodes.applied, 0);
      assert.equal(second.apply_summary.nodes.unchanged, 1);
      assert.equal(second.store_after.eventCount, 2);
    } finally {
      await store.close();
    }
  });
});

test("Runtime live sidecar applies only new Runtime evidence after the checkpoint", async () => {
  await withTempDir(async (dir) => {
    const source = join(dir, "runtime.sqlite");
    const target = join(dir, "substrate.sqlite");
    const checkpoint = join(dir, "checkpoint.json");
    createRuntimeLiteSource(source);
    insertRuntimeNode(source, "runtime-current", "Use src/runtime.ts after verifier passed.", "2026-06-01T00:00:00.000Z");

    const store = await openSqliteAionisSubstrate({ path: target });
    try {
      await runRuntimeLiveSidecarOnce({ sourcePath: source, target: store, checkpointPath: checkpoint, scope: "repo-a" });
      const before = await store.getStoreInfo();
      insertRuntimeNode(source, "runtime-new", "Use tests/runtime.test.ts as the new verifier route.", "2026-06-02T00:00:00.000Z");

      const report = await runRuntimeLiveSidecarOnce({ sourcePath: source, target: store, checkpointPath: checkpoint, scope: "repo-a" });
      assert.equal(report.apply_summary.nodes.attempted, 2);
      assert.equal(report.apply_summary.nodes.applied, 1);
      assert.equal(report.apply_summary.nodes.unchanged, 1);
      assert.equal(report.store_after.eventCount, before.eventCount + 1);
      assert.deepEqual((await store.listNodes("repo-a")).map((node) => node.id).sort(), ["runtime-current", "runtime-new"]);
    } finally {
      await store.close();
    }
  });
});

test("Runtime live sidecar ignores a stale checkpoint when the target store is empty", async () => {
  await withTempDir(async (dir) => {
    const source = join(dir, "runtime.sqlite");
    const firstTarget = join(dir, "substrate-first.sqlite");
    const secondTarget = join(dir, "substrate-empty.sqlite");
    const checkpoint = join(dir, "checkpoint.json");
    createRuntimeLiteSource(source);
    insertRuntimeNode(source, "runtime-current", "Use src/runtime.ts after verifier passed.", "2026-06-01T00:00:00.000Z");

    const firstStore = await openSqliteAionisSubstrate({ path: firstTarget });
    try {
      await runRuntimeLiveSidecarOnce({ sourcePath: source, target: firstStore, checkpointPath: checkpoint, scope: "repo-a" });
    } finally {
      await firstStore.close();
    }

    const secondStore = await openSqliteAionisSubstrate({ path: secondTarget });
    try {
      const report = await runRuntimeLiveSidecarOnce({ sourcePath: source, target: secondStore, checkpointPath: checkpoint, scope: "repo-a" });
      assert.equal(report.checkpoint_before.present, true);
      assert.equal(report.checkpoint_before.fingerprint_counts.nodes, 1);
      assert.equal(report.apply_summary.nodes.applied, 1);
      assert.equal(report.apply_summary.nodes.unchanged, 0);
      assert.ok(report.warnings.some((warning) => warning.includes("checkpoint ignored because target store is empty")));
      assert.deepEqual((await secondStore.listNodes("repo-a")).map((node) => node.id), ["runtime-current"]);
    } finally {
      await secondStore.close();
    }
  });
});

test("Runtime live sidecar rejects corrupt checkpoint without mutating target", async () => {
  await withTempDir(async (dir) => {
    const source = join(dir, "runtime.sqlite");
    const target = join(dir, "substrate.sqlite");
    const checkpoint = join(dir, "checkpoint.json");
    createRuntimeLiteSource(source);
    insertRuntimeNode(source, "runtime-current", "Use src/runtime.ts after verifier passed.", "2026-06-01T00:00:00.000Z");

    const store = await openSqliteAionisSubstrate({ path: target });
    try {
      await runRuntimeLiveSidecarOnce({ sourcePath: source, target: store, checkpointPath: checkpoint, scope: "repo-a" });
      const before = await store.getStoreInfo();
      insertRuntimeNode(source, "runtime-new-after-corrupt-checkpoint", "This must not be mirrored while checkpoint is corrupt.", "2026-06-02T00:00:00.000Z");
      await writeFile(checkpoint, "{ corrupt checkpoint\n", "utf8");

      await assert.rejects(
        runRuntimeLiveSidecarOnce({ sourcePath: source, target: store, checkpointPath: checkpoint, scope: "repo-a" }),
        /failed to parse Runtime live sidecar checkpoint/,
      );
      assert.deepEqual(await store.getStoreInfo(), before);
      assert.deepEqual((await store.listNodes("repo-a")).map((node) => node.id), ["runtime-current"]);
    } finally {
      await store.close();
    }
  });
});

test("Runtime live sidecar rejects malformed checkpoint fingerprints without mutating target", async () => {
  await withTempDir(async (dir) => {
    const source = join(dir, "runtime.sqlite");
    const target = join(dir, "substrate.sqlite");
    const checkpoint = join(dir, "checkpoint.json");
    createRuntimeLiteSource(source);
    insertRuntimeNode(source, "runtime-current", "Use src/runtime.ts after verifier passed.", "2026-06-01T00:00:00.000Z");

    const store = await openSqliteAionisSubstrate({ path: target });
    try {
      await writeFile(checkpoint, `${JSON.stringify({
        contract_version: "aionis_runtime_live_sidecar_checkpoint_v1",
        source_path: source,
        scope: "repo-a",
        updated_at: "2026-06-01T00:00:00.000Z",
        last_run_id: null,
        fingerprints: {
          nodes: { "repo-a\u0000runtime-current": 123 },
          relations: {},
          feedback: {},
          decisions: {},
        },
      }, null, 2)}\n`, "utf8");

      await assert.rejects(
        runRuntimeLiveSidecarOnce({ sourcePath: source, target: store, checkpointPath: checkpoint, scope: "repo-a" }),
        /fingerprints\.nodes\.repo-a.*runtime-current must be a string fingerprint/,
      );
      assert.equal((await store.getStoreInfo()).eventCount, 0);
      assert.deepEqual(await store.listNodes("repo-a"), []);
    } finally {
      await store.close();
    }
  });
});

test("Runtime live sidecar rejects checkpoint source or scope mismatch without mutating target", async () => {
  await withTempDir(async (dir) => {
    const source = join(dir, "runtime.sqlite");
    const target = join(dir, "substrate.sqlite");
    const checkpoint = join(dir, "checkpoint.json");
    createRuntimeLiteSource(source);
    insertRuntimeNode(source, "runtime-current", "Use src/runtime.ts after verifier passed.", "2026-06-01T00:00:00.000Z");

    const store = await openSqliteAionisSubstrate({ path: target });
    try {
      await writeFile(checkpoint, `${JSON.stringify({
        contract_version: "aionis_runtime_live_sidecar_checkpoint_v1",
        source_path: join(dir, "different-runtime.sqlite"),
        scope: "repo-a",
        updated_at: "2026-06-01T00:00:00.000Z",
        last_run_id: null,
        fingerprints: {
          nodes: {},
          relations: {},
          feedback: {},
          decisions: {},
        },
      }, null, 2)}\n`, "utf8");

      await assert.rejects(
        runRuntimeLiveSidecarOnce({ sourcePath: source, target: store, checkpointPath: checkpoint, scope: "repo-a" }),
        /checkpoint source_path\/scope does not match/,
      );
      assert.equal((await store.getStoreInfo()).eventCount, 0);
      assert.deepEqual(await store.listNodes("repo-a"), []);
    } finally {
      await store.close();
    }
  });
});

test("Runtime live sidecar watch runs a bounded interval loop under a lock", async () => {
  await withTempDir(async (dir) => {
    const source = join(dir, "runtime.sqlite");
    const target = join(dir, "substrate.sqlite");
    const checkpoint = join(dir, "checkpoint.json");
    const lock = join(dir, "sidecar.lock");
    createRuntimeLiteSource(source);
    insertRuntimeNode(source, "runtime-current", "Use src/runtime.ts after verifier passed.", "2026-06-01T00:00:00.000Z");

    const store = await openSqliteAionisSubstrate({ path: target });
    try {
      const report = await runRuntimeLiveSidecarWatch({
        sourcePath: source,
        target: store,
        checkpointPath: checkpoint,
        scope: "repo-a",
        intervalMs: 1,
        iterations: 2,
        lockPath: lock,
      });
      assert.equal(report.contract_version, "aionis_runtime_live_sidecar_watch_report_v1");
      assert.equal(report.iterations_completed, 2);
      assert.equal(report.lock_path, lock);
      assert.equal(report.reports[0].apply_summary.nodes.applied, 1);
      assert.equal(report.reports[1].apply_summary.nodes.applied, 0);
      assert.equal(report.reports[1].apply_summary.nodes.unchanged, 1);
      assert.equal(report.apply_summary.nodes.attempted, 2);
      assert.equal(report.apply_summary.nodes.applied, 1);
      assert.equal(report.apply_summary.nodes.unchanged, 1);
      await assert.rejects(readFile(lock, "utf8"), { code: "ENOENT" });
    } finally {
      await store.close();
    }
  });
});

test("Runtime live sidecar watch releases lock when checkpoint recovery fails closed", async () => {
  await withTempDir(async (dir) => {
    const source = join(dir, "runtime.sqlite");
    const target = join(dir, "substrate.sqlite");
    const checkpoint = join(dir, "checkpoint.json");
    const lock = join(dir, "sidecar.lock");
    createRuntimeLiteSource(source);
    insertRuntimeNode(source, "runtime-current", "Use src/runtime.ts after verifier passed.", "2026-06-01T00:00:00.000Z");
    await writeFile(checkpoint, "{ corrupt checkpoint\n", "utf8");

    const store = await openSqliteAionisSubstrate({ path: target });
    try {
      await assert.rejects(
        runRuntimeLiveSidecarWatch({
          sourcePath: source,
          target: store,
          checkpointPath: checkpoint,
          scope: "repo-a",
          intervalMs: 1,
          iterations: 1,
          lockPath: lock,
        }),
        /failed to parse Runtime live sidecar checkpoint/,
      );
      assert.equal((await store.getStoreInfo()).eventCount, 0);
      await assert.rejects(readFile(lock, "utf8"), { code: "ENOENT" });
    } finally {
      await store.close();
    }
  });
});

test("Runtime live sidecar watch rejects an existing lock", async () => {
  await withTempDir(async (dir) => {
    const source = join(dir, "runtime.sqlite");
    const target = join(dir, "substrate.sqlite");
    const checkpoint = join(dir, "checkpoint.json");
    const lock = join(dir, "sidecar.lock");
    createRuntimeLiteSource(source);
    insertRuntimeNode(source, "runtime-current", "Use src/runtime.ts after verifier passed.", "2026-06-01T00:00:00.000Z");
    await writeFile(lock, "locked\n", "utf8");

    const store = await openSqliteAionisSubstrate({ path: target });
    try {
      await assert.rejects(
        runRuntimeLiveSidecarWatch({
          sourcePath: source,
          target: store,
          checkpointPath: checkpoint,
          scope: "repo-a",
          intervalMs: 1,
          iterations: 1,
          lockPath: lock,
        }),
        /lock already exists/,
      );
      assert.equal((await store.getStoreInfo()).eventCount, 0);
    } finally {
      await store.close();
    }
  });
});
