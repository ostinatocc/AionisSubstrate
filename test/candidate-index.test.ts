import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  createMemoryCandidateIndex,
  openFileAionisSubstrate,
  openSqliteAionisSubstrate,
  type AionisCandidateIndex,
  type AionisCandidateIndexSearchResult,
  type AionisMemoryNode,
  type AionisSubstrate,
} from "../src/index.ts";

async function withIndexedStores<T>(
  fn: (stores: {
    file: AionisSubstrate;
    sqlite: AionisSubstrate;
    fileIndex: AionisCandidateIndex;
    sqliteIndex: AionisCandidateIndex;
  }) => Promise<T>,
): Promise<T> {
  const fileDir = await mkdtemp(join(tmpdir(), "aionis-substrate-index-file-"));
  const sqliteDir = await mkdtemp(join(tmpdir(), "aionis-substrate-index-sqlite-"));
  const stores: AionisSubstrate[] = [];
  try {
    const fileIndex = createMemoryCandidateIndex();
    const sqliteIndex = createMemoryCandidateIndex();
    const file = await openFileAionisSubstrate({ dir: fileDir, candidateIndex: fileIndex });
    const sqlite = await openSqliteAionisSubstrate({ path: join(sqliteDir, "substrate.sqlite"), candidateIndex: sqliteIndex });
    stores.push(file, sqlite);
    return await fn({ file, sqlite, fileIndex, sqliteIndex });
  } finally {
    await Promise.all(stores.map((store) => store.close().catch(() => undefined)));
    await rm(fileDir, { recursive: true, force: true });
    await rm(sqliteDir, { recursive: true, force: true });
  }
}

function node(input: Partial<AionisMemoryNode> & Pick<AionisMemoryNode, "id" | "summary">): AionisMemoryNode {
  return {
    id: input.id,
    scope: input.scope ?? "repo-a",
    kind: input.kind ?? "procedure",
    title: input.title ?? null,
    summary: input.summary,
    lifecycle: input.lifecycle ?? "active",
    authority: input.authority ?? "trusted",
    confidence: input.confidence ?? 0.9,
    targetFiles: input.targetFiles ?? ["src/runtime.ts"],
    payloadRef: input.payloadRef ?? null,
    agentId: input.agentId ?? null,
    teamId: input.teamId ?? null,
    metadata: input.metadata ?? {},
    createdAt: input.createdAt ?? "2026-06-01T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-06-01T00:00:00.000Z",
  };
}

function fixedCandidateIndex(results: AionisCandidateIndexSearchResult[]): AionisCandidateIndex {
  return {
    async upsertNode() {
      return undefined;
    },
    async deleteNode() {
      return undefined;
    },
    async search(input) {
      return results
        .filter((result) => result.scope === input.scope)
        .slice(0, input.limit ?? results.length);
    },
    async rebuild(nodes) {
      return {
        ok: true,
        sourceCount: nodes.length,
        indexedCount: nodes.length,
        missingNodeIds: [],
        orphanNodeIds: [],
        staleNodeIds: [],
      };
    },
    async verify(nodes) {
      return {
        ok: true,
        sourceCount: nodes.length,
        indexedCount: nodes.length,
        missingNodeIds: [],
        orphanNodeIds: [],
        staleNodeIds: [],
      };
    },
  };
}

async function seedIndexedScenario(store: AionisSubstrate): Promise<void> {
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
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  });
  await store.putNode({
    id: "legacy-route",
    scope: "repo-a",
    kind: "procedure",
    title: "Legacy retry path",
    summary: "Old retry path in src/legacy.ts was retained as evidence.",
    lifecycle: "active",
    authority: "trusted",
    confidence: 0.7,
    targetFiles: ["src/legacy.ts"],
    createdAt: "2026-06-01T00:01:00.000Z",
    updatedAt: "2026-06-01T00:01:00.000Z",
  });
  await store.putNode({
    id: "other-scope-route",
    scope: "repo-b",
    kind: "procedure",
    title: "Runtime route in another repo",
    summary: "This route must not leak into repo-a candidate searches.",
    lifecycle: "active",
    authority: "trusted",
    confidence: 0.99,
    targetFiles: ["src/runtime.ts"],
    createdAt: "2026-06-01T00:02:00.000Z",
    updatedAt: "2026-06-01T00:02:00.000Z",
  });
}

test("candidate index write-through preserves file and sqlite search parity", async () => {
  await withIndexedStores(async ({ file, sqlite, fileIndex, sqliteIndex }) => {
    await seedIndexedScenario(file);
    await seedIndexedScenario(sqlite);

    const input = {
      scope: "repo-a",
      query: "runtime verifier",
      lifecycle: ["active" as const],
      authority: ["trusted" as const],
      targetFiles: ["src/runtime.ts"],
      limit: 5,
    };
    const fileResults = await file.searchNodes(input);
    const sqliteResults = await sqlite.searchNodes(input);

    assert.deepEqual(fileResults.map((result) => result.node.id), ["current-route"]);
    assert.deepEqual(sqliteResults.map((result) => result.node.id), ["current-route"]);
    assert.ok(fileResults[0]?.reasons.some((reason) => reason.code === "candidate_index_match"));
    assert.ok(sqliteResults[0]?.reasons.some((reason) => reason.code === "candidate_index_match"));
    assert.deepEqual(await fileIndex.verify([...(await file.listNodes("repo-a")), ...(await file.listNodes("repo-b"))]), {
      ok: true,
      sourceCount: 3,
      indexedCount: 3,
      missingNodeIds: [],
      orphanNodeIds: [],
      staleNodeIds: [],
    });
    assert.deepEqual(await sqliteIndex.verify([...(await sqlite.listNodes("repo-a")), ...(await sqlite.listNodes("repo-b"))]), {
      ok: true,
      sourceCount: 3,
      indexedCount: 3,
      missingNodeIds: [],
      orphanNodeIds: [],
      staleNodeIds: [],
    });
  });
});

test("candidate index updates after lifecycle transition", async () => {
  await withIndexedStores(async ({ file, sqlite, fileIndex, sqliteIndex }) => {
    await seedIndexedScenario(file);
    await seedIndexedScenario(sqlite);

    await file.transitionLifecycle({
      scope: "repo-a",
      memoryId: "legacy-route",
      lifecycle: "suppressed",
      authority: "rejected",
      confidence: 0.2,
      reason: "legacy route failed verifier",
    });
    await sqlite.transitionLifecycle({
      scope: "repo-a",
      memoryId: "legacy-route",
      lifecycle: "suppressed",
      authority: "rejected",
      confidence: 0.2,
      reason: "legacy route failed verifier",
    });

    const input = {
      scope: "repo-a",
      query: "legacy retry",
      lifecycle: ["suppressed" as const],
      authority: ["rejected" as const],
      limit: 5,
    };
    assert.deepEqual((await file.searchNodes(input)).map((result) => result.node.id), ["legacy-route"]);
    assert.deepEqual((await sqlite.searchNodes(input)).map((result) => result.node.id), ["legacy-route"]);
    assert.equal((await fileIndex.verify(await file.listNodes("repo-a"))).staleNodeIds.length, 0);
    assert.equal((await sqliteIndex.verify(await sqlite.listNodes("repo-a"))).staleNodeIds.length, 0);
  });
});

test("candidate index rebuilds from persisted stores on open", async () => {
  const fileDir = await mkdtemp(join(tmpdir(), "aionis-substrate-index-rebuild-file-"));
  const sqliteDir = await mkdtemp(join(tmpdir(), "aionis-substrate-index-rebuild-sqlite-"));
  try {
    const file = await openFileAionisSubstrate({ dir: fileDir });
    const sqlite = await openSqliteAionisSubstrate({ path: join(sqliteDir, "substrate.sqlite") });
    await seedIndexedScenario(file);
    await seedIndexedScenario(sqlite);
    await file.close();
    await sqlite.close();

    const fileIndex = createMemoryCandidateIndex();
    const sqliteIndex = createMemoryCandidateIndex();
    const reopenedFile = await openFileAionisSubstrate({ dir: fileDir, candidateIndex: fileIndex });
    const reopenedSqlite = await openSqliteAionisSubstrate({ path: join(sqliteDir, "substrate.sqlite"), candidateIndex: sqliteIndex });
    try {
      assert.deepEqual(await fileIndex.verify([...(await reopenedFile.listNodes("repo-a")), ...(await reopenedFile.listNodes("repo-b"))]), {
        ok: true,
        sourceCount: 3,
        indexedCount: 3,
        missingNodeIds: [],
        orphanNodeIds: [],
        staleNodeIds: [],
      });
      assert.deepEqual(await sqliteIndex.verify([...(await reopenedSqlite.listNodes("repo-a")), ...(await reopenedSqlite.listNodes("repo-b"))]), {
        ok: true,
        sourceCount: 3,
        indexedCount: 3,
        missingNodeIds: [],
        orphanNodeIds: [],
        staleNodeIds: [],
      });
      assert.deepEqual((await reopenedFile.searchNodes({ scope: "repo-a", query: "checkpoint", limit: 5 })).map((result) => result.node.id), ["current-route"]);
      assert.deepEqual((await reopenedSqlite.searchNodes({ scope: "repo-a", query: "checkpoint", limit: 5 })).map((result) => result.node.id), ["current-route"]);
    } finally {
      await reopenedFile.close();
      await reopenedSqlite.close();
    }
  } finally {
    await rm(fileDir, { recursive: true, force: true });
    await rm(sqliteDir, { recursive: true, force: true });
  }
});

test("candidate index health reports missing orphan and stale entries", async () => {
  const index = createMemoryCandidateIndex([node({ id: "a", summary: "Current runtime route." })]);
  const updatedA = node({ id: "a", summary: "Updated runtime route.", updatedAt: "2026-06-01T00:01:00.000Z" });
  const b = node({ id: "b", summary: "Missing verifier path." });
  await index.upsertNode(node({ id: "orphan", summary: "Orphan route.", scope: "repo-b" }));

  const health = await index.verify([updatedA, b]);
  assert.deepEqual(health, {
    ok: false,
    sourceCount: 2,
    indexedCount: 2,
    missingNodeIds: ["b"],
    orphanNodeIds: ["orphan"],
    staleNodeIds: ["a"],
  });

  assert.deepEqual(await index.rebuild([updatedA, b]), {
    ok: true,
    sourceCount: 2,
    indexedCount: 2,
    missingNodeIds: [],
    orphanNodeIds: [],
    staleNodeIds: [],
  });
});

test("candidate index can match ordinary QA evidence fields stored in metadata", async () => {
  const index = createMemoryCandidateIndex([
    node({
      id: "qa-port-fact",
      kind: "fact",
      title: "Deployment fact",
      summary: "Compact ordinary memory with structured retrieval keys.",
      metadata: {
        answerable_facts: ["The local Aionis Runtime listens on port 3101."],
        entities: ["Aionis Runtime", "Claude Code"],
        aliases: ["local memory service"],
        topic_keys: ["deployment", "ports"],
        time_validity: { current: true, valid_from: "2026-06-29" },
        source_spans: [{ ref: "obs-1", text: "Runtime URL http://127.0.0.1:3101" }],
        embedding: [0.1, 0.2, 0.3],
      },
    }),
    node({
      id: "decoy",
      kind: "fact",
      summary: "Unrelated note about a build script.",
      metadata: {
        entities: ["Build Pipeline"],
      },
    }),
  ]);

  const results = await index.search({
    scope: "repo-a",
    query: "local memory service port 3101",
    limit: 5,
  });

  assert.deepEqual(results?.map((result) => result.memoryId), ["qa-port-fact"]);
  assert.ok(results?.[0]?.reasons.some((reason) => reason.code === "candidate_index_query_match"));
});

test("semantic candidate fusion can recover a candidate with no lexical query match", async () => {
  const fileDir = await mkdtemp(join(tmpdir(), "aionis-substrate-semantic-fusion-file-"));
  const sqliteDir = await mkdtemp(join(tmpdir(), "aionis-substrate-semantic-fusion-sqlite-"));
  const candidateResults: AionisCandidateIndexSearchResult[] = [{
    scope: "repo-a",
    memoryId: "semantic-target",
    score: 0.98,
    reasons: [{ code: "test_vector_match", detail: "semantic vector selected the target" }],
  }];
  const stores: AionisSubstrate[] = [];
  try {
    const file = await openFileAionisSubstrate({ dir: fileDir, candidateIndex: fixedCandidateIndex(candidateResults) });
    const sqlite = await openSqliteAionisSubstrate({ path: join(sqliteDir, "substrate.sqlite"), candidateIndex: fixedCandidateIndex(candidateResults) });
    stores.push(file, sqlite);
    for (const store of stores) {
      await store.putNode({
        id: "semantic-target",
        scope: "repo-a",
        kind: "procedure",
        summary: "Checkpointed sidecar skips already mirrored evidence after restart.",
        lifecycle: "active",
        authority: "trusted",
        confidence: 0.9,
      });
      await store.putNode({
        id: "lexical-decoy",
        scope: "repo-a",
        kind: "fact",
        summary: "Blue ocean marker text exists only to match the query terms.",
        lifecycle: "active",
        authority: "trusted",
        confidence: 0.7,
      });
    }

    const input = { scope: "repo-a", query: "blue ocean marker", candidateLimit: 1, limit: 2 };
    const fileResults = await file.searchNodes(input);
    const sqliteResults = await sqlite.searchNodes(input);

    assert.deepEqual(fileResults.map((result) => result.node.id), ["semantic-target", "lexical-decoy"]);
    assert.deepEqual(sqliteResults.map((result) => result.node.id), fileResults.map((result) => result.node.id));
    assert.ok(fileResults[0]?.reasons.some((reason) => reason.code === "semantic_candidate_fusion"));
    assert.ok(fileResults[0]?.reasons.some((reason) => reason.code === "test_vector_match"));
  } finally {
    await Promise.all(stores.map((store) => store.close().catch(() => undefined)));
    await rm(fileDir, { recursive: true, force: true });
    await rm(sqliteDir, { recursive: true, force: true });
  }
});

test("candidate index narrowing keeps strong lexical matches as safety set", async () => {
  const fileDir = await mkdtemp(join(tmpdir(), "aionis-substrate-lexical-safety-file-"));
  const sqliteDir = await mkdtemp(join(tmpdir(), "aionis-substrate-lexical-safety-sqlite-"));
  const candidateResults: AionisCandidateIndexSearchResult[] = [{
    scope: "repo-a",
    memoryId: "semantic-decoy",
    score: 1,
    reasons: [{ code: "test_vector_match", detail: "semantic vector selected a decoy" }],
  }];
  const stores: AionisSubstrate[] = [];
  try {
    const file = await openFileAionisSubstrate({ dir: fileDir, candidateIndex: fixedCandidateIndex(candidateResults) });
    const sqlite = await openSqliteAionisSubstrate({ path: join(sqliteDir, "substrate.sqlite"), candidateIndex: fixedCandidateIndex(candidateResults) });
    stores.push(file, sqlite);
    for (const store of stores) {
      await store.putNode({
        id: "lexical-target",
        scope: "repo-a",
        kind: "procedure",
        title: "Stable release marker",
        summary: "Stable release marker should remain discoverable even when vector preselection misses it.",
        lifecycle: "active",
        authority: "trusted",
        confidence: 0.95,
      });
      await store.putNode({
        id: "semantic-decoy",
        scope: "repo-a",
        kind: "fact",
        summary: "Unrelated side note selected by the vector candidate index.",
        lifecycle: "active",
        authority: "trusted",
        confidence: 0.8,
      });
    }

    const input = { scope: "repo-a", query: "stable release marker", candidateLimit: 1, limit: 2 };
    const fileResults = await file.searchNodes(input);
    const sqliteResults = await sqlite.searchNodes(input);

    assert.equal(fileResults[0]?.node.id, "lexical-target");
    assert.deepEqual(sqliteResults.map((result) => result.node.id), fileResults.map((result) => result.node.id));
  } finally {
    await Promise.all(stores.map((store) => store.close().catch(() => undefined)));
    await rm(fileDir, { recursive: true, force: true });
    await rm(sqliteDir, { recursive: true, force: true });
  }
});

test("semantic recall floor keeps top vector candidates when lower-ranked candidates have stronger lexical text", async () => {
  const fileDir = await mkdtemp(join(tmpdir(), "aionis-substrate-semantic-floor-file-"));
  const sqliteDir = await mkdtemp(join(tmpdir(), "aionis-substrate-semantic-floor-sqlite-"));
  const candidateResults: AionisCandidateIndexSearchResult[] = [
    {
      scope: "repo-a",
      memoryId: "semantic-target",
      score: 0.3,
      reasons: [{ code: "test_vector_match", detail: "top vector candidate" }],
    },
    ...Array.from({ length: 6 }, (_, index): AionisCandidateIndexSearchResult => ({
      scope: "repo-a",
      memoryId: `lexical-candidate-${index}`,
      score: 0.95 - (index * 0.01),
      reasons: [{ code: "test_vector_match", detail: `lower vector candidate ${index}` }],
    })),
  ];
  const stores: AionisSubstrate[] = [];
  try {
    const file = await openFileAionisSubstrate({ dir: fileDir, candidateIndex: fixedCandidateIndex(candidateResults) });
    const sqlite = await openSqliteAionisSubstrate({ path: join(sqliteDir, "substrate.sqlite"), candidateIndex: fixedCandidateIndex(candidateResults) });
    stores.push(file, sqlite);
    for (const store of stores) {
      await store.putNode({
        id: "semantic-target",
        scope: "repo-a",
        kind: "procedure",
        summary: "The semantically correct route has sparse wording.",
        lifecycle: "active",
        authority: "trusted",
        confidence: 0.9,
      });
      for (let index = 0; index < 6; index += 1) {
        await store.putNode({
          id: `lexical-candidate-${index}`,
          scope: "repo-a",
          kind: "fact",
          title: "alpha beta gamma",
          summary: `Lexical decoy ${index} repeats alpha beta gamma but is lower in semantic rank.`,
          lifecycle: "active",
          authority: "trusted",
          confidence: 0.8,
        });
      }
    }

    const input = { scope: "repo-a", query: "alpha beta gamma", candidateLimit: 7, limit: 3 };
    const fileResults = await file.searchNodes(input);
    const sqliteResults = await sqlite.searchNodes(input);

    assert.ok(fileResults.map((result) => result.node.id).includes("semantic-target"));
    assert.deepEqual(sqliteResults.map((result) => result.node.id), fileResults.map((result) => result.node.id));
    const target = fileResults.find((result) => result.node.id === "semantic-target");
    assert.ok(target?.reasons.some((reason) => reason.code === "semantic_recall_floor"));
  } finally {
    await Promise.all(stores.map((store) => store.close().catch(() => undefined)));
    await rm(fileDir, { recursive: true, force: true });
    await rm(sqliteDir, { recursive: true, force: true });
  }
});

test("semantic candidate fusion does not bypass lifecycle filters", async () => {
  await withIndexedStores(async ({ file, sqlite }) => {
    await file.putNode({
      id: "suppressed-candidate",
      scope: "repo-a",
      kind: "procedure",
      summary: "Suppressed route was semantically selected but must not pass an active lifecycle filter.",
      lifecycle: "suppressed",
      authority: "rejected",
      confidence: 0.95,
    });
    await sqlite.putNode({
      id: "suppressed-candidate",
      scope: "repo-a",
      kind: "procedure",
      summary: "Suppressed route was semantically selected but must not pass an active lifecycle filter.",
      lifecycle: "suppressed",
      authority: "rejected",
      confidence: 0.95,
    });

    const input = {
      scope: "repo-a",
      query: "semantically selected suppressed route",
      lifecycle: ["active" as const],
      candidateLimit: 10,
      limit: 10,
    };

    assert.deepEqual((await file.searchNodes(input)).map((result) => result.node.id), []);
    assert.deepEqual((await sqlite.searchNodes(input)).map((result) => result.node.id), []);
  });
});
