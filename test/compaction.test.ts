import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  exportAionisSubstrateBackup,
  openFileAionisSubstrate,
  openSqliteAionisSubstrate,
  restoreAionisSubstrateBackupToFile,
  restoreAionisSubstrateBackupToSqlite,
  verifyAionisSubstrateBackup,
  type AionisCompiledContext,
  type AionisSubstrate,
} from "../src/index.ts";

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function seedCompactionScenario(store: AionisSubstrate): Promise<AionisCompiledContext> {
  await store.putNode({
    id: "current-route",
    scope: "repo-a",
    kind: "execution",
    summary: "Current route uses src/runtime.ts after verifier passed.",
    lifecycle: "active",
    authority: "trusted",
    confidence: 0.96,
    targetFiles: ["src/runtime.ts"],
  });
  await store.putNode({
    id: "stale-route",
    scope: "repo-a",
    kind: "execution",
    summary: "Stale route used src/legacy.ts before verifier failed.",
    lifecycle: "active",
    authority: "trusted",
    confidence: 0.72,
    targetFiles: ["src/legacy.ts"],
  });
  await store.putNode({
    id: "raw-trace",
    scope: "repo-a",
    kind: "trace_pointer",
    summary: "Raw terminal trace from the previous run.",
    lifecycle: "archived",
    authority: "trusted",
    confidence: 0.82,
    payloadRef: "file://trace.log",
  });
  await store.putRelation({
    id: "current-supersedes-stale",
    scope: "repo-a",
    kind: "supersedes",
    sourceId: "current-route",
    targetId: "stale-route",
    confidence: 0.91,
    reasons: ["new verifier evidence replaced the stale route"],
  });
  await store.recordFeedback({
    id: "current-positive",
    scope: "repo-a",
    memoryId: "current-route",
    outcome: "positive",
    strength: "strong",
    runId: "run-1",
    evidenceRef: "trace://run-1/verifier",
  });
  return await store.compileContext({ scope: "repo-a", query: "continue implementation" });
}

function assertScenarioContext(context: AionisCompiledContext): void {
  assert.deepEqual(context.use_now.map((node) => node.id), ["current-route"]);
  assert.deepEqual(context.do_not_use.map((node) => node.id), ["stale-route"]);
  assert.deepEqual(context.rehydrate.map((node) => node.id), ["raw-trace"]);
}

test("file adapter compacts event history into a checkpoint without changing governed state", async () => {
  await withTempDir("aionis-substrate-file-compact-", async (dir) => {
    const store = await openFileAionisSubstrate({ dir });
    assertScenarioContext(await seedCompactionScenario(store));

    const report = await store.compact();
    assert.equal(report.compacted, true);
    assert.equal(report.before.eventCount, 6);
    assert.equal(report.before.lastSequence, 6);
    assert.equal(report.after.eventCount, 1);
    assert.equal(report.after.lastSequence, 1);
    assert.ok(report.after.checkpointEventId);

    const events = await store.listEvents();
    assert.equal(events.length, 1);
    const checkpoint = events[0];
    assert.equal(checkpoint?.type, "substrate.checkpoint.created");
    if (checkpoint?.type !== "substrate.checkpoint.created") throw new Error("expected checkpoint event");
    assert.equal(checkpoint.payload.coveredEventCount, 6);
    assert.equal(checkpoint.payload.coveredLastSequence, 6);
    assert.equal(checkpoint.payload.coveredEventsSha256, report.before.eventsSha256);

    const backup = await exportAionisSubstrateBackup(store, { createdAt: "2026-06-25T00:00:00.000Z" });
    assert.equal(backup.eventCount, 1);
    assert.equal(backup.lastSequence, 1);
    assert.equal(verifyAionisSubstrateBackup(backup).ok, true);

    const restoredFileDir = join(dir, "restored-file");
    await restoreAionisSubstrateBackupToFile(backup, restoredFileDir);
    const restoredFile = await openFileAionisSubstrate({ dir: restoredFileDir });
    assertScenarioContext(await restoredFile.compileContext({ scope: "repo-a" }));
    await restoredFile.close();

    const restoredSqlitePath = join(dir, "restored.sqlite");
    await restoreAionisSubstrateBackupToSqlite(backup, restoredSqlitePath);
    const restoredSqlite = await openSqliteAionisSubstrate({ path: restoredSqlitePath });
    assertScenarioContext(await restoredSqlite.compileContext({ scope: "repo-a" }));
    await restoredSqlite.close();

    await store.close();
    const reopened = await openFileAionisSubstrate({ dir });
    assert.equal((await reopened.getNode("repo-a", "current-route"))?.summary, "Current route uses src/runtime.ts after verifier passed.");
    assert.deepEqual(await reopened.getStoreInfo(), {
      adapter: "file",
      schemaVersion: 1,
      lastSequence: 1,
      eventCount: 1,
    });
    await reopened.putNode({
      id: "post-compact",
      scope: "repo-a",
      kind: "fact",
      summary: "New writes continue after the checkpoint sequence.",
    });
    assert.equal((await reopened.listEvents()).at(-1)?.sequence, 2);
    await reopened.close();
  });
});

test("sqlite adapter compacts event history into a checkpoint without changing governed state", async () => {
  await withTempDir("aionis-substrate-sqlite-compact-", async (dir) => {
    const path = join(dir, "substrate.sqlite");
    let store = await openSqliteAionisSubstrate({ path });
    assertScenarioContext(await seedCompactionScenario(store));

    const report = await store.compact();
    assert.equal(report.compacted, true);
    assert.equal(report.before.eventCount, 6);
    assert.equal(report.before.lastSequence, 6);
    assert.equal(report.after.eventCount, 1);
    assert.equal(report.after.lastSequence, 1);
    assert.ok(report.after.checkpointEventId);

    const events = await store.listEvents();
    assert.equal(events.length, 1);
    const checkpoint = events[0];
    assert.equal(checkpoint?.type, "substrate.checkpoint.created");
    if (checkpoint?.type !== "substrate.checkpoint.created") throw new Error("expected checkpoint event");
    assert.equal(checkpoint.payload.coveredEventCount, 6);
    assert.equal(checkpoint.payload.coveredLastSequence, 6);
    assert.equal(checkpoint.payload.coveredEventsSha256, report.before.eventsSha256);

    await store.close();
    store = await openSqliteAionisSubstrate({ path });
    assert.equal((await store.getNode("repo-a", "current-route"))?.summary, "Current route uses src/runtime.ts after verifier passed.");
    assert.deepEqual(await store.getStoreInfo(), {
      adapter: "sqlite",
      schemaVersion: 1,
      lastSequence: 1,
      eventCount: 1,
    });
    await store.putNode({
      id: "post-compact",
      scope: "repo-a",
      kind: "fact",
      summary: "New writes continue after the checkpoint sequence.",
    });
    assert.equal((await store.listEvents()).at(-1)?.sequence, 2);
    await store.close();
  });
});
