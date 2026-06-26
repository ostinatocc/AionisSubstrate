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
  writeAionisSubstrateBackupFile,
  readAionisSubstrateBackupFile,
  type AionisSubstrate,
  type AionisSubstrateBackup,
} from "../src/index.ts";
import { checksumAionisEvents } from "../src/event-log.ts";

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function seedStore(store: AionisSubstrate): Promise<void> {
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
    summary: "Old route used src/legacy.ts before the verifier failed.",
    lifecycle: "active",
    authority: "trusted",
    confidence: 0.72,
    targetFiles: ["src/legacy.ts"],
  });
  await store.putNode({
    id: "raw-trace",
    scope: "repo-a",
    kind: "trace_pointer",
    summary: "Raw terminal trace for the run.",
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
    confidence: 0.9,
    reasons: ["new verifier evidence replaced the old route"],
  });
  await store.recordFeedback({
    id: "fb-current-positive",
    scope: "repo-a",
    memoryId: "current-route",
    outcome: "positive",
    strength: "strong",
    runId: "run-1",
    evidenceRef: "trace://run-1/verifier",
  });
  await store.compileContext({ scope: "repo-a", query: "continue implementation" });
}

test("backup export verifies and restores exact event evidence to file and SQLite stores", async () => {
  await withTempDir("aionis-substrate-backup-", async (dir) => {
    const source = await openSqliteAionisSubstrate({ path: join(dir, "source.sqlite") });
    await seedStore(source);

    const backup = await exportAionisSubstrateBackup(source, { createdAt: "2026-06-25T00:00:00.000Z" });
    const integrity = verifyAionisSubstrateBackup(backup);
    assert.equal(integrity.ok, true);
    assert.equal(backup.eventCount, 6);
    assert.equal(backup.lastSequence, 6);
    assert.equal(integrity.snapshot?.nodes.length, 3);

    const backupPath = join(dir, "backup.json");
    await writeAionisSubstrateBackupFile(backupPath, backup);
    const backupFromDisk = await readAionisSubstrateBackupFile(backupPath);
    assert.equal(verifyAionisSubstrateBackup(backupFromDisk).ok, true);

    const fileDir = join(dir, "restored-file");
    await restoreAionisSubstrateBackupToFile(backupFromDisk, fileDir);
    const restoredFile = await openFileAionisSubstrate({ dir: fileDir });
    assert.deepEqual((await restoredFile.listEvents()).map((event) => event.id), backup.events.map((event) => event.id));
    assert.deepEqual((await restoredFile.listEvents()).map((event) => event.sequence), [1, 2, 3, 4, 5, 6]);
    const fileContext = await restoredFile.compileContext({ scope: "repo-a" });
    assert.deepEqual(fileContext.use_now.map((node) => node.id), ["current-route"]);
    assert.deepEqual(fileContext.do_not_use.map((node) => node.id), ["stale-route"]);
    assert.deepEqual(fileContext.rehydrate.map((node) => node.id), ["raw-trace"]);

    const sqlitePath = join(dir, "restored.sqlite");
    await restoreAionisSubstrateBackupToSqlite(backupFromDisk, sqlitePath);
    const restoredSqlite = await openSqliteAionisSubstrate({ path: sqlitePath });
    assert.deepEqual((await restoredSqlite.listEvents()).map((event) => event.id), backup.events.map((event) => event.id));
    assert.deepEqual((await restoredSqlite.listEvents()).map((event) => event.sequence), [1, 2, 3, 4, 5, 6]);
    const sqliteContext = await restoredSqlite.compileContext({ scope: "repo-a" });
    assert.deepEqual(sqliteContext.use_now.map((node) => node.id), ["current-route"]);
    assert.deepEqual(sqliteContext.do_not_use.map((node) => node.id), ["stale-route"]);
    assert.deepEqual(sqliteContext.rehydrate.map((node) => node.id), ["raw-trace"]);

    await restoredSqlite.putNode({
      id: "after-restore",
      scope: "repo-a",
      kind: "fact",
      summary: "A post-restore write continues the event sequence.",
    });
    assert.equal((await restoredSqlite.listEvents()).at(-1)?.sequence, 8);

    await source.close();
    await restoredFile.close();
    await restoredSqlite.close();
  });
});

test("backup restore rejects tampered events and non-empty targets", async () => {
  await withTempDir("aionis-substrate-backup-negative-", async (dir) => {
    const source = await openFileAionisSubstrate({ dir: join(dir, "source") });
    await seedStore(source);
    const backup = await exportAionisSubstrateBackup(source);

    const tampered: AionisSubstrateBackup = JSON.parse(JSON.stringify(backup)) as AionisSubstrateBackup;
    const firstNode = tampered.events.find((event) => event.type === "memory.node.upsert");
    if (firstNode?.type === "memory.node.upsert") firstNode.payload.summary = "tampered";
    const integrity = verifyAionisSubstrateBackup(tampered);
    assert.equal(integrity.ok, false);
    assert.match(integrity.errors.join("\n"), /eventsSha256 mismatch/);
    await assert.rejects(
      restoreAionisSubstrateBackupToFile(tampered, join(dir, "tampered-restore")),
      /eventsSha256 mismatch/,
    );

    const fileTarget = join(dir, "file-target");
    await restoreAionisSubstrateBackupToFile(backup, fileTarget);
    await assert.rejects(
      restoreAionisSubstrateBackupToFile(backup, fileTarget),
      /restore target file store is not empty/,
    );

    const sqliteTarget = join(dir, "sqlite-target.sqlite");
    await restoreAionisSubstrateBackupToSqlite(backup, sqliteTarget);
    await assert.rejects(
      restoreAionisSubstrateBackupToSqlite(backup, sqliteTarget),
      /restore target SQLite store already exists/,
    );

    await source.close();
  });
});

test("backup integrity rejects decision traces that reference missing memory nodes", async () => {
  await withTempDir("aionis-substrate-backup-decision-negative-", async (dir) => {
    const source = await openFileAionisSubstrate({ dir: join(dir, "source") });
    await seedStore(source);
    const backup = await exportAionisSubstrateBackup(source);

    const corrupt: AionisSubstrateBackup = JSON.parse(JSON.stringify(backup)) as AionisSubstrateBackup;
    const decisionEvent = corrupt.events.find((event) => event.type === "memory.decision.recorded");
    if (decisionEvent?.type !== "memory.decision.recorded") throw new Error("expected decision event");
    decisionEvent.payload.decisions[0] = {
      ...decisionEvent.payload.decisions[0]!,
      memoryId: "missing-decision-target",
    };
    corrupt.checksum.eventsSha256 = checksumAionisEvents(corrupt.events);

    const integrity = verifyAionisSubstrateBackup(corrupt);
    assert.equal(integrity.ok, false);
    assert.match(integrity.errors.join("\n"), /cannot record decision for missing memory node: missing-decision-target/);
    await assert.rejects(
      restoreAionisSubstrateBackupToFile(corrupt, join(dir, "corrupt-decision-file")),
      /cannot record decision for missing memory node: missing-decision-target/,
    );
    await assert.rejects(
      restoreAionisSubstrateBackupToSqlite(corrupt, join(dir, "corrupt-decision.sqlite")),
      /cannot record decision for missing memory node: missing-decision-target/,
    );

    await source.close();
  });
});
