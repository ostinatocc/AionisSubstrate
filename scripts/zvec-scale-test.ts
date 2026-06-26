import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  createZvecCandidateIndex,
  openSqliteAionisSubstrate,
  type AionisCandidateIndex,
  type AionisCandidateIndexHealthReport,
  type AionisMemoryNode,
  type AionisMemorySearchResult,
  type AionisSubstrate,
} from "../src/index.ts";

const VECTOR_DIMENSION = 64;
const EMBEDDING_MODEL = "aionis-local-text-hash-v1";

type ZvecScaleOptions = {
  nodes: number;
  scopes: number;
  relations: number;
  feedback: number;
  probes: number;
  narrowCandidateLimit: number;
  transitions: number;
  output?: string;
  keepStore: boolean;
};

type Timings = Record<string, number>;

type Probe = {
  scope: string;
  seedId: string;
  query: string;
  targetFiles: string[];
};

type ProbeResult = Probe & {
  canonicalIds: string[];
  wideIds: string[];
  narrowIds: string[];
};

type IndexedStore = {
  store: AionisSubstrate;
  candidateIndex: AionisCandidateIndex;
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

function parseOptions(): ZvecScaleOptions {
  const nodes = readNumber("nodes", 10_000);
  const scopes = readNumber("scopes", 10);
  return {
    nodes,
    scopes,
    relations: readNumber("relations", Math.max(1, Math.floor(nodes / 5))),
    feedback: readNumber("feedback", Math.max(1, Math.floor(nodes / 10))),
    probes: readNumber("probes", 100),
    narrowCandidateLimit: readNumber("narrow-candidate-limit", 20),
    transitions: readNumber("transitions", Math.max(1, Math.min(100, Math.floor(nodes / 100)))),
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

function memoryId(scopeIndex: number, localIndex: number): string {
  return `scope-${scopeIndex}-mem-${localIndex}`;
}

function marker(scopeIndex: number, localIndex: number): string {
  return `zvec_scale_marker_${scopeIndex}_${localIndex}`;
}

function tokenize(value: string): string[] {
  return value.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}_./:-]+/gu) ?? [];
}

function l2Normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + (value * value), 0));
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}

function vectorizeText(value: string): number[] | null {
  const tokens = tokenize(value);
  if (tokens.length === 0) return null;
  const vector = Array.from({ length: VECTOR_DIMENSION }, () => 0);
  for (const token of tokens) {
    const hash = createHash("sha256").update(token).digest();
    const index = hash[0] % VECTOR_DIMENSION;
    const sign = (hash[1] & 1) === 0 ? 1 : -1;
    vector[index] += sign;
  }
  return l2Normalize(vector);
}

function metadataText(node: AionisMemoryNode): string {
  return Object.entries(node.metadata ?? {})
    .filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${String(value)}`)
    .join(" ");
}

function nodeText(node: AionisMemoryNode): string {
  return [
    node.id,
    node.title ?? "",
    node.summary,
    node.kind,
    node.lifecycle,
    node.authority,
    ...(node.targetFiles ?? []),
    node.payloadRef ?? "",
    node.agentId ?? "",
    node.teamId ?? "",
    metadataText(node),
  ].filter(Boolean).join(" ");
}

function vectorForNode(node: AionisMemoryNode): number[] | null {
  return vectorizeText(nodeText(node));
}

function vectorForQuery(input: { query?: string | null }): number[] | null {
  return vectorizeText(input.query ?? "");
}

function resultIds(results: AionisMemorySearchResult[]): string[] {
  return results.map((result) => result.node.id);
}

async function pathBytes(path: string): Promise<number> {
  const info = await stat(path);
  if (!info.isDirectory()) return info.size;
  const entries = await readdir(path);
  let total = 0;
  for (const entry of entries) total += await pathBytes(join(path, entry));
  return total;
}

function openIndexedStore(sqlitePath: string, zvecPath: string): Promise<IndexedStore> {
  const candidateIndex = createZvecCandidateIndex({
    path: zvecPath,
    embeddingModel: EMBEDDING_MODEL,
    vectorForNode,
    vectorForQuery,
  });
  return openSqliteAionisSubstrate({ path: sqlitePath, candidateIndex })
    .then((store) => ({ store, candidateIndex }));
}

async function writeNodes(store: AionisSubstrate, options: ZvecScaleOptions): Promise<void> {
  const perScope = Math.ceil(options.nodes / options.scopes);
  let written = 0;
  for (let scopeIndex = 0; scopeIndex < options.scopes && written < options.nodes; scopeIndex += 1) {
    for (let localIndex = 0; localIndex < perScope && written < options.nodes; localIndex += 1) {
      const globalIndex = written;
      const archived = globalIndex % 23 === 0;
      const candidate = !archived && globalIndex % 11 === 0;
      const tracePointer = archived || globalIndex % 29 === 0;
      const currentMarker = marker(scopeIndex, localIndex);
      await store.putNode({
        id: memoryId(scopeIndex, localIndex),
        scope: `scope-${scopeIndex}`,
        kind: tracePointer ? "trace_pointer" : candidate ? "claim" : globalIndex % 5 === 0 ? "fact" : "procedure",
        title: `Zvec scale memory ${globalIndex}`,
        summary: [
          `Substrate Zvec scale memory ${globalIndex}.`,
          `Exact marker ${currentMarker}.`,
          `Runtime verifier state for module-${globalIndex % 97}, target-${globalIndex % 31}, route-${globalIndex % 13}.`,
        ].join(" "),
        lifecycle: archived ? "archived" : candidate ? "candidate" : "active",
        authority: archived ? "trusted" : candidate ? "advisory" : "trusted",
        confidence: archived ? 0.88 : candidate ? 0.56 : 0.66 + ((globalIndex % 30) / 100),
        targetFiles: [`src/module-${globalIndex % 97}.ts`, `tests/route-${globalIndex % 13}.test.ts`],
        payloadRef: tracePointer ? `file://traces/zvec-scale-${globalIndex}.log` : null,
        agentId: `agent-${globalIndex % 4}`,
        teamId: `team-${globalIndex % 3}`,
        metadata: {
          batch: "zvec-scale",
          embedding_model: EMBEDDING_MODEL,
          module: `module-${globalIndex % 97}`,
          route: `route-${globalIndex % 13}`,
          search_marker: currentMarker,
        },
        createdAt: new Date(Date.UTC(2026, 5, 1, 0, 0, globalIndex % 60)).toISOString(),
        updatedAt: new Date(Date.UTC(2026, 5, 1, 0, Math.floor(globalIndex / 60), globalIndex % 60)).toISOString(),
      });
      written += 1;
    }
  }
}

async function writeRelations(store: AionisSubstrate, options: ZvecScaleOptions): Promise<number> {
  const perScope = Math.ceil(options.nodes / options.scopes);
  let written = 0;
  for (let index = 0; index < options.relations; index += 1) {
    const scopeIndex = index % options.scopes;
    const sourceLocal = (index * 17) % perScope;
    const targetLocal = (sourceLocal + 1) % perScope;
    if ((scopeIndex * perScope) + Math.max(sourceLocal, targetLocal) >= options.nodes) continue;
    await store.putRelation({
      id: `zvec-scale-rel-${index}`,
      scope: `scope-${scopeIndex}`,
      kind: index % 3 === 0 ? "supersedes" : index % 3 === 1 ? "supports" : "requires_payload",
      sourceId: memoryId(scopeIndex, sourceLocal),
      targetId: memoryId(scopeIndex, targetLocal),
      confidence: 0.72,
      reasons: ["zvec scale relation probe"],
    });
    written += 1;
  }
  return written;
}

async function writeFeedback(store: AionisSubstrate, options: ZvecScaleOptions): Promise<number> {
  const perScope = Math.ceil(options.nodes / options.scopes);
  let written = 0;
  for (let index = 0; index < options.feedback; index += 1) {
    const scopeIndex = index % options.scopes;
    const localIndex = (index * 23) % perScope;
    if ((scopeIndex * perScope) + localIndex >= options.nodes) continue;
    await store.recordFeedback({
      id: `zvec-scale-feedback-${index}`,
      scope: `scope-${scopeIndex}`,
      memoryId: memoryId(scopeIndex, localIndex),
      outcome: index % 5 === 0 ? "negative" : "positive",
      strength: index % 5 === 0 ? "weak" : "strong",
      runId: `zvec-scale-run-${index}`,
      evidenceRef: `trace://zvec-scale/${index}`,
    });
    written += 1;
  }
  return written;
}

async function listAllNodes(store: AionisSubstrate, scopes: number): Promise<AionisMemoryNode[]> {
  const out: AionisMemoryNode[] = [];
  for (let scopeIndex = 0; scopeIndex < scopes; scopeIndex += 1) {
    out.push(...await store.listNodes(`scope-${scopeIndex}`));
  }
  return out.sort((a, b) => a.scope.localeCompare(b.scope) || a.id.localeCompare(b.id));
}

function chooseProbes(nodes: AionisMemoryNode[], count: number): Probe[] {
  const candidates = nodes.filter((node) => node.summary.includes("Exact marker"));
  if (candidates.length === 0) throw new Error("cannot choose probes without generated marker nodes");
  const probes: Probe[] = [];
  const seen = new Set<string>();
  for (let index = 0; probes.length < Math.min(count, candidates.length); index += 1) {
    const candidate = candidates[(index * 37) % candidates.length];
    const key = `${candidate.scope}\0${candidate.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    probes.push({
      scope: candidate.scope,
      seedId: candidate.id,
      query: nodeText(candidate),
      targetFiles: candidate.targetFiles?.slice(0, 1) ?? [],
    });
  }
  return probes;
}

async function runProbeSet(store: AionisSubstrate, probes: Probe[], candidateLimit?: number): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const probe of probes) {
    const results = await store.searchNodes({
      scope: probe.scope,
      query: probe.query,
      targetFiles: probe.targetFiles,
      embeddingModel: EMBEDDING_MODEL,
      candidateLimit,
      limit: 10,
    });
    out.set(`${probe.scope}\0${probe.seedId}`, resultIds(results));
  }
  return out;
}

function sameIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function summarizeProbes(probes: Probe[], canonical: Map<string, string[]>, wide: Map<string, string[]>, narrow: Map<string, string[]>): {
  results: ProbeResult[];
  canonicalSeedHits: number;
  wideParityHits: number;
  narrowSeedHits: number;
} {
  const results: ProbeResult[] = [];
  let canonicalSeedHits = 0;
  let wideParityHits = 0;
  let narrowSeedHits = 0;
  for (const probe of probes) {
    const key = `${probe.scope}\0${probe.seedId}`;
    const canonicalIds = canonical.get(key) ?? [];
    const wideIds = wide.get(key) ?? [];
    const narrowIds = narrow.get(key) ?? [];
    if (canonicalIds.includes(probe.seedId)) canonicalSeedHits += 1;
    if (sameIds(canonicalIds, wideIds)) wideParityHits += 1;
    if (narrowIds.includes(probe.seedId)) narrowSeedHits += 1;
    results.push({ ...probe, canonicalIds, wideIds, narrowIds });
  }
  return { results, canonicalSeedHits, wideParityHits, narrowSeedHits };
}

async function transitionNodes(store: AionisSubstrate, nodes: AionisMemoryNode[], count: number): Promise<string[]> {
  const selected = nodes
    .filter((node) => node.lifecycle === "active" && (node.authority === "trusted" || node.authority === "verified"))
    .slice(0, count);
  for (const node of selected) {
    await store.transitionLifecycle({
      scope: node.scope,
      memoryId: node.id,
      lifecycle: "retired",
      authority: "rejected",
      confidence: 0.05,
      reason: "zvec scale maintenance transition",
    });
  }
  return selected.map((node) => node.id);
}

function assertHealth(label: string, health: AionisCandidateIndexHealthReport): void {
  if (health.ok) return;
  throw new Error(`${label} failed: missing=${health.missingNodeIds.length}, orphan=${health.orphanNodeIds.length}, stale=${health.staleNodeIds.length}`);
}

async function main(): Promise<void> {
  const options = parseOptions();
  const timings: Timings = {};
  const tempDir = await mkdtemp(join(tmpdir(), "aionis-substrate-zvec-scale-"));
  const reportDir = options.output ?? join("reports", `zvec-scale-${new Date().toISOString().replaceAll(":", "-")}`);
  const sqlitePath = join(tempDir, "substrate.sqlite");
  const zvecPath = join(tempDir, "substrate.zvec");
  let indexed: IndexedStore | null = null;
  let baseline: AionisSubstrate | null = null;

  try {
    await mkdir(reportDir, { recursive: true });
    indexed = await openIndexedStore(sqlitePath, zvecPath);

    await time(timings, "write_nodes_with_zvec_ms", async () => writeNodes(indexed!.store, options));
    const relationCount = await time(timings, "write_relations_ms", async () => writeRelations(indexed!.store, options));
    const feedbackCount = await time(timings, "write_feedback_ms", async () => writeFeedback(indexed!.store, options));
    const allNodesAfterWrite = await time(timings, "list_nodes_after_write_ms", async () => listAllNodes(indexed!.store, options.scopes));
    const healthAfterWrite = await time(timings, "zvec_verify_after_write_ms", async () => indexed!.candidateIndex.verify(allNodesAfterWrite));
    assertHealth("zvec verify after write", healthAfterWrite);
    const probes = chooseProbes(allNodesAfterWrite, options.probes);
    await time(timings, "close_indexed_after_write_ms", async () => indexed!.store.close());
    indexed = null;

    baseline = await openSqliteAionisSubstrate({ path: sqlitePath });
    const canonical = await time(timings, "canonical_probe_search_ms", async () => runProbeSet(baseline!, probes));
    await time(timings, "close_baseline_ms", async () => baseline!.close());
    baseline = null;

    indexed = await time(timings, "indexed_reopen_and_rebuild_ms", async () => openIndexedStore(sqlitePath, zvecPath));
    const allNodesAfterReopen = await listAllNodes(indexed.store, options.scopes);
    const healthAfterReopen = await time(timings, "zvec_verify_after_reopen_ms", async () => indexed!.candidateIndex.verify(allNodesAfterReopen));
    assertHealth("zvec verify after reopen", healthAfterReopen);
    const maxScopeSize = Math.ceil(options.nodes / options.scopes);
    const wide = await time(timings, "wide_zvec_probe_search_ms", async () => runProbeSet(indexed!.store, probes, maxScopeSize));
    const narrow = await time(timings, "narrow_zvec_probe_search_ms", async () => runProbeSet(indexed!.store, probes, options.narrowCandidateLimit));
    const probeSummary = summarizeProbes(probes, canonical, wide, narrow);

    if (probeSummary.canonicalSeedHits !== probes.length) {
      throw new Error(`canonical probe fixture failed: ${probeSummary.canonicalSeedHits}/${probes.length} seed hits`);
    }
    if (probeSummary.wideParityHits !== probes.length) {
      throw new Error(`wide Zvec parity failed: ${probeSummary.wideParityHits}/${probes.length} parity hits`);
    }
    if (probeSummary.narrowSeedHits !== probes.length) {
      throw new Error(`narrow Zvec seed recovery failed: ${probeSummary.narrowSeedHits}/${probes.length} seed hits`);
    }

    const transitionedMemoryIds = await time(timings, "transition_nodes_with_zvec_ms", async () => transitionNodes(indexed!.store, allNodesAfterReopen, options.transitions));
    const allNodesAfterTransitions = await listAllNodes(indexed.store, options.scopes);
    const healthAfterTransitions = await time(timings, "zvec_verify_after_transitions_ms", async () => indexed!.candidateIndex.verify(allNodesAfterTransitions));
    assertHealth("zvec verify after transitions", healthAfterTransitions);

    const compaction = await time(timings, "compact_ms", async () => indexed!.store.compact());
    const allNodesAfterCompact = await listAllNodes(indexed.store, options.scopes);
    const healthAfterCompact = await time(timings, "zvec_verify_after_compact_ms", async () => indexed!.candidateIndex.verify(allNodesAfterCompact));
    assertHealth("zvec verify after compact", healthAfterCompact);
    await time(timings, "close_indexed_after_compact_ms", async () => indexed!.store.close());
    indexed = null;

    indexed = await time(timings, "post_compact_reopen_and_rebuild_ms", async () => openIndexedStore(sqlitePath, zvecPath));
    const allNodesAfterCompactReopen = await listAllNodes(indexed.store, options.scopes);
    const healthAfterCompactReopen = await time(timings, "zvec_verify_after_compact_reopen_ms", async () => indexed!.candidateIndex.verify(allNodesAfterCompactReopen));
    assertHealth("zvec verify after compact reopen", healthAfterCompactReopen);
    const storeInfo = await indexed.store.getStoreInfo();
    const sqliteBytes = await pathBytes(sqlitePath);
    const zvecBytes = await pathBytes(zvecPath);

    const report = {
      contract_version: "aionis_zvec_scale_maintenance_report_v1",
      generated_at: new Date().toISOString(),
      adapter: "sqlite",
      candidate_index: "zvec",
      embedding_model: EMBEDDING_MODEL,
      vector_dimension: VECTOR_DIMENSION,
      requested: options,
      actual: {
        nodes: allNodesAfterWrite.length,
        relations: relationCount,
        feedback: feedbackCount,
        probes: probes.length,
        transitions: transitionedMemoryIds.length,
        canonical_seed_hits: probeSummary.canonicalSeedHits,
        wide_parity_hits: probeSummary.wideParityHits,
        narrow_seed_hits: probeSummary.narrowSeedHits,
        wide_parity_rate: probeSummary.wideParityHits / probes.length,
        narrow_seed_hit_rate: probeSummary.narrowSeedHits / probes.length,
        sqlite_bytes: sqliteBytes,
        zvec_bytes: zvecBytes,
        compaction,
        store_info: storeInfo,
      },
      zvec_health: {
        after_write: healthAfterWrite,
        after_reopen: healthAfterReopen,
        after_transitions: healthAfterTransitions,
        after_compact: healthAfterCompact,
        after_compact_reopen: healthAfterCompactReopen,
      },
      transitioned_memory_ids_sample: transitionedMemoryIds.slice(0, 20),
      probe_sample: probeSummary.results.slice(0, 20),
      timings,
    };

    const reportPath = join(reportDir, "summary.json");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      report: reportPath,
      nodes: report.actual.nodes,
      relations: relationCount,
      feedback: feedbackCount,
      transitions: transitionedMemoryIds.length,
      probes: probes.length,
      wide_parity_rate: report.actual.wide_parity_rate,
      narrow_seed_hit_rate: report.actual.narrow_seed_hit_rate,
      sqlite_bytes: sqliteBytes,
      zvec_bytes: zvecBytes,
      timings,
    }, null, 2));
  } finally {
    if (indexed) await indexed.store.close().catch(() => undefined);
    if (baseline) await baseline.close().catch(() => undefined);
    if (!options.keepStore) await rm(tempDir, { recursive: true, force: true });
  }
}

await main();
