import type {
  AionisMemoryNode,
  AionisMemorySearchInput,
  AionisMemorySearchReason,
  AionisMemorySearchResult,
} from "./types.ts";

const MAX_DEFAULT_RESULTS = 50;

export type AionisMemorySearchCandidateMatch = {
  score: number;
  rank: number;
  total: number;
  reasons: AionisMemorySearchReason[];
};

export type AionisMemorySearchInternalInput = AionisMemorySearchInput & {
  candidateMatches?: Map<string, AionisMemorySearchCandidateMatch>;
};

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

function hasAnyTargetFile(node: AionisMemoryNode, targetFiles: string[]): boolean {
  const wanted = new Set(targetFiles.map(normalizePath).filter(Boolean));
  if (wanted.size === 0) return true;
  return (node.targetFiles ?? []).some((target) => wanted.has(normalizePath(target)));
}

function compareIso(value: string, boundary: string): number {
  return value.localeCompare(boundary);
}

function queryScore(node: AionisMemoryNode, query: string | null | undefined): { score: number; reasons: AionisMemorySearchReason[] } | null {
  const tokens = tokenize(query ?? "");
  if (tokens.length === 0) return { score: 0, reasons: [] };

  const titleTokens = new Set(tokenize(node.title ?? ""));
  const summaryTokens = new Set(tokenize(node.summary));
  const idTokens = new Set(tokenize(node.id));
  const fileTokens = new Set((node.targetFiles ?? []).flatMap(tokenize));
  const text = normalizeText(nodeSearchText(node));
  let score = 0;
  const matched: string[] = [];

  for (const token of tokens) {
    if (titleTokens.has(token)) {
      score += 5;
      matched.push(token);
    } else if (fileTokens.has(token) || (node.targetFiles ?? []).some((file) => normalizePath(file).includes(token))) {
      score += 4;
      matched.push(token);
    } else if (idTokens.has(token)) {
      score += 3;
      matched.push(token);
    } else if (summaryTokens.has(token)) {
      score += 2;
      matched.push(token);
    } else if (text.includes(token)) {
      score += 1;
      matched.push(token);
    }
  }

  if (matched.length === 0) return null;
  return {
    score,
    reasons: [{
      code: "query_match",
      detail: `matched ${matched.length}/${tokens.length} query tokens: ${matched.join(", ")}`,
    }],
  };
}

function candidateBonus(candidate: AionisMemorySearchCandidateMatch): number {
  const score = Math.max(0, Math.min(1, candidate.score));
  const total = Math.max(1, candidate.total);
  const rank = Math.max(1, candidate.rank);
  const rankBonus = Math.max(0, 1 - ((rank - 1) / total));
  return 1 + (score * 4) + (rankBonus * 8);
}

function memoryKey(scope: string, id: string): string {
  return `${scope}\u0000${id}`;
}

function applySemanticRecallFloor(results: AionisMemorySearchResult[], input: AionisMemorySearchInternalInput, limit: number): AionisMemorySearchResult[] {
  if (!input.candidateMatches || results.length <= limit) return results.slice(0, limit);
  const floorCount = Math.min(limit, Math.max(1, Math.ceil(limit * 0.2)));
  const topCandidateKeys = new Set(
    Array.from(input.candidateMatches.entries())
      .sort(([, a], [, b]) => a.rank - b.rank || b.score - a.score)
      .slice(0, floorCount)
      .map(([key]) => key),
  );
  if (topCandidateKeys.size === 0) return results.slice(0, limit);

  const selected = results.slice(0, limit);
  const selectedKeys = new Set(selected.map((result) => memoryKey(result.node.scope, result.node.id)));
  const missingFloorResults = results
    .filter((result) => topCandidateKeys.has(memoryKey(result.node.scope, result.node.id)) && !selectedKeys.has(memoryKey(result.node.scope, result.node.id)))
    .sort((a, b) => {
      const aCandidate = input.candidateMatches?.get(memoryKey(a.node.scope, a.node.id));
      const bCandidate = input.candidateMatches?.get(memoryKey(b.node.scope, b.node.id));
      return (aCandidate?.rank ?? Number.MAX_SAFE_INTEGER) - (bCandidate?.rank ?? Number.MAX_SAFE_INTEGER);
    });
  if (missingFloorResults.length === 0) return selected;

  const replaceableResults = selected.filter((result) => !topCandidateKeys.has(memoryKey(result.node.scope, result.node.id)));
  for (const candidate of missingFloorResults) {
    if (replaceableResults.length === 0) break;
    const removed = replaceableResults.pop();
    if (!removed) break;
    const index = selected.findIndex((result) => result.node.scope === removed.node.scope && result.node.id === removed.node.id);
    if (index < 0) continue;
    selected[index] = {
      ...candidate,
      reasons: [
        {
          code: "semantic_recall_floor",
          detail: `kept top semantic candidate within final top ${limit}`,
        },
        ...candidate.reasons,
      ],
    };
  }
  return selected
    .sort((a, b) => {
      const byScore = b.score - a.score;
      if (byScore !== 0) return byScore;
      const byTime = b.node.updatedAt.localeCompare(a.node.updatedAt);
      if (byTime !== 0) return byTime;
      return a.node.id.localeCompare(b.node.id);
    })
    .slice(0, limit);
}

export function searchMemoryNodes(nodes: AionisMemoryNode[], input: AionisMemorySearchInternalInput): AionisMemorySearchResult[] {
  const scope = input.scope.trim();
  if (!scope) throw new Error("scope is required");
  const limit = input.limit === undefined ? MAX_DEFAULT_RESULTS : input.limit;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  if (input.minConfidence !== undefined && (!Number.isFinite(input.minConfidence) || input.minConfidence < 0 || input.minConfidence > 1)) {
    throw new Error("minConfidence must be between 0 and 1");
  }

  const kindFilter = input.kinds === undefined ? null : new Set(input.kinds);
  const lifecycleFilter = input.lifecycle === undefined ? null : new Set(input.lifecycle);
  const authorityFilter = input.authority === undefined ? null : new Set(input.authority);
  const targetFiles = input.targetFiles?.map((item) => item.trim()).filter(Boolean) ?? [];
  const results: AionisMemorySearchResult[] = [];

  for (const node of nodes) {
    if (node.scope !== scope) continue;
    if (kindFilter && !kindFilter.has(node.kind)) continue;
    if (lifecycleFilter && !lifecycleFilter.has(node.lifecycle)) continue;
    if (authorityFilter && !authorityFilter.has(node.authority)) continue;
    if (input.agentId !== undefined && node.agentId !== input.agentId) continue;
    if (input.teamId !== undefined && node.teamId !== input.teamId) continue;
    if (input.minConfidence !== undefined && node.confidence < input.minConfidence) continue;
    if (input.updatedAfter !== undefined && compareIso(node.updatedAt, input.updatedAfter) < 0) continue;
    if (input.updatedBefore !== undefined && compareIso(node.updatedAt, input.updatedBefore) > 0) continue;
    if (!hasAnyTargetFile(node, targetFiles)) continue;

    const candidate = input.candidateMatches?.get(memoryKey(node.scope, node.id)) ?? null;
    const query = queryScore(node, input.query);
    if (query === null && candidate === null) continue;

    const reasons: AionisMemorySearchReason[] = [
      { code: "scope_match", detail: `scope=${scope}` },
      ...(candidate === null ? [] : [
        {
          code: "semantic_candidate_fusion",
          detail: `candidate_rank=${candidate.rank}/${candidate.total}, candidate_score=${candidate.score.toFixed(6)}`,
        },
        ...candidate.reasons,
      ]),
      ...(query?.reasons ?? []),
    ];
    if (kindFilter) reasons.push({ code: "kind_filter", detail: `kind=${node.kind}` });
    if (lifecycleFilter) reasons.push({ code: "lifecycle_filter", detail: `lifecycle=${node.lifecycle}` });
    if (authorityFilter) reasons.push({ code: "authority_filter", detail: `authority=${node.authority}` });
    if (targetFiles.length > 0) reasons.push({ code: "target_file_filter", detail: `matched one of ${targetFiles.join(", ")}` });
    if (input.agentId !== undefined) reasons.push({ code: "agent_filter", detail: `agentId=${String(input.agentId)}` });
    if (input.teamId !== undefined) reasons.push({ code: "team_filter", detail: `teamId=${String(input.teamId)}` });
    if (input.minConfidence !== undefined) reasons.push({ code: "confidence_filter", detail: `confidence>=${input.minConfidence}` });

    const score = (query?.score ?? 0) + node.confidence + (candidate === null ? 0 : candidateBonus(candidate));
    results.push({ node, score, reasons });
  }

  const sorted = results.sort((a, b) => {
      const byScore = b.score - a.score;
      if (byScore !== 0) return byScore;
      const byTime = b.node.updatedAt.localeCompare(a.node.updatedAt);
      if (byTime !== 0) return byTime;
      return a.node.id.localeCompare(b.node.id);
    });
  return applySemanticRecallFloor(sorted, input, limit);
}
