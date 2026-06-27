import type { AionisMemoryNode, AionisMemoryNodeInput } from "./types.ts";

export const AIONIS_EMBEDDING_PROJECTION_VERSION = "aionis_substrate_embedding_projection_v1";

export type AionisEmbeddingProjectionMode = "plain" | "structured";

export type AionisEmbeddingDocumentOptions = {
  projection?: AionisEmbeddingProjectionMode;
  includeIdentity?: boolean;
  includeOwner?: boolean;
  metadataKeys?: "all" | string[] | false;
};

export type AionisEmbeddingQueryOptions = {
  projection?: AionisEmbeddingProjectionMode;
  task?: string;
};

const VECTOR_METADATA_KEYS = new Set([
  "embedding",
  "embedding_vector",
  "vector",
  "query_vector",
]);

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

function optionalValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const normalized = normalizeText(value);
    return normalized.length > 0 ? normalized : null;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

function joinList(values: readonly string[] | undefined): string | null {
  const normalized = (values ?? [])
    .map((value) => normalizeText(value))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  return normalized.length > 0 ? normalized.join(", ") : null;
}

function stableMetadataText(
  metadata: Record<string, unknown> | undefined,
  metadataKeys: AionisEmbeddingDocumentOptions["metadataKeys"] = false,
): string | null {
  if (!metadata) return null;
  if (metadataKeys === false) return null;
  const allowedKeys = Array.isArray(metadataKeys) ? new Set(metadataKeys) : null;
  const rows = Object.entries(metadata)
    .filter(([key, value]) =>
      !VECTOR_METADATA_KEYS.has(key) &&
      (allowedKeys === null || allowedKeys.has(key)) &&
      optionalValue(value) !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${optionalValue(value)}`);
  return rows.length > 0 ? rows.join("; ") : null;
}

function line(label: string, value: unknown): string | null {
  const normalized = optionalValue(value);
  return normalized === null ? null : `${label}: ${normalized}`;
}

function plainDocumentText(node: AionisMemoryNode | AionisMemoryNodeInput, options: AionisEmbeddingDocumentOptions): string {
  return [
    node.title,
    node.summary,
    node.kind,
    node.lifecycle,
    node.authority,
    joinList(node.targetFiles),
    node.payloadRef,
    options.includeOwner ? node.agentId : null,
    options.includeOwner ? node.teamId : null,
    stableMetadataText(node.metadata, options.metadataKeys),
  ].flatMap((value) => {
    const normalized = optionalValue(value);
    return normalized === null ? [] : [normalized];
  }).join(" ");
}

export function buildAionisEmbeddingDocument(
  node: AionisMemoryNode | AionisMemoryNodeInput,
  options: AionisEmbeddingDocumentOptions = {},
): string {
  const projection = options.projection ?? "structured";
  if (projection === "plain") return plainDocumentText(node, options);
  return [
    AIONIS_EMBEDDING_PROJECTION_VERSION,
    "type: memory_document",
    options.includeIdentity ? line("id", node.id) : null,
    options.includeIdentity ? line("scope", node.scope) : null,
    line("kind", node.kind),
    line("lifecycle", node.lifecycle),
    line("authority", node.authority),
    line("title", node.title),
    line("summary", node.summary),
    line("target_files", joinList(node.targetFiles)),
    line("payload_ref", node.payloadRef),
    options.includeOwner ? line("agent_id", node.agentId) : null,
    options.includeOwner ? line("team_id", node.teamId) : null,
    line("metadata", stableMetadataText(node.metadata, options.metadataKeys)),
  ].filter((value): value is string => value !== null).join("\n");
}

export function buildAionisEmbeddingQuery(
  query: string,
  options: AionisEmbeddingQueryOptions = {},
): string {
  const normalizedQuery = normalizeText(query);
  const projection = options.projection ?? "structured";
  if (projection === "plain") return normalizedQuery;
  const task = normalizeText(options.task ?? "retrieve the memory document that best answers this implementation question");
  return [
    AIONIS_EMBEDDING_PROJECTION_VERSION,
    "type: retrieval_query",
    `task: ${task}`,
    `query: ${normalizedQuery}`,
  ].join("\n");
}
