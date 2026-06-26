import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { openFileAionisSubstrate, openSqliteAionisSubstrate, type AionisSubstrate } from "../src/index.ts";

async function withStores<T>(fn: (stores: { file: AionisSubstrate; sqlite: AionisSubstrate }) => Promise<T>): Promise<T> {
  const fileDir = await mkdtemp(join(tmpdir(), "aionis-substrate-search-file-"));
  const sqliteDir = await mkdtemp(join(tmpdir(), "aionis-substrate-search-sqlite-"));
  const stores: AionisSubstrate[] = [];
  try {
    const file = await openFileAionisSubstrate({ dir: fileDir });
    const sqlite = await openSqliteAionisSubstrate({ path: join(sqliteDir, "substrate.sqlite") });
    stores.push(file, sqlite);
    return await fn({ file, sqlite });
  } finally {
    await Promise.all(stores.map((store) => store.close().catch(() => undefined)));
    await rm(fileDir, { recursive: true, force: true });
    await rm(sqliteDir, { recursive: true, force: true });
  }
}

async function seedSearchScenario(store: AionisSubstrate): Promise<void> {
  await store.putNode({
    id: "current-route",
    scope: "repo-a",
    kind: "procedure",
    title: "Current runtime route",
    summary: "Use src/runtime.ts after verifier passed and checkpoint compaction completed.",
    lifecycle: "active",
    authority: "trusted",
    confidence: 0.95,
    targetFiles: ["src/runtime.ts"],
    agentId: "agent-1",
    teamId: "team-a",
    metadata: { source: "observe", verifier: "npm test passed" },
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  });
  await store.putNode({
    id: "stale-route",
    scope: "repo-a",
    kind: "procedure",
    title: "Legacy retry path",
    summary: "Old retry path in src/legacy.ts was retained as evidence.",
    lifecycle: "active",
    authority: "trusted",
    confidence: 0.7,
    targetFiles: ["src/legacy.ts"],
    agentId: "agent-1",
    teamId: "team-a",
    createdAt: "2026-06-01T00:01:00.000Z",
    updatedAt: "2026-06-01T00:01:00.000Z",
  });
  await store.putNode({
    id: "review-preference",
    scope: "repo-a",
    kind: "preference",
    title: "Reviewer preference",
    summary: "Reviewer prefers minimal diffs when a fix is already localized.",
    lifecycle: "active",
    authority: "advisory",
    confidence: 0.6,
    agentId: "agent-1",
    teamId: "team-a",
    createdAt: "2026-06-01T00:02:00.000Z",
    updatedAt: "2026-06-01T00:02:00.000Z",
  });
  await store.putNode({
    id: "raw-trace",
    scope: "repo-a",
    kind: "trace_pointer",
    title: "Raw runtime verifier trace",
    summary: "Raw terminal trace is available for payload rehydration.",
    lifecycle: "archived",
    authority: "trusted",
    confidence: 0.88,
    payloadRef: "file://traces/runtime-verifier.log",
    createdAt: "2026-06-01T00:03:00.000Z",
    updatedAt: "2026-06-01T00:03:00.000Z",
  });
  await store.putNode({
    id: "other-scope-runtime",
    scope: "repo-b",
    kind: "procedure",
    title: "Runtime route in another scope",
    summary: "This memory mentions runtime but must not appear in repo-a search.",
    lifecycle: "active",
    authority: "trusted",
    confidence: 0.99,
    targetFiles: ["src/runtime.ts"],
    createdAt: "2026-06-01T00:04:00.000Z",
    updatedAt: "2026-06-01T00:04:00.000Z",
  });
}

async function seedBoth(stores: { file: AionisSubstrate; sqlite: AionisSubstrate }): Promise<void> {
  await seedSearchScenario(stores.file);
  await seedSearchScenario(stores.sqlite);
}

test("file and sqlite search return identical scoped filtered results", async () => {
  await withStores(async (stores) => {
    await seedBoth(stores);
    const input = {
      scope: "repo-a",
      query: "runtime verifier",
      lifecycle: ["active" as const],
      authority: ["trusted" as const],
      targetFiles: ["src/runtime.ts"],
      agentId: "agent-1",
      teamId: "team-a",
      minConfidence: 0.8,
      limit: 5,
    };

    const fileResults = await stores.file.searchNodes(input);
    const sqliteResults = await stores.sqlite.searchNodes(input);

    assert.deepEqual(fileResults.map((result) => result.node.id), ["current-route"]);
    assert.deepEqual(sqliteResults.map((result) => result.node.id), fileResults.map((result) => result.node.id));
    assert.deepEqual(sqliteResults.map((result) => result.score), fileResults.map((result) => result.score));
    assert.deepEqual(
      sqliteResults[0]?.reasons.map((reason) => reason.code),
      fileResults[0]?.reasons.map((reason) => reason.code),
    );
    assert.ok(fileResults[0]?.reasons.some((reason) => reason.code === "query_match"));
    assert.ok(fileResults[0]?.reasons.some((reason) => reason.code === "target_file_filter"));
  });
});

test("search without query ranks filtered nodes deterministically", async () => {
  await withStores(async (stores) => {
    await seedBoth(stores);
    const input = {
      scope: "repo-a",
      lifecycle: ["active" as const],
      authority: ["trusted" as const],
      limit: 10,
    };

    const fileResults = await stores.file.searchNodes(input);
    const sqliteResults = await stores.sqlite.searchNodes(input);

    assert.deepEqual(fileResults.map((result) => result.node.id), ["current-route", "stale-route"]);
    assert.deepEqual(sqliteResults.map((result) => result.node.id), fileResults.map((result) => result.node.id));
  });
});

test("target file search uses exact normalized filters instead of substring leaks", async () => {
  await withStores(async (stores) => {
    await seedBoth(stores);

    const exact = await stores.file.searchNodes({
      scope: "repo-a",
      targetFiles: ["src/runtime.ts"],
      limit: 10,
    });
    const substring = await stores.file.searchNodes({
      scope: "repo-a",
      targetFiles: ["runtime"],
      limit: 10,
    });

    assert.deepEqual(exact.map((result) => result.node.id), ["current-route"]);
    assert.deepEqual(substring.map((result) => result.node.id), []);
  });
});

test("search is read-only for both adapters", async () => {
  await withStores(async (stores) => {
    await seedBoth(stores);
    const before = {
      file: await stores.file.listEvents(),
      sqlite: await stores.sqlite.listEvents(),
    };

    await stores.file.searchNodes({ scope: "repo-a", query: "runtime", limit: 5 });
    await stores.sqlite.searchNodes({ scope: "repo-a", query: "runtime", limit: 5 });

    assert.deepEqual(await stores.file.listEvents(), before.file);
    assert.deepEqual(await stores.sqlite.listEvents(), before.sqlite);
  });
});

test("search validates query contract inputs", async () => {
  await withStores(async (stores) => {
    await seedBoth(stores);

    await assert.rejects(stores.file.searchNodes({ scope: "   " }), /scope is required/);
    await assert.rejects(stores.file.searchNodes({ scope: "repo-a", limit: 0 }), /limit must be a positive integer/);
    await assert.rejects(
      stores.file.searchNodes({ scope: "repo-a", minConfidence: 1.1 }),
      /minConfidence must be between 0 and 1/,
    );
  });
});
