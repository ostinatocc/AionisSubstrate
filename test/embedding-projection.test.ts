import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AIONIS_EMBEDDING_PROJECTION_VERSION,
  buildAionisEmbeddingDocument,
  buildAionisEmbeddingQuery,
  type AionisMemoryNodeInput,
} from "../src/index.ts";

function memory(input: Partial<AionisMemoryNodeInput> = {}): AionisMemoryNodeInput {
  return {
    id: "route-current",
    scope: "repo-a",
    kind: "procedure",
    title: "Current runtime route",
    summary: "Use src/runtime.ts after verifier passed.",
    lifecycle: "active",
    authority: "trusted",
    confidence: 0.95,
    targetFiles: ["src/runtime.ts", "src/search.ts"],
    payloadRef: "file://trace/current.log",
    agentId: "agent-1",
    teamId: "team-a",
    metadata: {
      embedding_model: "text-embedding-v4",
      embedding: [0.1, 0.2, 0.3],
      primitive: "runtime-route",
      retry_count: 2,
      ok: true,
    },
    ...input,
  };
}

test("structured embedding document has a stable projection header and ordered core fields", () => {
  const text = buildAionisEmbeddingDocument(memory());

  assert.ok(text.startsWith(`${AIONIS_EMBEDDING_PROJECTION_VERSION}\ntype: memory_document\n`));
  assert.match(text, /kind: procedure/);
  assert.match(text, /lifecycle: active/);
  assert.match(text, /authority: trusted/);
  assert.match(text, /summary: Use src\/runtime\.ts after verifier passed\./);
  assert.match(text, /target_files: src\/runtime\.ts, src\/search\.ts/);
  assert.doesNotMatch(text, /id: route-current/);
  assert.doesNotMatch(text, /scope: repo-a/);
  assert.doesNotMatch(text, /agent_id:/);
  assert.doesNotMatch(text, /metadata:/);
});

test("embedding projection can include selected scalar metadata while excluding vector payloads", () => {
  const text = buildAionisEmbeddingDocument(memory({
    metadata: {
      embedding: [0.1, 0.2, 0.3],
      embedding_vector: [0.4],
      query_vector: [0.5],
      vector: [0.6],
      safe_label: "kept",
      noisy_label: "ignored",
    },
  }), { metadataKeys: ["safe_label"] });

  assert.match(text, /metadata: safe_label=kept/);
  assert.doesNotMatch(text, /noisy_label/);
  assert.doesNotMatch(text, /0\.1/);
  assert.doesNotMatch(text, /embedding=/);
  assert.doesNotMatch(text, /embedding_vector=/);
  assert.doesNotMatch(text, /query_vector=/);
});

test("plain document projection keeps compact search text without projection labels", () => {
  const text = buildAionisEmbeddingDocument(memory(), { projection: "plain", metadataKeys: ["primitive"] });

  assert.ok(!text.includes(AIONIS_EMBEDDING_PROJECTION_VERSION));
  assert.ok(!text.includes("type: memory_document"));
  assert.match(text, /Current runtime route/);
  assert.match(text, /Use src\/runtime\.ts after verifier passed\./);
  assert.match(text, /procedure active trusted/);
  assert.match(text, /primitive=runtime-route/);
});

test("structured query projection records retrieval task and normalized query", () => {
  const text = buildAionisEmbeddingQuery("  continue   runtime verifier work  ");

  assert.equal(text, [
    AIONIS_EMBEDDING_PROJECTION_VERSION,
    "type: retrieval_query",
    "task: retrieve the memory document that best answers this implementation question",
    "query: continue runtime verifier work",
  ].join("\n"));
});

test("custom query task changes query-side projection only", () => {
  const text = buildAionisEmbeddingQuery("find archived trace", {
    task: "retrieve raw evidence hooks",
  });

  assert.match(text, /task: retrieve raw evidence hooks/);
  assert.match(text, /query: find archived trace/);
});
