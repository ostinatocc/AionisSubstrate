import type {
  AionisAuthorityState,
  AionisLifecycleState,
  AionisMemoryKind,
  AionisMemoryNode,
  AionisMemorySearchInput,
  AionisMemorySearchReason,
} from "./types.ts";

export type AionisCandidateIndexSearchResult = {
  scope: string;
  memoryId: string;
  score: number;
  reasons: AionisMemorySearchReason[];
};

export type AionisCandidateIndexHealthReport = {
  ok: boolean;
  sourceCount: number;
  indexedCount: number;
  missingNodeIds: string[];
  orphanNodeIds: string[];
  staleNodeIds: string[];
};

export type AionisCandidateIndex = {
  upsertNode(node: AionisMemoryNode): Promise<void>;
  deleteNode(scope: string, id: string): Promise<void>;
  search(input: AionisMemorySearchInput): Promise<AionisCandidateIndexSearchResult[]>;
  rebuild(nodes: AionisMemoryNode[]): Promise<AionisCandidateIndexHealthReport>;
  verify(nodes: AionisMemoryNode[]): Promise<AionisCandidateIndexHealthReport>;
  close?(): Promise<void>;
};

type IndexedNode = {
  node: AionisMemoryNode;
  fingerprint: string;
  text: string;
  tokens: Set<string>;
  targetFiles: Set<string>;
};

const DEFAULT_INDEX_LIMIT = 200;

function indexKey(scope: string, id: string): string {
  return `${scope}\u0000${id}`;
}

function normalizeText(value: string): string {
  return value.toLowerCase().normalize("NFKC");
}

function tokenize(value: string): string[] {
  return Array.from(new Set(normalizeText(value).match(/[\p{L}\p{N}_./:-]+/gu) ?? []));
}

function normalizePath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/\/+/g, "/").toLowerCase();
}

function stableMetadataText(metadata: Record<string, unknown> | undefined): string {
  if (!metadata) return "";
  return Object.entries(metadata)
    .filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${String(value)}`)
    .join(" ");
}

function nodeSearchText(node: AionisMemoryNode): string {
  return [
    node.id,
    node.kind,
    node.title ?? "",
    node.summary,
    ...(node.targetFiles ?? []),
    node.payloadRef ?? "",
    node.agentId ?? "",
    node.teamId ?? "",
    stableMetadataText(node.metadata),
  ].filter(Boolean).join(" ");
}

function nodeFingerprint(node: AionisMemoryNode): string {
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
    metadata: node.metadata ?? {},
    updatedAt: node.updatedAt,
  });
}

function toIndexedNode(node: AionisMemoryNode): IndexedNode {
  const text = nodeSearchText(node);
  return {
    node,
    fingerprint: nodeFingerprint(node),
    text: normalizeText(text),
    tokens: new Set(tokenize(text)),
    targetFiles: new Set((node.targetFiles ?? []).map(normalizePath).filter(Boolean)),
  };
}

function hasAnyTargetFile(indexed: IndexedNode, targetFiles: string[]): boolean {
  if (targetFiles.length === 0) return true;
  return targetFiles.some((target) => indexed.targetFiles.has(normalizePath(target)));
}

function setContains<T extends string>(filter: Set<T> | null, value: T): boolean {
  return !filter || filter.has(value);
}

function compareIso(value: string, boundary: string): number {
  return value.localeCompare(boundary);
}

function scoreQuery(indexed: IndexedNode, query: string | null | undefined): { score: number; reasons: AionisMemorySearchReason[] } | null {
  const queryTokens = tokenize(query ?? "");
  if (queryTokens.length === 0) return {
    score: indexed.node.confidence,
    reasons: [{ code: "candidate_index_scope_match", detail: `scope=${indexed.node.scope}` }],
  };

  let score = indexed.node.confidence;
  const matched: string[] = [];
  for (const token of queryTokens) {
    if (indexed.tokens.has(token)) {
      score += 2;
      matched.push(token);
    } else if (indexed.text.includes(token)) {
      score += 1;
      matched.push(token);
    }
  }
  if (matched.length === 0) return null;
  return {
    score,
    reasons: [{
      code: "candidate_index_query_match",
      detail: `candidate index matched ${matched.length}/${queryTokens.length} query tokens: ${matched.join(", ")}`,
    }],
  };
}

function healthFrom(indexed: Map<string, IndexedNode>, nodes: AionisMemoryNode[]): AionisCandidateIndexHealthReport {
  const source = new Map(nodes.map((node) => [indexKey(node.scope, node.id), node]));
  const missingNodeIds: string[] = [];
  const orphanNodeIds: string[] = [];
  const staleNodeIds: string[] = [];

  for (const [key, node] of source) {
    const current = indexed.get(key);
    if (!current) {
      missingNodeIds.push(node.id);
    } else if (current.fingerprint !== nodeFingerprint(node)) {
      staleNodeIds.push(node.id);
    }
  }
  for (const [key, current] of indexed) {
    if (!source.has(key)) orphanNodeIds.push(current.node.id);
  }

  missingNodeIds.sort();
  orphanNodeIds.sort();
  staleNodeIds.sort();
  return {
    ok: missingNodeIds.length === 0 && orphanNodeIds.length === 0 && staleNodeIds.length === 0,
    sourceCount: source.size,
    indexedCount: indexed.size,
    missingNodeIds,
    orphanNodeIds,
    staleNodeIds,
  };
}

export function createMemoryCandidateIndex(nodes: AionisMemoryNode[] = []): AionisCandidateIndex {
  const indexed = new Map<string, IndexedNode>();
  for (const node of nodes) indexed.set(indexKey(node.scope, node.id), toIndexedNode(node));

  return {
    async upsertNode(node: AionisMemoryNode): Promise<void> {
      indexed.set(indexKey(node.scope, node.id), toIndexedNode(node));
    },

    async deleteNode(scope: string, id: string): Promise<void> {
      indexed.delete(indexKey(scope, id));
    },

    async search(input: AionisMemorySearchInput): Promise<AionisCandidateIndexSearchResult[]> {
      const scope = input.scope.trim();
      if (!scope) throw new Error("scope is required");
      const limit = input.limit === undefined ? DEFAULT_INDEX_LIMIT : input.limit;
      if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
      if (input.minConfidence !== undefined && (!Number.isFinite(input.minConfidence) || input.minConfidence < 0 || input.minConfidence > 1)) {
        throw new Error("minConfidence must be between 0 and 1");
      }

      const kindFilter = input.kinds === undefined ? null : new Set<AionisMemoryKind>(input.kinds);
      const lifecycleFilter = input.lifecycle === undefined ? null : new Set<AionisLifecycleState>(input.lifecycle);
      const authorityFilter = input.authority === undefined ? null : new Set<AionisAuthorityState>(input.authority);
      const targetFiles = input.targetFiles?.map((item) => item.trim()).filter(Boolean) ?? [];
      const results: AionisCandidateIndexSearchResult[] = [];

      for (const item of indexed.values()) {
        const node = item.node;
        if (node.scope !== scope) continue;
        if (!setContains(kindFilter, node.kind)) continue;
        if (!setContains(lifecycleFilter, node.lifecycle)) continue;
        if (!setContains(authorityFilter, node.authority)) continue;
        if (input.agentId !== undefined && node.agentId !== input.agentId) continue;
        if (input.teamId !== undefined && node.teamId !== input.teamId) continue;
        if (input.minConfidence !== undefined && node.confidence < input.minConfidence) continue;
        if (input.updatedAfter !== undefined && compareIso(node.updatedAt, input.updatedAfter) < 0) continue;
        if (input.updatedBefore !== undefined && compareIso(node.updatedAt, input.updatedBefore) > 0) continue;
        if (!hasAnyTargetFile(item, targetFiles)) continue;

        const query = scoreQuery(item, input.query);
        if (!query) continue;
        results.push({
          scope: node.scope,
          memoryId: node.id,
          score: query.score,
          reasons: query.reasons,
        });
      }

      return results
        .sort((a, b) => {
          const byScore = b.score - a.score;
          if (byScore !== 0) return byScore;
          const aNode = indexed.get(indexKey(a.scope, a.memoryId))?.node;
          const bNode = indexed.get(indexKey(b.scope, b.memoryId))?.node;
          const byTime = (bNode?.updatedAt ?? "").localeCompare(aNode?.updatedAt ?? "");
          if (byTime !== 0) return byTime;
          return a.memoryId.localeCompare(b.memoryId);
        })
        .slice(0, limit);
    },

    async rebuild(nodes: AionisMemoryNode[]): Promise<AionisCandidateIndexHealthReport> {
      indexed.clear();
      for (const node of nodes) indexed.set(indexKey(node.scope, node.id), toIndexedNode(node));
      return healthFrom(indexed, nodes);
    },

    async verify(nodes: AionisMemoryNode[]): Promise<AionisCandidateIndexHealthReport> {
      return healthFrom(indexed, nodes);
    },
  };
}
