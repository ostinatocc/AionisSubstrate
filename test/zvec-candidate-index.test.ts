import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  createZvecCandidateIndex,
  openSqliteAionisSubstrate,
  type AionisMemoryNodeInput,
} from "../src/index.ts";

type TestMemoryInput = Omit<AionisMemoryNodeInput, "scope" | "kind"> & Partial<Pick<AionisMemoryNodeInput, "scope" | "kind">>;

function memory(input: TestMemoryInput): AionisMemoryNodeInput {
  return {
    ...input,
    scope: "repo-a",
    kind: "procedure",
    lifecycle: "active",
    authority: "trusted",
    confidence: 0.9,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

test("zvec candidate index narrows SQLite search candidates without becoming truth storage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aionis-substrate-zvec-"));
  try {
    const zvecPath = join(dir, "zvec");
    const sqlitePath = join(dir, "substrate.sqlite");
    const candidateIndex = createZvecCandidateIndex({
      path: zvecPath,
      embeddingModel: "test-embed",
    });
    const store = await openSqliteAionisSubstrate({
      path: sqlitePath,
      candidateIndex,
    });
    try {
      await store.putNode(memory({
        id: "route-runtime",
        summary: "Runtime verifier route uses src/runtime.ts after tests passed.",
        targetFiles: ["src/runtime.ts"],
        metadata: { embedding: [1, 0, 0], embedding_model: "test-embed" },
      }));
      await store.putNode(memory({
        id: "route-docs",
        summary: "Documentation route updates docs/guide.md after markdown review.",
        targetFiles: ["docs/guide.md"],
        metadata: { embedding: [0, 1, 0], embedding_model: "test-embed" },
      }));
      await store.putNode(memory({
        id: "route-build",
        summary: "Build pipeline route edits scripts/build.ts after CI passed.",
        targetFiles: ["scripts/build.ts"],
        metadata: { embedding: [0, 0, 1], embedding_model: "test-embed" },
      }));

      const results = await store.searchNodes({
        scope: "repo-a",
        queryVector: [1, 0.02, 0],
        embeddingModel: "test-embed",
        candidateLimit: 1,
        limit: 10,
      });

      assert.deepEqual(results.map((result) => result.node.id), ["route-runtime"]);
      assert.ok(results[0]?.reasons.some((reason) => reason.code === "candidate_index_match"));
      assert.ok(results[0]?.reasons.some((reason) => reason.code === "zvec_candidate_index_match"));

      const health = await candidateIndex.verify(await store.listNodes("repo-a"));
      assert.equal(health.ok, true);
      assert.equal(health.sourceCount, 3);
      assert.equal(health.indexedCount, 3);
    } finally {
      await store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("zvec candidate index falls back to deterministic search when no query vector is provided", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aionis-substrate-zvec-fallback-"));
  try {
    const candidateIndex = createZvecCandidateIndex({
      path: join(dir, "zvec"),
      embeddingModel: "test-embed",
    });
    const store = await openSqliteAionisSubstrate({
      path: join(dir, "substrate.sqlite"),
      candidateIndex,
    });
    try {
      await store.putNode(memory({
        id: "route-runtime",
        summary: "Runtime verifier route uses src/runtime.ts after tests passed.",
        targetFiles: ["src/runtime.ts"],
        metadata: { embedding: [1, 0, 0], embedding_model: "test-embed" },
      }));
      await store.putNode(memory({
        id: "route-docs",
        summary: "Documentation route updates docs/guide.md after markdown review.",
        targetFiles: ["docs/guide.md"],
        metadata: { embedding: [0, 1, 0], embedding_model: "test-embed" },
      }));

      const results = await store.searchNodes({
        scope: "repo-a",
        query: "documentation markdown",
        limit: 5,
      });

      assert.deepEqual(results.map((result) => result.node.id), ["route-docs"]);
      assert.ok(!results[0]?.reasons.some((reason) => reason.code === "candidate_index_match"));
    } finally {
      await store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("zvec candidate index rebuild and verify expose stale index state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aionis-substrate-zvec-rebuild-"));
  try {
    const candidateIndex = createZvecCandidateIndex({
      path: join(dir, "zvec"),
      embeddingModel: "test-embed",
    });
    const store = await openSqliteAionisSubstrate({
      path: join(dir, "substrate.sqlite"),
      candidateIndex,
    });
    try {
      await store.putNode(memory({
        id: "route-runtime",
        summary: "Runtime verifier route uses src/runtime.ts after tests passed.",
        metadata: { embedding: [1, 0, 0], embedding_model: "test-embed" },
      }));
      await store.putNode(memory({
        id: "route-docs",
        summary: "Documentation route updates docs/guide.md after markdown review.",
        metadata: { embedding: [0, 1, 0], embedding_model: "test-embed" },
      }));

      await store.putNode(memory({
        id: "route-runtime",
        summary: "Runtime verifier route now uses src/runtime-next.ts after tests passed.",
        targetFiles: ["src/runtime-next.ts"],
        metadata: { embedding: [0.9, 0.1, 0], embedding_model: "test-embed" },
      }));

      assert.equal((await candidateIndex.verify(await store.listNodes("repo-a"))).ok, true);

      const isolatedIndex = createZvecCandidateIndex({
        path: join(dir, "isolated-zvec"),
        embeddingModel: "test-embed",
      });
      const nodes = await store.listNodes("repo-a");
      await isolatedIndex.upsertNode({
        ...nodes.find((node) => node.id === "route-runtime")!,
        summary: "Old runtime summary retained in a stale external index.",
      });
      const stale = await isolatedIndex.verify(nodes);
      assert.deepEqual(stale.staleNodeIds, ["route-runtime"]);
      assert.equal(stale.ok, false);

      const rebuilt = await isolatedIndex.rebuild(nodes);
      assert.equal(rebuilt.ok, true);
      await isolatedIndex.close?.();
    } finally {
      await store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
