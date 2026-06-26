import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openFileAionisSubstrate, openSqliteAionisSubstrate, type AionisSubstrate } from "../src/index.ts";

async function withSqlite<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "aionis-substrate-sqlite-"));
  try {
    return await fn(join(dir, "substrate.sqlite"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function seedGovernedScenario(store: AionisSubstrate): Promise<void> {
  await store.putNode({
    id: "current-route",
    scope: "repo-a",
    kind: "execution",
    summary: "Current validated route uses src/runtime.ts.",
    lifecycle: "active",
    authority: "trusted",
    confidence: 0.95,
    targetFiles: ["src/runtime.ts"],
  });
  await store.putNode({
    id: "old-route",
    scope: "repo-a",
    kind: "execution",
    summary: "Old route used src/legacy.ts.",
    lifecycle: "active",
    authority: "trusted",
    confidence: 0.7,
    targetFiles: ["src/legacy.ts"],
  });
  await store.putNode({
    id: "raw-trace",
    scope: "repo-a",
    kind: "trace_pointer",
    summary: "Raw terminal evidence for the previous run.",
    lifecycle: "archived",
    authority: "trusted",
    confidence: 0.88,
    payloadRef: "file://traces/run.log",
  });
  await store.putRelation({
    id: "rel-current-supersedes-old",
    scope: "repo-a",
    kind: "supersedes",
    sourceId: "current-route",
    targetId: "old-route",
    confidence: 0.9,
    reasons: ["new route has later verifier evidence"],
  });
}

test("sqlite substrate persists event log and structured read model across reopen", async () => {
  await withSqlite(async (path) => {
    let store = await openSqliteAionisSubstrate({ path });
    await seedGovernedScenario(store);
    await store.close();

    store = await openSqliteAionisSubstrate({ path });
    const node = await store.getNode("repo-a", "current-route");
    assert.equal(node?.summary, "Current validated route uses src/runtime.ts.");

    const context = await store.compileContext({ scope: "repo-a" });
    assert.deepEqual(context.use_now.map((item) => item.id), ["current-route"]);
    assert.deepEqual(context.do_not_use.map((item) => item.id), ["old-route"]);
    assert.deepEqual(context.rehydrate.map((item) => item.id), ["raw-trace"]);

    const events = await store.listEvents();
    assert.equal(events.length, 5);
    assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5]);
    assert.equal(events.at(-1)?.type, "memory.decision.recorded");
    assert.deepEqual(await store.getStoreInfo(), {
      adapter: "sqlite",
      schemaVersion: 1,
      lastSequence: 5,
      eventCount: 5,
    });
    await store.close();

    const db = new DatabaseSync(path, { readOnly: true });
    const schemaVersion = db.prepare("SELECT value FROM substrate_metadata WHERE key = 'schema_version'").get() as { value: string };
    const userVersion = db.prepare("PRAGMA user_version").get() as { user_version: number };
    db.close();
    assert.equal(schemaVersion.value, "1");
    assert.equal(userVersion.user_version, 1);
  });
});

test("sqlite preview context is read-only while compile context records a decision receipt", async () => {
  await withSqlite(async (path) => {
    const store = await openSqliteAionisSubstrate({ path });
    await seedGovernedScenario(store);

    const beforePreview = await store.listEvents();
    const preview = await store.previewContext({ scope: "repo-a" });
    assert.deepEqual(preview.use_now.map((item) => item.id), ["current-route"]);
    assert.deepEqual(preview.do_not_use.map((item) => item.id), ["old-route"]);
    assert.deepEqual(preview.rehydrate.map((item) => item.id), ["raw-trace"]);
    assert.equal((await store.listEvents()).length, beforePreview.length);

    const compiled = await store.compileContext({ scope: "repo-a" });
    assert.deepEqual(compiled.use_now.map((item) => item.id), preview.use_now.map((item) => item.id));
    assert.deepEqual(compiled.do_not_use.map((item) => item.id), preview.do_not_use.map((item) => item.id));
    assert.deepEqual(compiled.rehydrate.map((item) => item.id), preview.rehydrate.map((item) => item.id));

    const afterCompile = await store.listEvents();
    assert.equal(afterCompile.length, beforePreview.length + 1);
    assert.equal(afterCompile.at(-1)?.type, "memory.decision.recorded");
    await store.close();
  });
});

test("sqlite audit read APIs expose scoped records without mutating events", async () => {
  await withSqlite(async (path) => {
    const store = await openSqliteAionisSubstrate({ path });
    await seedGovernedScenario(store);
    await store.putNode({
      id: "other-route",
      scope: "repo-b",
      kind: "execution",
      summary: "Other scope route must not leak.",
      lifecycle: "active",
      authority: "trusted",
      confidence: 0.9,
      targetFiles: ["src/other.ts"],
    });
    await store.recordFeedback({
      id: "fb-current",
      scope: "repo-a",
      memoryId: "current-route",
      outcome: "positive",
      strength: "strong",
      runId: "run-1",
      evidenceRef: "trace://run-1/verifier",
    });
    await store.recordFeedback({
      id: "fb-other",
      scope: "repo-b",
      memoryId: "other-route",
      outcome: "negative",
      strength: "weak",
      runId: "run-2",
      evidenceRef: "trace://run-2/verifier",
    });
    await store.compileContext({ scope: "repo-a", query: "continue runtime route" });

    const beforeReads = await store.listEvents();
    assert.deepEqual((await store.listRelations("repo-a")).map((relation) => relation.id), ["rel-current-supersedes-old"]);
    assert.deepEqual((await store.listRelations("repo-a", "current-route")).map((relation) => relation.id), ["rel-current-supersedes-old"]);
    assert.deepEqual((await store.listRelations("repo-a", "old-route")).map((relation) => relation.id), ["rel-current-supersedes-old"]);
    assert.deepEqual(await store.listRelations("repo-a", "missing-route"), []);
    assert.deepEqual(await store.listRelations("repo-b"), []);

    assert.deepEqual((await store.listFeedback({ scope: "repo-a" })).map((feedback) => feedback.id), ["fb-current"]);
    assert.deepEqual((await store.listFeedback({ scope: "repo-a", memoryId: "current-route" })).map((feedback) => feedback.id), ["fb-current"]);
    assert.deepEqual(await store.listFeedback({ scope: "repo-a", memoryId: "old-route" }), []);
    assert.deepEqual((await store.listFeedback({ scope: "repo-b" })).map((feedback) => feedback.id), ["fb-other"]);

    const decisions = await store.listDecisions("repo-a");
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.query, "continue runtime route");
    assert.deepEqual(await store.listDecisions("repo-b"), []);
    assert.equal((await store.listEvents()).length, beforeReads.length);
    await store.close();
  });
});

test("sqlite adapter rejects a store created by a newer schema", async () => {
  await withSqlite(async (path) => {
    let store = await openSqliteAionisSubstrate({ path });
    await store.close();

    const db = new DatabaseSync(path);
    db.prepare(`
      INSERT INTO substrate_metadata (key, value)
      VALUES ('schema_version', '999')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run();
    db.exec("PRAGMA user_version = 999");
    db.close();

    await assert.rejects(
      openSqliteAionisSubstrate({ path }),
      /unsupported Aionis Substrate schema version 999|unsupported SQLite user_version 999/,
    );
  });
});

test("sqlite migration scaffold records the initial schema migration once", async () => {
  await withSqlite(async (path) => {
    const firstOpenAt = new Date("2026-06-26T00:00:00.000Z");
    const secondOpenAt = new Date("2026-06-26T01:00:00.000Z");

    let store = await openSqliteAionisSubstrate({ path, now: () => firstOpenAt });
    await store.close();

    store = await openSqliteAionisSubstrate({ path, now: () => secondOpenAt });
    await store.close();

    const db = new DatabaseSync(path, { readOnly: true });
    const migrations = (db.prepare(`
      SELECT version, name, applied_at
      FROM substrate_schema_migrations
      ORDER BY version ASC
    `).all() as Array<{ version: number; name: string; applied_at: string }>).map((row) => ({
      version: row.version,
      name: row.name,
      applied_at: row.applied_at,
    }));
    const lastMigrated = db.prepare("SELECT value FROM substrate_metadata WHERE key = 'last_migrated_at'").get() as { value: string };
    const lastCheck = db.prepare("SELECT value FROM substrate_metadata WHERE key = 'last_migration_check_at'").get() as { value: string };
    const userVersion = db.prepare("PRAGMA user_version").get() as { user_version: number };
    db.close();

    assert.deepEqual(migrations, [{
      version: 1,
      name: "initial_substrate_schema",
      applied_at: firstOpenAt.toISOString(),
    }]);
    assert.equal(lastMigrated.value, firstOpenAt.toISOString());
    assert.equal(lastCheck.value, secondOpenAt.toISOString());
    assert.equal(userVersion.user_version, 1);
  });
});

test("sqlite migration scaffold backfills a legacy v1 store without rewriting events", async () => {
  await withSqlite(async (path) => {
    let store = await openSqliteAionisSubstrate({ path });
    await store.putNode({
      id: "existing",
      scope: "repo-a",
      kind: "fact",
      summary: "Existing memory from a pre-ledger store.",
      lifecycle: "active",
      authority: "trusted",
      confidence: 0.8,
    });
    await store.close();

    let db = new DatabaseSync(path);
    const eventCountBefore = db.prepare("SELECT count(*) AS count FROM substrate_events").get() as { count: number };
    db.exec("DROP TABLE substrate_schema_migrations");
    db.close();

    store = await openSqliteAionisSubstrate({
      path,
      now: () => new Date("2026-06-26T02:00:00.000Z"),
    });
    await store.close();

    db = new DatabaseSync(path, { readOnly: true });
    const eventCountAfter = db.prepare("SELECT count(*) AS count FROM substrate_events").get() as { count: number };
    const nodeCount = db.prepare("SELECT count(*) AS count FROM memory_nodes").get() as { count: number };
    const migrationRow = db.prepare(`
      SELECT version, name, applied_at
      FROM substrate_schema_migrations
      WHERE version = 1
    `).get() as { version: number; name: string; applied_at: string };
    const migration = {
      version: migrationRow.version,
      name: migrationRow.name,
      applied_at: migrationRow.applied_at,
    };
    db.close();

    assert.equal(eventCountAfter.count, eventCountBefore.count);
    assert.equal(nodeCount.count, 1);
    assert.deepEqual(migration, {
      version: 1,
      name: "initial_substrate_schema",
      applied_at: "2026-06-26T02:00:00.000Z",
    });
  });
});

test("sqlite migration scaffold rejects a corrupted migration ledger", async () => {
  await withSqlite(async (path) => {
    const store = await openSqliteAionisSubstrate({ path });
    await store.close();

    const db = new DatabaseSync(path);
    db.prepare("UPDATE substrate_schema_migrations SET name = 'tampered' WHERE version = 1").run();
    db.close();

    await assert.rejects(
      openSqliteAionisSubstrate({ path }),
      /SQLite migration 1 name mismatch: tampered !== initial_substrate_schema/,
    );
  });
});

test("sqlite adapter keeps controlled forgetting as a durable lifecycle transition", async () => {
  await withSqlite(async (path) => {
    const store = await openSqliteAionisSubstrate({ path });
    await store.putNode({
      id: "workflow-a",
      scope: "repo-a",
      kind: "procedure",
      summary: "Workflow A should not be direct-use after negative feedback.",
      lifecycle: "active",
      authority: "trusted",
      confidence: 0.8,
    });
    await store.transitionLifecycle({
      scope: "repo-a",
      memoryId: "workflow-a",
      lifecycle: "suppressed",
      authority: "rejected",
      confidence: 0.1,
      reason: "repeated aligned verifier failure",
    });
    const context = await store.compileContext({ scope: "repo-a" });
    assert.deepEqual(context.do_not_use.map((item) => item.id), ["workflow-a"]);

    const events = await store.listEvents();
    assert.ok(events.some((event) => event.type === "memory.lifecycle.transition"));
    await store.close();
  });
});

test("sqlite adapter rolls back invalid relation and feedback writes without partial events", async () => {
  await withSqlite(async (path) => {
    const store = await openSqliteAionisSubstrate({ path });
    await store.putNode({
      id: "existing",
      scope: "repo-a",
      kind: "fact",
      summary: "Existing memory.",
      lifecycle: "active",
      authority: "trusted",
      confidence: 0.8,
    });

    await assert.rejects(
      store.putRelation({
        scope: "repo-a",
        kind: "supports",
        sourceId: "missing-source",
        targetId: "existing",
      }),
      /cannot relate missing source memory node: missing-source/,
    );
    await assert.rejects(
      store.putRelation({
        scope: "repo-a",
        kind: "supports",
        sourceId: "existing",
        targetId: "missing-target",
      }),
      /cannot relate missing target memory node: missing-target/,
    );
    await assert.rejects(
      store.recordFeedback({
        scope: "repo-a",
        memoryId: "missing-feedback-target",
        outcome: "negative",
        strength: "weak",
      }),
      /cannot record feedback for missing memory node: missing-feedback-target/,
    );

    assert.equal((await store.listEvents()).length, 1);
    assert.equal((await store.listRelations("repo-a")).length, 0);
    await store.close();

    const db = new DatabaseSync(path, { readOnly: true });
    const eventCount = db.prepare("SELECT count(*) AS count FROM substrate_events").get() as { count: number };
    const relationCount = db.prepare("SELECT count(*) AS count FROM memory_relations").get() as { count: number };
    const feedbackCount = db.prepare("SELECT count(*) AS count FROM memory_feedback").get() as { count: number };
    db.close();
    assert.equal(eventCount.count, 1);
    assert.equal(relationCount.count, 0);
    assert.equal(feedbackCount.count, 0);
  });
});

test("sqlite adapter serializes concurrent writes with contiguous event sequences", async () => {
  await withSqlite(async (path) => {
    const store = await openSqliteAionisSubstrate({ path });
    await Promise.all(Array.from({ length: 25 }, (_, index) =>
      store.putNode({
        id: `node-${index}`,
        scope: "repo-a",
        kind: "fact",
        summary: `Concurrent memory ${index}.`,
        lifecycle: "candidate",
        authority: "unknown",
        confidence: 0.5,
      })));

    const events = await store.listEvents();
    assert.equal(events.length, 25);
    assert.deepEqual(events.map((event) => event.sequence), Array.from({ length: 25 }, (_, index) => index + 1));
    assert.equal((await store.listNodes("repo-a")).length, 25);
    await store.close();
  });
});

test("file and sqlite adapters compile the same admission buckets for the same evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aionis-substrate-parity-"));
  const sqliteDir = await mkdtemp(join(tmpdir(), "aionis-substrate-sqlite-parity-"));
  try {
    const fileStore = await openFileAionisSubstrate({ dir });
    const sqliteStore = await openSqliteAionisSubstrate({ path: join(sqliteDir, "substrate.sqlite") });
    await seedGovernedScenario(fileStore);
    await seedGovernedScenario(sqliteStore);

    const fileContext = await fileStore.compileContext({ scope: "repo-a" });
    const sqliteContext = await sqliteStore.compileContext({ scope: "repo-a" });

    assert.deepEqual(sqliteContext.use_now.map((item) => item.id), fileContext.use_now.map((item) => item.id));
    assert.deepEqual(sqliteContext.do_not_use.map((item) => item.id), fileContext.do_not_use.map((item) => item.id));
    assert.deepEqual(sqliteContext.rehydrate.map((item) => item.id), fileContext.rehydrate.map((item) => item.id));

    await fileStore.close();
    await sqliteStore.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(sqliteDir, { recursive: true, force: true });
  }
});
