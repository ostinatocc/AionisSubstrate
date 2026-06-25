import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
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
    await store.close();
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
