import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  AionisCandidateIndex,
  AionisCandidateIndexHealthReport,
  AionisCandidateIndexSearchResult,
} from "./candidate-index.ts";
import type {
  AionisMemoryNode,
  AionisMemorySearchInput,
  AionisMemorySearchReason,
} from "./types.ts";
import { stableMetadataText } from "./metadata-text.ts";

const ZVEC_PACKAGE = "@zvec/zvec";
const DEFAULT_COLLECTION_NAME = "aionis_substrate_candidates_v1";
const DEFAULT_VECTOR_FIELD = "embedding";
const MANIFEST_FILE = "manifest.json";

type MaybePromise<T> = T | Promise<T>;

type ZvecModule = {
  ZVecCreateAndOpen: (path: string, schema: unknown, options?: unknown) => ZvecCollection;
  ZVecOpen: (path: string, options?: unknown) => ZvecCollection;
  ZVecCollectionSchema: new (params: unknown) => unknown;
  ZVecDataType: Record<string, number>;
  ZVecIndexType: Record<string, number>;
  ZVecMetricType: Record<string, number>;
};

type ZvecStatus = {
  ok: boolean;
  code: string;
  message: string;
};

type ZvecDoc = {
  id: string;
  score: number;
  fields: Record<string, unknown>;
};

type ZvecCollection = {
  upsertSync(doc: unknown): ZvecStatus | ZvecStatus[];
  deleteSync(ids: string | string[]): ZvecStatus | ZvecStatus[];
  deleteByFilterSync(filter: string): ZvecStatus;
  fetchSync(params: { ids: string | string[]; outputFields?: string[]; includeVector?: boolean }): Record<string, ZvecDoc>;
  querySync(params: unknown): ZvecDoc[];
  closeSync(): void;
};

type ManifestEntry = {
  scope: string;
  memoryId: string;
  docId: string;
  dimension: number;
  embeddingModel: string;
  fingerprint: string;
};

type ManifestFile = {
  version: 1;
  entries: ManifestEntry[];
};

type OpenCollection = {
  dimension: number;
  collection: ZvecCollection;
};

export type ZvecCandidateIndexOptions = {
  path: string;
  embeddingModel?: string;
  collectionName?: string;
  vectorField?: string;
  vectorForNode?: (node: AionisMemoryNode) => MaybePromise<number[] | null | undefined>;
  vectorForQuery?: (input: AionisMemorySearchInput) => MaybePromise<number[] | null | undefined>;
};

function assertStatus(status: ZvecStatus | ZvecStatus[], operation: string): void {
  const statuses = Array.isArray(status) ? status : [status];
  const failed = statuses.find((item) => !item.ok);
  if (failed) throw new Error(`Zvec candidate index ${operation} failed: ${failed.code} ${failed.message}`);
}

function normalizeVector(value: readonly number[] | null | undefined, label: string): number[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} vector must be a non-empty number array`);
  const out = value.map((item, index) => {
    if (!Number.isFinite(item)) throw new Error(`${label} vector contains a non-finite value at index ${index}`);
    return Number(item);
  });
  return out;
}

function metadataVector(node: AionisMemoryNode): number[] | null {
  const metadata = node.metadata ?? {};
  const candidates = [
    metadata.embedding,
    metadata.embedding_vector,
    metadata.vector,
    metadata.query_vector,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    if (candidate.every((item) => typeof item === "number" && Number.isFinite(item))) return [...candidate];
  }
  return null;
}

function vectorHash(vector: readonly number[]): string {
  const hash = createHash("sha256");
  for (const value of vector) hash.update(String(value)).update("\0");
  return hash.digest("hex");
}

function nodeFingerprint(node: AionisMemoryNode, vector: readonly number[], embeddingModel: string): string {
  return JSON.stringify({
    id: node.id,
    scope: node.scope,
    kind: node.kind,
    title: node.title ?? null,
    summary: node.summary,
    lifecycle: node.lifecycle,
    authority: node.authority,
    confidence: node.confidence,
    targetFiles: node.targetFiles ?? [],
    payloadRef: node.payloadRef ?? null,
    agentId: node.agentId ?? null,
    teamId: node.teamId ?? null,
    metadata: stableMetadataText(node.metadata) ?? "",
    updatedAt: node.updatedAt,
    embeddingModel,
    vectorHash: vectorHash(vector),
  });
}

function docIdFor(scope: string, memoryId: string, embeddingModel: string): string {
  return createHash("sha256")
    .update(scope)
    .update("\0")
    .update(memoryId)
    .update("\0")
    .update(embeddingModel)
    .digest("hex");
}

function manifestKey(scope: string, memoryId: string, embeddingModel: string): string {
  return `${scope}\u0000${memoryId}\u0000${embeddingModel}`;
}

function dimensionDirName(dimension: number): string {
  return `dim-${dimension}`;
}

function parseDimensionDirName(value: string): number | null {
  const match = /^dim-(\d+)$/.exec(value);
  if (!match) return null;
  const dimension = Number(match[1]);
  return Number.isInteger(dimension) && dimension > 0 ? dimension : null;
}

function stringLiteral(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function filterExpression(input: AionisMemorySearchInput, embeddingModel: string): string {
  const clauses = [
    `scope = ${stringLiteral(input.scope)}`,
    `embedding_model = ${stringLiteral(embeddingModel)}`,
  ];
  if (input.kinds?.length) clauses.push(`kind in (${input.kinds.map(stringLiteral).join(", ")})`);
  if (input.lifecycle?.length) clauses.push(`lifecycle in (${input.lifecycle.map(stringLiteral).join(", ")})`);
  if (input.authority?.length) clauses.push(`authority in (${input.authority.map(stringLiteral).join(", ")})`);
  if (input.agentId !== undefined) clauses.push(`agent_id = ${input.agentId === null ? "''" : stringLiteral(input.agentId)}`);
  if (input.teamId !== undefined) clauses.push(`team_id = ${input.teamId === null ? "''" : stringLiteral(input.teamId)}`);
  return clauses.join(" AND ");
}

function normalizeScore(rawScore: number): number {
  if (!Number.isFinite(rawScore)) return 0;
  return Math.max(-1, Math.min(1, 1 - rawScore));
}

async function loadZvecModule(): Promise<ZvecModule> {
  try {
    return await import(ZVEC_PACKAGE) as ZvecModule;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Zvec candidate index requires optional dependency ${ZVEC_PACKAGE}. Install it with npm install ${ZVEC_PACKAGE}@0.5.0. Cause: ${message}`,
    );
  }
}

function createSchema(zvec: ZvecModule, collectionName: string, vectorField: string, dimension: number): unknown {
  return new zvec.ZVecCollectionSchema({
    name: collectionName,
    vectors: {
      name: vectorField,
      dataType: zvec.ZVecDataType.VECTOR_FP32,
      dimension,
      indexParams: {
        indexType: zvec.ZVecIndexType.FLAT,
        metricType: zvec.ZVecMetricType.COSINE,
      },
    },
    fields: [
      { name: "memory_id", dataType: zvec.ZVecDataType.STRING, indexParams: { indexType: zvec.ZVecIndexType.INVERT } },
      { name: "scope", dataType: zvec.ZVecDataType.STRING, indexParams: { indexType: zvec.ZVecIndexType.INVERT } },
      { name: "embedding_model", dataType: zvec.ZVecDataType.STRING, indexParams: { indexType: zvec.ZVecIndexType.INVERT } },
      { name: "kind", dataType: zvec.ZVecDataType.STRING, indexParams: { indexType: zvec.ZVecIndexType.INVERT } },
      { name: "lifecycle", dataType: zvec.ZVecDataType.STRING, indexParams: { indexType: zvec.ZVecIndexType.INVERT } },
      { name: "authority", dataType: zvec.ZVecDataType.STRING, indexParams: { indexType: zvec.ZVecIndexType.INVERT } },
      { name: "agent_id", dataType: zvec.ZVecDataType.STRING, nullable: true, indexParams: { indexType: zvec.ZVecIndexType.INVERT } },
      { name: "team_id", dataType: zvec.ZVecDataType.STRING, nullable: true, indexParams: { indexType: zvec.ZVecIndexType.INVERT } },
      { name: "updated_at", dataType: zvec.ZVecDataType.STRING, indexParams: { indexType: zvec.ZVecIndexType.INVERT } },
    ],
  });
}

function recordToDoc(node: AionisMemoryNode, vector: number[], embeddingModel: string) {
  const fields: Record<string, string> = {
    memory_id: node.id,
    scope: node.scope,
    embedding_model: embeddingModel,
    kind: node.kind,
    lifecycle: node.lifecycle,
    authority: node.authority,
    updated_at: node.updatedAt,
  };
  if (node.agentId) fields.agent_id = node.agentId;
  if (node.teamId) fields.team_id = node.teamId;
  return {
    id: docIdFor(node.scope, node.id, embeddingModel),
    vectors: { [DEFAULT_VECTOR_FIELD]: vector },
    fields,
  };
}

async function readManifest(path: string): Promise<Map<string, ManifestEntry>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as ManifestFile;
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    return new Map(entries.map((entry) => [manifestKey(entry.scope, entry.memoryId, entry.embeddingModel), entry]));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw err;
  }
}

async function writeManifest(path: string, entries: Map<string, ManifestEntry>): Promise<void> {
  const payload: ManifestFile = {
    version: 1,
    entries: Array.from(entries.values()).sort((a, b) =>
      a.scope.localeCompare(b.scope) ||
      a.memoryId.localeCompare(b.memoryId) ||
      a.embeddingModel.localeCompare(b.embeddingModel),
    ),
  };
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

export class ZvecCandidateIndex implements AionisCandidateIndex {
  private zvecPromise: Promise<ZvecModule> | null = null;
  private readonly collections = new Map<number, OpenCollection>();
  private manifest: Map<string, ManifestEntry> | null = null;
  private readonly options: ZvecCandidateIndexOptions;
  private readonly path: string;
  private readonly manifestPath: string;
  private readonly collectionName: string;
  private readonly vectorField: string;
  private readonly embeddingModel: string;
  private manifestDirty = false;

  constructor(options: ZvecCandidateIndexOptions) {
    this.options = options;
    if (!options.path.trim()) throw new Error("Zvec candidate index path is required");
    this.path = options.path;
    this.manifestPath = join(options.path, MANIFEST_FILE);
    this.collectionName = options.collectionName ?? DEFAULT_COLLECTION_NAME;
    this.vectorField = options.vectorField ?? DEFAULT_VECTOR_FIELD;
    this.embeddingModel = options.embeddingModel ?? "default";
    mkdirSync(options.path, { recursive: true });
  }

  private async zvec(): Promise<ZvecModule> {
    this.zvecPromise ??= loadZvecModule();
    return this.zvecPromise;
  }

  private async loadManifest(): Promise<Map<string, ManifestEntry>> {
    this.manifest ??= await readManifest(this.manifestPath);
    return this.manifest;
  }

  private async saveManifest(): Promise<void> {
    await writeManifest(this.manifestPath, await this.loadManifest());
    this.manifestDirty = false;
  }

  private markManifestDirty(): void {
    this.manifestDirty = true;
  }

  private async flushManifest(): Promise<void> {
    if (!this.manifestDirty) return;
    await this.saveManifest();
  }

  private async collectionForDimension(dimension: number): Promise<ZvecCollection> {
    if (!Number.isInteger(dimension) || dimension <= 0) throw new Error(`invalid Zvec vector dimension: ${dimension}`);
    const existing = this.collections.get(dimension);
    if (existing) return existing.collection;
    const zvec = await this.zvec();
    const collectionPath = join(this.path, dimensionDirName(dimension));
    const collection = existsSync(collectionPath)
      ? zvec.ZVecOpen(collectionPath)
      : zvec.ZVecCreateAndOpen(collectionPath, createSchema(zvec, this.collectionName, this.vectorField, dimension));
    this.collections.set(dimension, { dimension, collection });
    return collection;
  }

  private async nodeVector(node: AionisMemoryNode): Promise<number[] | null> {
    const raw = this.options.vectorForNode
      ? await this.options.vectorForNode(node)
      : metadataVector(node);
    return normalizeVector(raw, `node ${node.id}`);
  }

  private async queryVector(input: AionisMemorySearchInput): Promise<number[] | null> {
    const raw = this.options.vectorForQuery
      ? await this.options.vectorForQuery(input)
      : input.queryVector;
    return normalizeVector(raw, "query");
  }

  async upsertNode(node: AionisMemoryNode): Promise<void> {
    const vector = await this.nodeVector(node);
    if (!vector) {
      await this.deleteNode(node.scope, node.id);
      return;
    }
    const embeddingModel = node.metadata?.embedding_model && typeof node.metadata.embedding_model === "string"
      ? node.metadata.embedding_model
      : this.embeddingModel;
    const collection = await this.collectionForDimension(vector.length);
    assertStatus(collection.upsertSync({
      ...recordToDoc(node, vector, embeddingModel),
      vectors: { [this.vectorField]: vector },
    }), "upsert");
    const manifest = await this.loadManifest();
    manifest.set(manifestKey(node.scope, node.id, embeddingModel), {
      scope: node.scope,
      memoryId: node.id,
      docId: docIdFor(node.scope, node.id, embeddingModel),
      dimension: vector.length,
      embeddingModel,
      fingerprint: nodeFingerprint(node, vector, embeddingModel),
    });
    this.markManifestDirty();
  }

  async deleteNode(scope: string, id: string): Promise<void> {
    const manifest = await this.loadManifest();
    const entries = Array.from(manifest.entries()).filter(([, entry]) => entry.scope === scope && entry.memoryId === id);
    if (entries.length > 0) {
      for (const [key, entry] of entries) {
        const collection = await this.collectionForDimension(entry.dimension);
        assertStatus(collection.deleteSync(entry.docId), "delete");
        manifest.delete(key);
      }
      this.markManifestDirty();
      return;
    }
    for (const dimension of this.knownDimensions()) {
      const collection = await this.collectionForDimension(dimension);
      assertStatus(collection.deleteByFilterSync(`scope = ${stringLiteral(scope)} AND memory_id = ${stringLiteral(id)}`), "delete");
    }
  }

  async search(input: AionisMemorySearchInput): Promise<AionisCandidateIndexSearchResult[] | null> {
    const vector = await this.queryVector(input);
    if (!vector) return null;
    const embeddingModel = input.embeddingModel ?? this.embeddingModel;
    const collection = await this.collectionForDimension(vector.length);
    const rows = collection.querySync({
      fieldName: this.vectorField,
      vector,
      topk: input.limit ?? 50,
      filter: filterExpression(input, embeddingModel),
      includeVector: false,
      outputFields: ["memory_id"],
    });
    return rows
      .map((row): AionisCandidateIndexSearchResult => {
        const memoryId = typeof row.fields.memory_id === "string" ? row.fields.memory_id : row.id;
        const reasons: AionisMemorySearchReason[] = [{
          code: "zvec_candidate_index_match",
          detail: `Zvec candidate score=${normalizeScore(row.score).toFixed(6)}`,
        }];
        return {
          scope: input.scope,
          memoryId,
          score: normalizeScore(row.score),
          reasons,
        };
      })
      .sort((a, b) => b.score - a.score || a.memoryId.localeCompare(b.memoryId));
  }

  async rebuild(nodes: AionisMemoryNode[]): Promise<AionisCandidateIndexHealthReport> {
    const buffered: Array<{ node: AionisMemoryNode; vector: number[]; embeddingModel: string }> = [];
    for (const node of nodes) {
      const vector = await this.nodeVector(node);
      if (!vector) continue;
      const embeddingModel = node.metadata?.embedding_model && typeof node.metadata.embedding_model === "string"
        ? node.metadata.embedding_model
        : this.embeddingModel;
      buffered.push({ node, vector, embeddingModel });
    }

    const tmpPath = `${this.path}.rebuild-${process.pid}-${Date.now()}`;
    rmSync(tmpPath, { recursive: true, force: true });
    const next = new ZvecCandidateIndex({
      ...this.options,
      path: tmpPath,
      collectionName: this.collectionName,
      vectorField: this.vectorField,
      embeddingModel: this.embeddingModel,
    });
    try {
      for (const item of buffered) await next.upsertNode(item.node);
      const nextManifest = await next.loadManifest();
      await next.close();
      await this.close();
      rmSync(this.path, { recursive: true, force: true });
      renameSync(tmpPath, this.path);
      mkdirSync(this.path, { recursive: true });
      this.manifest = new Map(nextManifest);
      this.manifestDirty = false;
      return await this.verify(nodes);
    } catch (err) {
      await next.close().catch(() => undefined);
      rmSync(tmpPath, { recursive: true, force: true });
      throw err;
    }
  }

  async verify(nodes: AionisMemoryNode[]): Promise<AionisCandidateIndexHealthReport> {
    const manifest = await this.loadManifest();
    const expected = new Map<string, { node: AionisMemoryNode; vector: number[]; embeddingModel: string; fingerprint: string }>();
    for (const node of nodes) {
      const vector = await this.nodeVector(node);
      if (!vector) continue;
      const embeddingModel = node.metadata?.embedding_model && typeof node.metadata.embedding_model === "string"
        ? node.metadata.embedding_model
        : this.embeddingModel;
      expected.set(manifestKey(node.scope, node.id, embeddingModel), {
        node,
        vector,
        embeddingModel,
        fingerprint: nodeFingerprint(node, vector, embeddingModel),
      });
    }

    const missingNodeIds: string[] = [];
    const orphanNodeIds: string[] = [];
    const staleNodeIds: string[] = [];

    for (const [key, expectedEntry] of expected) {
      const actual = manifest.get(key);
      if (!actual) {
        missingNodeIds.push(expectedEntry.node.id);
        continue;
      }
      if (actual.fingerprint !== expectedEntry.fingerprint) staleNodeIds.push(expectedEntry.node.id);
      const collection = await this.collectionForDimension(actual.dimension);
      const fetched = collection.fetchSync({ ids: actual.docId, outputFields: ["memory_id"], includeVector: false });
      if (!fetched[actual.docId] && !missingNodeIds.includes(expectedEntry.node.id)) {
        missingNodeIds.push(expectedEntry.node.id);
      }
    }

    for (const [key, actual] of manifest) {
      if (!expected.has(key)) orphanNodeIds.push(actual.memoryId);
    }

    missingNodeIds.sort();
    orphanNodeIds.sort();
    staleNodeIds.sort();
    return {
      ok: missingNodeIds.length === 0 && orphanNodeIds.length === 0 && staleNodeIds.length === 0,
      sourceCount: expected.size,
      indexedCount: manifest.size,
      missingNodeIds,
      orphanNodeIds,
      staleNodeIds,
    };
  }

  async close(): Promise<void> {
    await this.flushManifest();
    for (const { collection } of this.collections.values()) collection.closeSync();
    this.collections.clear();
  }

  private knownDimensions(): number[] {
    const dimensions = new Set<number>(this.collections.keys());
    if (existsSync(this.path)) {
      for (const entry of readdirSync(this.path, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dimension = parseDimensionDirName(entry.name);
        if (dimension) dimensions.add(dimension);
      }
    }
    return Array.from(dimensions).sort((a, b) => a - b);
  }
}

export function createZvecCandidateIndex(options: ZvecCandidateIndexOptions): AionisCandidateIndex {
  return new ZvecCandidateIndex(options);
}
