import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  createZvecCandidateIndex,
  openSqliteAionisSubstrate,
  type AionisCandidateIndex,
  type AionisCandidateIndexHealthReport,
  type AionisMemoryNode,
  type AionisMemoryNodeInput,
  type AionisMemorySearchResult,
  type AionisSubstrate,
} from "../src/index.ts";

type EvalOptions = {
  baseUrl: string;
  endpoint: string;
  apiKeyVar: string;
  model: string;
  dimensions?: number;
  nodes: number;
  scopes: number;
  queries: number;
  batchSize: number;
  candidateLimit: number;
  resultLimit: number;
  output?: string;
  keepStore: boolean;
};

type Timings = Record<string, number>;

type SemanticCase = {
  slug: string;
  domain: string;
  targetFile: string;
  summary: string;
  query: string;
};

type QueryProbe = {
  scope: string;
  expectedId: string;
  query: string;
};

type EmbeddingUsage = {
  provider_requests: number;
  embedded_texts: number;
  input_characters: number;
  failed_requests: number;
};

type IndexedStore = {
  store: AionisSubstrate;
  candidateIndex: AionisCandidateIndex;
};

const SEMANTIC_CASES: SemanticCase[] = [
  {
    slug: "migration-ledger-corruption",
    domain: "sqlite migrations",
    targetFile: "src/sqlite-substrate.ts",
    summary: "Reject a SQLite store when the migration ledger is corrupted so event replay cannot silently trust damaged schema evidence.",
    query: "What should the substrate do when schema history cannot be trusted?",
  },
  {
    slug: "live-sidecar-checkpoint",
    domain: "runtime sidecar",
    targetFile: "src/runtime-live-sidecar.ts",
    summary: "Use a checkpointed live sidecar so Runtime Lite evidence already mirrored into Substrate is skipped on restart.",
    query: "How do we avoid replaying evidence that was already mirrored after a process restart?",
  },
  {
    slug: "raw-trace-rehydrate",
    domain: "payload governance",
    targetFile: "src/sqlite-substrate.ts",
    summary: "Route long raw terminal traces to rehydrate pointers instead of direct prompt context when only a payload hook is needed.",
    query: "Where should large terminal evidence go when the next turn only needs a pointer?",
  },
  {
    slug: "failed-branch-suppression",
    domain: "memory admission",
    targetFile: "src/types.ts",
    summary: "A contradicted execution branch must be blocked from direct use while preserving the newer active route.",
    query: "Which memory should be prevented from influencing the agent after a newer route invalidates it?",
  },
  {
    slug: "decision-receipt-audit",
    domain: "audit trace",
    targetFile: "src/sqlite-substrate.ts",
    summary: "Compile context records a memory decision receipt so later audits can inspect why a node entered each admission bucket.",
    query: "How can a reviewer see why memory changed the prompt context?",
  },
  {
    slug: "preview-context-readonly",
    domain: "audit trace",
    targetFile: "src/file-substrate.ts",
    summary: "Preview context returns governed buckets without writing a decision event, while compile context persists the receipt.",
    query: "Which call should inspect admission output without mutating the evidence log?",
  },
  {
    slug: "backup-integrity",
    domain: "backup",
    targetFile: "src/backup.ts",
    summary: "Backup restore verifies event checksums and rejects tampered event evidence before rebuilding a target store.",
    query: "What protects restored memory state from accepting edited event history?",
  },
  {
    slug: "controlled-forgetting",
    domain: "forgetting",
    targetFile: "src/types.ts",
    summary: "Controlled forgetting is represented as lifecycle transitions such as retired or suppressed, not silent physical deletion.",
    query: "How is forgetting represented without destroying the original evidence?",
  },
  {
    slug: "candidate-index-boundary",
    domain: "candidate index",
    targetFile: "src/candidate-index.ts",
    summary: "A candidate index may narrow node ids before final scoring, but SQLite remains the source of truth for loaded memory nodes.",
    query: "What is the boundary between an accelerator index and the durable memory database?",
  },
  {
    slug: "zvec-rebuild-on-open",
    domain: "zvec",
    targetFile: "src/zvec-candidate-index.ts",
    summary: "Zvec sidecar entries are rebuilt from the Substrate truth store on open and verified for missing, orphan, and stale nodes.",
    query: "How does the vector sidecar recover from startup without becoming the truth store?",
  },
  {
    slug: "scope-isolation",
    domain: "scope governance",
    targetFile: "src/search.ts",
    summary: "Search, relations, feedback, and decision receipts remain scoped so memory from one repository cannot affect another scope.",
    query: "How does the substrate prevent cross-repository memory from leaking into a different task?",
  },
  {
    slug: "target-file-filter",
    domain: "search",
    targetFile: "src/search.ts",
    summary: "Target file search uses exact normalized path filters instead of substring matching that could leak unrelated files.",
    query: "How should file-constrained memory search avoid accidental substring matches?",
  },
  {
    slug: "runtime-snapshot-import",
    domain: "runtime import",
    targetFile: "src/runtime-snapshot-importer.ts",
    summary: "Runtime Lite SQLite snapshots are imported through a read-only source connection into a separate Substrate target store.",
    query: "How can Runtime data be validated without mutating the Runtime database?",
  },
  {
    slug: "external-admission-parity",
    domain: "parity",
    targetFile: "src/runtime-snapshot-parity.ts",
    summary: "External admission parity compares Substrate buckets against Runtime reference surfaces by concrete memory id overlap.",
    query: "How do we check whether two admission surfaces agree on the same memory ids?",
  },
  {
    slug: "compaction-checkpoint",
    domain: "compaction",
    targetFile: "src/event-log.ts",
    summary: "Checkpoint compaction collapses event history into one checksum-covered checkpoint while preserving governed state.",
    query: "How can a long event log be shortened without changing memory state?",
  },
  {
    slug: "orphan-decision-reject",
    domain: "audit integrity",
    targetFile: "src/sqlite-substrate.ts",
    summary: "Decision traces must reference existing memory nodes in the same scope and reject orphan decision receipts.",
    query: "What prevents an audit receipt from pointing at memory that does not exist?",
  },
  {
    slug: "feedback-attribution",
    domain: "feedback",
    targetFile: "src/types.ts",
    summary: "Outcome feedback is tied to concrete memory ids so later learning signals can distinguish used evidence from exposed evidence.",
    query: "How does the substrate attach run outcomes to the memory that actually influenced behavior?",
  },
  {
    slug: "requires-payload-relation",
    domain: "relations",
    targetFile: "src/types.ts",
    summary: "A requires_payload relation routes memory to rehydrate when the summary is insufficient and raw evidence must be recovered.",
    query: "Which relation means the agent should recover payload before trusting the short summary?",
  },
  {
    slug: "install-smoke",
    domain: "release",
    targetFile: "scripts/install-smoke.ts",
    summary: "The install smoke packs the built package, installs it into a fresh project, imports the package, and runs real store operations.",
    query: "How do we verify the npm package works after installation in a clean project?",
  },
  {
    slug: "published-runtime-smoke",
    domain: "release",
    targetFile: "scripts/published-runtime-smoke.ts",
    summary: "The published runtime smoke installs the registry package and imports a Runtime Lite fixture into a separate Substrate store.",
    query: "How do we test the published package against Runtime-like data rather than source tree imports?",
  },
  {
    slug: "sidecar-lock",
    domain: "live sidecar",
    targetFile: "src/runtime-live-sidecar.ts",
    summary: "Live sidecar watch mode uses a single-instance checkpoint lock so two mirrors do not race on the same target store.",
    query: "What stops two polling sidecars from writing the same checkpoint at the same time?",
  },
  {
    slug: "relation-blocks-direct-use",
    domain: "admission",
    targetFile: "src/sqlite-substrate.ts",
    summary: "Supersedes, contradicts, and invalidates relations with enough confidence block a target memory from direct use.",
    query: "Which evidence relation prevents stale or unsafe memory from entering use-now context?",
  },
  {
    slug: "zvec-query-fallback",
    domain: "zvec",
    targetFile: "src/zvec-candidate-index.ts",
    summary: "When no usable query vector is supplied, Zvec returns null so the adapter falls back to canonical deterministic search.",
    query: "How should vector preselection behave when there is no embedding for the query?",
  },
  {
    slug: "schema-version-guard",
    domain: "schema",
    targetFile: "src/sqlite-substrate.ts",
    summary: "SQLite stores created by a newer unsupported schema version are rejected instead of silently downgraded.",
    query: "What protects older package versions from opening a future database layout?",
  },
];

type EmbeddingResponse = {
  data?: Array<{ embedding?: unknown; index?: number }>;
  usage?: unknown;
};

function readArg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1] ?? fallback;
  return fallback;
}

function readNumber(name: string, fallback: number): number {
  const raw = readArg(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
}

function parseOptions(): EvalOptions {
  const model = readArg("model", process.env.AIONIS_EMBEDDING_MODEL);
  if (!model) throw new Error("--model or AIONIS_EMBEDDING_MODEL is required");
  const dimensionsRaw = readArg("dimensions", process.env.AIONIS_EMBEDDING_DIMENSIONS);
  return {
    baseUrl: readArg("base-url", process.env.AIONIS_EMBEDDING_BASE_URL ?? "https://api.openai.com/v1")!,
    endpoint: readArg("endpoint", process.env.AIONIS_EMBEDDING_ENDPOINT ?? "/embeddings")!,
    apiKeyVar: readArg("api-key-var", "AIONIS_EMBEDDING_API_KEY")!,
    model,
    dimensions: dimensionsRaw === undefined ? undefined : readNumber("dimensions", Number(dimensionsRaw)),
    nodes: readNumber("nodes", 240),
    scopes: readNumber("scopes", 4),
    queries: Math.min(readNumber("queries", Math.min(40, SEMANTIC_CASES.length)), SEMANTIC_CASES.length),
    batchSize: readNumber("batch-size", 32),
    candidateLimit: readNumber("candidate-limit", 20),
    resultLimit: readNumber("result-limit", 10),
    output: readArg("output"),
    keepStore: process.argv.includes("--keep-store"),
  };
}

async function time<T>(timings: Timings, name: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    timings[name] = Math.round(performance.now() - start);
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function endpointUrl(options: EvalOptions): string {
  const endpoint = options.endpoint.startsWith("/") ? options.endpoint : `/${options.endpoint}`;
  return `${normalizeBaseUrl(options.baseUrl)}${endpoint}`;
}

function normalizeVector(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} embedding must be a non-empty number array`);
  return value.map((item, index) => {
    if (typeof item !== "number" || !Number.isFinite(item)) throw new Error(`${label} embedding contains non-finite value at ${index}`);
    return item;
  });
}

class EmbeddingClient {
  private readonly cache = new Map<string, number[]>();
  private readonly apiKey: string;
  private readonly options: EvalOptions;
  readonly usage: EmbeddingUsage = {
    provider_requests: 0,
    embedded_texts: 0,
    input_characters: 0,
    failed_requests: 0,
  };

  constructor(options: EvalOptions) {
    this.options = options;
    const apiKey = process.env[options.apiKeyVar];
    if (!apiKey) throw new Error(`embedding API key is required in ${options.apiKeyVar}`);
    this.apiKey = apiKey;
  }

  async embedTexts(texts: string[]): Promise<Map<string, number[]>> {
    const uniqueTexts = Array.from(new Set(texts.map((text) => text.trim()).filter(Boolean)));
    for (let index = 0; index < uniqueTexts.length; index += this.options.batchSize) {
      const batch = uniqueTexts.slice(index, index + this.options.batchSize).filter((text) => !this.cache.has(text));
      if (batch.length === 0) continue;
      const embeddings = await this.requestBatch(batch);
      for (let itemIndex = 0; itemIndex < batch.length; itemIndex += 1) {
        this.cache.set(batch[itemIndex], embeddings[itemIndex]);
      }
    }
    return this.cache;
  }

  vectorFor(text: string): number[] {
    const vector = this.cache.get(text.trim());
    if (!vector) throw new Error(`missing embedding for text: ${text.slice(0, 80)}`);
    return vector;
  }

  private async requestBatch(texts: string[]): Promise<number[][]> {
    const body: Record<string, unknown> = {
      model: this.options.model,
      input: texts,
    };
    if (this.options.dimensions !== undefined) body.dimensions = this.options.dimensions;
    this.usage.provider_requests += 1;
    this.usage.embedded_texts += texts.length;
    this.usage.input_characters += texts.reduce((sum, text) => sum + text.length, 0);
    const response = await fetch(endpointUrl(this.options), {
      method: "POST",
      headers: {
        "authorization": `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      this.usage.failed_requests += 1;
      const text = await response.text().catch(() => "");
      throw new Error(`embedding provider request failed: HTTP ${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
    }
    const parsed = await response.json() as EmbeddingResponse;
    if (!Array.isArray(parsed.data) || parsed.data.length !== texts.length) {
      throw new Error(`embedding provider returned ${parsed.data?.length ?? 0} embeddings for ${texts.length} inputs`);
    }
    const rows = [...parsed.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return rows.map((row, index) => normalizeVector(row.embedding, `embedding ${index}`));
  }
}

function nodeText(node: AionisMemoryNode | AionisMemoryNodeInput): string {
  return [
    node.title ?? "",
    node.summary,
    node.kind,
    node.lifecycle ?? "",
    node.authority ?? "",
    ...(node.targetFiles ?? []),
  ].filter(Boolean).join(" ");
}

function buildCorpus(options: EvalOptions, embeddings: Map<string, number[]>): { nodes: AionisMemoryNodeInput[]; probes: QueryProbe[] } {
  if (options.nodes < options.queries) throw new Error("--nodes must be greater than or equal to --queries");
  const nodes: AionisMemoryNodeInput[] = [];
  const probes: QueryProbe[] = [];
  for (let index = 0; index < options.queries; index += 1) {
    const item = SEMANTIC_CASES[index];
    const scope = `provider-scope-${index % options.scopes}`;
    const id = `target-${item.slug}`;
    const node: AionisMemoryNodeInput = {
      id,
      scope,
      kind: "procedure",
      title: `Procedure: ${item.domain}`,
      summary: item.summary,
      lifecycle: "active",
      authority: "trusted",
      confidence: 0.9,
      targetFiles: [item.targetFile],
      metadata: {
        provider_eval_role: "target",
        provider_eval_slug: item.slug,
        embedding_model: options.model,
        embedding: embeddings.get(`${item.domain}\n${item.summary}\n${item.targetFile}`),
      },
      createdAt: new Date(Date.UTC(2026, 5, 1, 0, index, 0)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 5, 1, 0, index, 30)).toISOString(),
    };
    nodes.push(node);
    probes.push({ scope, expectedId: id, query: item.query });
  }

  for (let index = nodes.length; index < options.nodes; index += 1) {
    const item = SEMANTIC_CASES[index % SEMANTIC_CASES.length];
    const scope = `provider-scope-${index % options.scopes}`;
    const stale = index % 7 === 0;
    const archived = index % 17 === 0;
    const text = [
      `Decoy memory for ${item.domain}.`,
      `This note discusses surrounding implementation work but is not the target answer for query ${index % options.queries}.`,
      `Related file ${item.targetFile}; branch ${index % 19}; verifier note ${index % 11}.`,
    ].join(" ");
    nodes.push({
      id: `decoy-${index}`,
      scope,
      kind: archived ? "trace_pointer" : stale ? "claim" : "fact",
      title: `Decoy: ${item.domain} ${index}`,
      summary: text,
      lifecycle: archived ? "archived" : stale ? "contested" : "active",
      authority: archived ? "trusted" : stale ? "advisory" : "trusted",
      confidence: archived ? 0.8 : stale ? 0.52 : 0.68,
      targetFiles: [item.targetFile],
      payloadRef: archived ? `file://provider-eval/${index}.log` : null,
      metadata: {
        provider_eval_role: "decoy",
        provider_eval_slug: item.slug,
        embedding_model: options.model,
        embedding: embeddings.get(`${item.domain}\n${text}\n${item.targetFile}`),
      },
      createdAt: new Date(Date.UTC(2026, 5, 1, 1, index % 60, 0)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 5, 1, 1, index % 60, 30)).toISOString(),
    });
  }
  return { nodes, probes };
}

function corpusEmbeddingTexts(options: EvalOptions): string[] {
  const texts: string[] = [];
  for (let index = 0; index < options.queries; index += 1) {
    const item = SEMANTIC_CASES[index];
    texts.push(`${item.domain}\n${item.summary}\n${item.targetFile}`);
    texts.push(item.query);
  }
  for (let index = options.queries; index < options.nodes; index += 1) {
    const item = SEMANTIC_CASES[index % SEMANTIC_CASES.length];
    const text = [
      `Decoy memory for ${item.domain}.`,
      `This note discusses surrounding implementation work but is not the target answer for query ${index % options.queries}.`,
      `Related file ${item.targetFile}; branch ${index % 19}; verifier note ${index % 11}.`,
    ].join(" ");
    texts.push(`${item.domain}\n${text}\n${item.targetFile}`);
  }
  return texts;
}

async function writeNodes(store: AionisSubstrate, nodes: AionisMemoryNodeInput[]): Promise<void> {
  for (const node of nodes) await store.putNode(node);
}

function resultIds(results: AionisMemorySearchResult[]): string[] {
  return results.map((result) => result.node.id);
}

async function rawCandidateIds(index: AionisCandidateIndex, probe: QueryProbe, client: EmbeddingClient, options: EvalOptions): Promise<string[]> {
  const rows = await index.search({
    scope: probe.scope,
    query: probe.query,
    embeddingModel: options.model,
    queryVector: client.vectorFor(probe.query),
    limit: options.candidateLimit,
  });
  return (rows ?? []).map((row) => row.memoryId);
}

async function finalSearchIds(store: AionisSubstrate, probe: QueryProbe, client: EmbeddingClient, options: EvalOptions, candidateLimit?: number): Promise<string[]> {
  return resultIds(await store.searchNodes({
    scope: probe.scope,
    query: probe.query,
    embeddingModel: options.model,
    queryVector: client.vectorFor(probe.query),
    candidateLimit,
    limit: options.resultLimit,
  }));
}

function hitAt(ids: string[], expectedId: string, k: number): boolean {
  return ids.slice(0, k).includes(expectedId);
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function assertHealth(label: string, health: AionisCandidateIndexHealthReport): void {
  if (health.ok) return;
  throw new Error(`${label} failed: missing=${health.missingNodeIds.length}, orphan=${health.orphanNodeIds.length}, stale=${health.staleNodeIds.length}`);
}

async function openIndexedStore(sqlitePath: string, zvecPath: string, client: EmbeddingClient, options: EvalOptions): Promise<IndexedStore> {
  const candidateIndex = createZvecCandidateIndex({
    path: zvecPath,
    embeddingModel: options.model,
    vectorForQuery: (input) => input.query ? client.vectorFor(input.query) : null,
  });
  const store = await openSqliteAionisSubstrate({ path: sqlitePath, candidateIndex });
  return { store, candidateIndex };
}

async function main(): Promise<void> {
  const options = parseOptions();
  const timings: Timings = {};
  const reportDir = options.output ?? join("reports", `zvec-provider-embedding-${new Date().toISOString().replaceAll(":", "-")}`);
  const tempDir = await mkdtemp(join(tmpdir(), "aionis-substrate-provider-zvec-"));
  const sqlitePath = join(tempDir, "substrate.sqlite");
  const zvecPath = join(tempDir, "substrate.zvec");
  const client = new EmbeddingClient(options);
  let indexed: IndexedStore | null = null;
  let baseline: AionisSubstrate | null = null;

  try {
    await mkdir(reportDir, { recursive: true });
    const embeddingTexts = corpusEmbeddingTexts(options);
    const embeddings = await time(timings, "provider_embedding_ms", async () => client.embedTexts(embeddingTexts));
    const { nodes, probes } = buildCorpus(options, embeddings);

    indexed = await openIndexedStore(sqlitePath, zvecPath, client, options);
    await time(timings, "write_nodes_with_provider_vectors_ms", async () => writeNodes(indexed!.store, nodes));
    const allNodes: AionisMemoryNode[] = [];
    for (let scopeIndex = 0; scopeIndex < options.scopes; scopeIndex += 1) {
      allNodes.push(...await indexed.store.listNodes(`provider-scope-${scopeIndex}`));
    }
    const health = await time(timings, "zvec_verify_ms", async () => indexed!.candidateIndex.verify(allNodes));
    assertHealth("provider Zvec verify", health);

    const rawCandidateResults: Array<QueryProbe & { rawCandidateIds: string[] }> = [];
    for (const probe of probes) {
      rawCandidateResults.push({
        ...probe,
        rawCandidateIds: await rawCandidateIds(indexed.candidateIndex, probe, client, options),
      });
    }
    const indexedFinalResults: Array<QueryProbe & { finalIds: string[] }> = [];
    for (const probe of probes) {
      indexedFinalResults.push({
        ...probe,
        finalIds: await finalSearchIds(indexed.store, probe, client, options, options.candidateLimit),
      });
    }
    await indexed.store.close();
    indexed = null;

    baseline = await openSqliteAionisSubstrate({ path: sqlitePath });
    const lexicalResults: Array<QueryProbe & { lexicalIds: string[] }> = [];
    for (const probe of probes) {
      lexicalResults.push({
        ...probe,
        lexicalIds: await finalSearchIds(baseline, probe, client, options),
      });
    }
    await baseline.close();
    baseline = null;

    const rawTop1 = rawCandidateResults.filter((item) => hitAt(item.rawCandidateIds, item.expectedId, 1)).length;
    const rawTopK = rawCandidateResults.filter((item) => hitAt(item.rawCandidateIds, item.expectedId, options.candidateLimit)).length;
    const finalTopK = indexedFinalResults.filter((item) => hitAt(item.finalIds, item.expectedId, options.resultLimit)).length;
    const lexicalTopK = lexicalResults.filter((item) => hitAt(item.lexicalIds, item.expectedId, options.resultLimit)).length;
    const vectorDimension = nodes
      .map((node) => node.metadata?.embedding)
      .find((embedding): embedding is number[] => Array.isArray(embedding))?.length ?? null;

    const report = {
      contract_version: "aionis_zvec_provider_embedding_eval_v1",
      generated_at: new Date().toISOString(),
      provider: {
        base_url: options.baseUrl,
        endpoint: options.endpoint,
        model: options.model,
        dimensions: options.dimensions ?? null,
        api_key_var: options.apiKeyVar,
      },
      requested: {
        nodes: options.nodes,
        scopes: options.scopes,
        queries: options.queries,
        batch_size: options.batchSize,
        candidate_limit: options.candidateLimit,
        result_limit: options.resultLimit,
      },
      actual: {
        nodes: nodes.length,
        probes: probes.length,
        vector_dimension: vectorDimension,
        raw_zvec_candidate_top1_hits: rawTop1,
        raw_zvec_candidate_topk_hits: rawTopK,
        final_substrate_topk_hits: finalTopK,
        lexical_substrate_topk_hits: lexicalTopK,
        raw_zvec_candidate_top1_rate: rate(rawTop1, probes.length),
        raw_zvec_candidate_topk_rate: rate(rawTopK, probes.length),
        final_substrate_topk_rate: rate(finalTopK, probes.length),
        lexical_substrate_topk_rate: rate(lexicalTopK, probes.length),
      },
      zvec_health: health,
      embedding_usage: client.usage,
      samples: rawCandidateResults.slice(0, 12).map((item) => {
        const final = indexedFinalResults.find((row) => row.expectedId === item.expectedId);
        const lexical = lexicalResults.find((row) => row.expectedId === item.expectedId);
        return {
          scope: item.scope,
          expected_id: item.expectedId,
          query: item.query,
          raw_candidate_ids: item.rawCandidateIds,
          final_substrate_ids: final?.finalIds ?? [],
          lexical_substrate_ids: lexical?.lexicalIds ?? [],
        };
      }),
      timings,
    };

    const reportPath = join(reportDir, "summary.json");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      report: reportPath,
      model: options.model,
      nodes: nodes.length,
      probes: probes.length,
      vector_dimension: vectorDimension,
      raw_zvec_candidate_top1_rate: report.actual.raw_zvec_candidate_top1_rate,
      raw_zvec_candidate_topk_rate: report.actual.raw_zvec_candidate_topk_rate,
      final_substrate_topk_rate: report.actual.final_substrate_topk_rate,
      lexical_substrate_topk_rate: report.actual.lexical_substrate_topk_rate,
      provider_requests: client.usage.provider_requests,
      embedded_texts: client.usage.embedded_texts,
      input_characters: client.usage.input_characters,
      timings,
    }, null, 2));
  } finally {
    if (indexed) await indexed.store.close().catch(() => undefined);
    if (baseline) await baseline.close().catch(() => undefined);
    if (!options.keepStore) await rm(tempDir, { recursive: true, force: true });
  }
}

await main();
