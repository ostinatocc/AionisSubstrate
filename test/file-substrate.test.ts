import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { openFileAionisSubstrate } from "../src/index.ts";

async function withStore<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "aionis-substrate-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("embedded substrate persists append-only evidence and rebuilds the read model on reopen", async () => {
  await withStore(async (dir) => {
    const store = await openFileAionisSubstrate({ dir });
    await store.putNode({
      id: "current-route",
      scope: "repo-a",
      kind: "execution",
      summary: "Current route is src/runtime.ts after verifier passed.",
      lifecycle: "active",
      authority: "trusted",
      confidence: 0.91,
      targetFiles: ["src/runtime.ts"],
    });
    await store.recordFeedback({
      id: "fb-1",
      scope: "repo-a",
      memoryId: "current-route",
      outcome: "positive",
      strength: "strong",
      runId: "run-1",
      evidenceRef: "trace://run-1/verifier",
    });
    await store.close();

    const reopened = await openFileAionisSubstrate({ dir });
    const node = await reopened.getNode("repo-a", "current-route");
    assert.equal(node?.summary, "Current route is src/runtime.ts after verifier passed.");

    const events = await reopened.listEvents();
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((event) => event.sequence), [1, 2]);
    assert.deepEqual(await reopened.getStoreInfo(), {
      adapter: "file",
      schemaVersion: 1,
      lastSequence: 2,
      eventCount: 2,
    });

    const eventLog = await readFile(join(dir, "events.jsonl"), "utf8");
    assert.match(eventLog, /memory\.node\.upsert/);
    assert.match(eventLog, /memory\.feedback\.recorded/);
    const snapshot = JSON.parse(await readFile(join(dir, "snapshot.json"), "utf8")) as { schemaVersion?: number };
    assert.equal(snapshot.schemaVersion, 1);
  });
});

test("superseding relation blocks stale memory while preserving the newer active route", async () => {
  await withStore(async (dir) => {
    const store = await openFileAionisSubstrate({ dir });
    await store.putNode({
      id: "old-route",
      scope: "repo-a",
      kind: "procedure",
      summary: "Use the old retry path in src/legacy.ts.",
      lifecycle: "active",
      authority: "trusted",
      confidence: 0.8,
      targetFiles: ["src/legacy.ts"],
    });
    await store.putNode({
      id: "new-route",
      scope: "repo-a",
      kind: "procedure",
      summary: "Use the new verifier-safe path in src/runtime.ts.",
      lifecycle: "active",
      authority: "trusted",
      confidence: 0.93,
      targetFiles: ["src/runtime.ts"],
    });
    const relation = await store.putRelation({
      id: "rel-new-supersedes-old",
      scope: "repo-a",
      kind: "supersedes",
      sourceId: "new-route",
      targetId: "old-route",
      confidence: 0.86,
      reasons: ["newer execution evidence replaced the old route"],
    });

    const context = await store.compileContext({ scope: "repo-a", query: "continue the runtime fix" });
    assert.deepEqual(context.use_now.map((node) => node.id), ["new-route"]);
    assert.deepEqual(context.do_not_use.map((node) => node.id), ["old-route"]);

    const blocked = context.decision_trace.decisions.find((decision) => decision.memoryId === "old-route");
    assert.equal(blocked?.action, "do_not_use");
    assert.equal(blocked?.reasons[0]?.relationId, relation.id);
  });
});

test("archived evidence becomes a rehydrate hook rather than direct prompt context", async () => {
  await withStore(async (dir) => {
    const store = await openFileAionisSubstrate({ dir });
    await store.putNode({
      id: "raw-trace",
      scope: "repo-a",
      kind: "trace_pointer",
      summary: "Full terminal trace from the previous run.",
      lifecycle: "archived",
      authority: "trusted",
      confidence: 0.88,
      payloadRef: "file://traces/run-7.log",
    });

    const context = await store.compileContext({ scope: "repo-a", query: "show raw evidence if needed" });
    assert.deepEqual(context.use_now.map((node) => node.id), []);
    assert.deepEqual(context.rehydrate.map((node) => node.id), ["raw-trace"]);
    assert.equal(context.decision_trace.decisions[0]?.action, "rehydrate");
  });
});

test("controlled forgetting is a lifecycle transition, not deletion", async () => {
  await withStore(async (dir) => {
    const store = await openFileAionisSubstrate({ dir });
    await store.putNode({
      id: "bad-pattern",
      scope: "repo-a",
      kind: "procedure",
      summary: "This procedure should no longer affect the agent.",
      lifecycle: "active",
      authority: "trusted",
      confidence: 0.7,
    });
    await store.transitionLifecycle({
      scope: "repo-a",
      memoryId: "bad-pattern",
      lifecycle: "suppressed",
      authority: "rejected",
      confidence: 0.2,
      reason: "negative feedback crossed suppression threshold",
    });

    const node = await store.getNode("repo-a", "bad-pattern");
    assert.equal(node?.lifecycle, "suppressed");

    const context = await store.compileContext({ scope: "repo-a" });
    assert.deepEqual(context.do_not_use.map((item) => item.id), ["bad-pattern"]);
    assert.ok((await store.listEvents()).some((event) => event.type === "memory.lifecycle.transition"));
  });
});

test("failed lifecycle transition does not persist a corrupt event", async () => {
  await withStore(async (dir) => {
    const store = await openFileAionisSubstrate({ dir });
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
      store.transitionLifecycle({
        scope: "repo-a",
        memoryId: "missing",
        lifecycle: "suppressed",
        authority: "rejected",
        confidence: 0,
        reason: "should not be written",
      }),
      /cannot transition missing memory node: missing/,
    );

    const eventLog = await readFile(join(dir, "events.jsonl"), "utf8");
    const lines = eventLog.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /memory\.node\.upsert/);

    await store.close();
    const reopened = await openFileAionisSubstrate({ dir });
    assert.equal((await reopened.listEvents()).length, 1);
    assert.equal((await reopened.getNode("repo-a", "existing"))?.id, "existing");
  });
});

test("failed relation and feedback writes do not persist corrupt events", async () => {
  await withStore(async (dir) => {
    const store = await openFileAionisSubstrate({ dir });
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

    const eventLog = await readFile(join(dir, "events.jsonl"), "utf8");
    assert.equal(eventLog.trim().split("\n").length, 1);
    assert.equal((await store.listRelations("repo-a")).length, 0);
    assert.equal((await store.listEvents()).length, 1);

    await store.close();
    const reopened = await openFileAionisSubstrate({ dir });
    assert.equal((await reopened.listEvents()).length, 1);
    assert.equal((await reopened.listRelations("repo-a")).length, 0);
    assert.equal((await reopened.getNode("repo-a", "existing"))?.id, "existing");
  });
});

test("file adapter rebuilds the snapshot from the append-only event log", async () => {
  await withStore(async (dir) => {
    let store = await openFileAionisSubstrate({ dir });
    await store.putNode({
      id: "current",
      scope: "repo-a",
      kind: "execution",
      summary: "Current state survives snapshot loss.",
      lifecycle: "active",
      authority: "trusted",
      confidence: 0.9,
    });
    await store.close();

    await rm(join(dir, "snapshot.json"), { force: true });

    store = await openFileAionisSubstrate({ dir });
    assert.equal((await store.getNode("repo-a", "current"))?.summary, "Current state survives snapshot loss.");
    assert.equal((await store.listEvents()).length, 1);
    assert.match(await readFile(join(dir, "snapshot.json"), "utf8"), /current/);
  });
});

test("file adapter serializes concurrent writes with contiguous event sequences", async () => {
  await withStore(async (dir) => {
    const store = await openFileAionisSubstrate({ dir });
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
  });
});

test("scope isolation keeps relations and admission decisions local to a scope", async () => {
  await withStore(async (dir) => {
    const store = await openFileAionisSubstrate({ dir });
    await store.putNode({
      id: "shared-id",
      scope: "repo-a",
      kind: "fact",
      summary: "Repo A fact.",
      lifecycle: "active",
      authority: "trusted",
      confidence: 0.8,
    });
    await store.putNode({
      id: "shared-id",
      scope: "repo-b",
      kind: "fact",
      summary: "Repo B fact.",
      lifecycle: "active",
      authority: "trusted",
      confidence: 0.8,
    });
    await store.putNode({
      id: "repo-a-new",
      scope: "repo-a",
      kind: "fact",
      summary: "Repo A newer fact.",
      lifecycle: "active",
      authority: "trusted",
      confidence: 0.9,
    });
    await store.putRelation({
      scope: "repo-a",
      kind: "invalidates",
      sourceId: "repo-a-new",
      targetId: "shared-id",
      confidence: 0.9,
      reasons: ["repo-a evidence only"],
    });

    const repoA = await store.compileContext({ scope: "repo-a" });
    const repoB = await store.compileContext({ scope: "repo-b" });
    assert.deepEqual(repoA.do_not_use.map((node) => node.id), ["shared-id"]);
    assert.deepEqual(repoB.use_now.map((node) => node.id), ["shared-id"]);
  });
});
