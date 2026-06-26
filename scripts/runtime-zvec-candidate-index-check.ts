import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  createZvecCandidateIndex,
  importRuntimeLiteSnapshot,
  openSqliteAionisSubstrate,
  type AionisMemoryNode,
  type AionisMemorySearchResult,
} from "../src/index.ts";

const VECTOR_DIMENSION = 64;
const EMBEDDING_MODEL = "aionis-local-text-hash-v1";

type Args = {
  roots: string[];
  output?: string;
  maxFiles: number | null;
  maxScopes: number | null;
  maxScopesPerFile: number;
  minNodes: number;
  probesPerScope: number;
  narrowCandidateLimit: number;
  resultLimit: number;
  keepStore: boolean;
};

type ScopeCandidate = {
  source_path: string;
  scope: string;
  node_count: number;
  first_created_at: string | null;
  last_created_at: string | null;
};

type ProbeReport = {
  memory_id: string;
  query_preview: string;
  canonical_ids: string[];
  zvec_wide_ids: string[];
  zvec_narrow_ids: string[];
  canonical_contains_seed: boolean;
  wide_matches_canonical: boolean;
  narrow_contains_seed: boolean;
};

type ScopeReport = {
  source_path: string;
  scope: string;
  source_node_count: number;
  status: "passed" | "failed";
  nodes_read: number;
  nodes_imported: number;
  nodes_skipped: number;
  vector_indexable_nodes: number;
  zvec_health: {
    ok: boolean;
    sourceCount: number;
    indexedCount: number;
    missingNodeIds: string[];
    orphanNodeIds: string[];
    staleNodeIds: string[];
  } | null;
  probes_attempted: number;
  canonical_seed_hits: number;
  wide_parity_hits: number;
  narrow_seed_hits: number;
  timings_ms: Record<string, number>;
  probes: ProbeReport[];
  warnings: string[];
  error: string | null;
};

type Report = {
  contract_version: "aionis_runtime_zvec_candidate_index_check_v1";
  generated_at: string;
  roots: string[];
  options: {
    max_files: number | null;
    max_scopes: number | null;
    max_scopes_per_file: number;
    min_nodes: number;
    probes_per_scope: number;
    narrow_candidate_limit: number;
    result_limit: number;
    embedding_model: typeof EMBEDDING_MODEL;
    vector_dimension: typeof VECTOR_DIMENSION;
  };
  discovered_sqlite_files: number;
  runtime_sqlite_files: number;
  candidate_scopes: ScopeCandidate[];
  attempted_scopes: number;
  passed_scopes: number;
  failed_scopes: number;
  total_nodes_read: number;
  total_nodes_imported: number;
  total_vector_indexable_nodes: number;
  total_probes_attempted: number;
  total_wide_parity_hits: number;
  total_narrow_seed_hits: number;
  scan_warnings: string[];
  scope_reports: ScopeReport[];
};

function usage(): string {
  return [
    "Usage:",
    "  node scripts/runtime-zvec-candidate-index-check.ts --root /path/runtime/.tmp [--output report.json]",
    "",
    "Reads real Runtime Lite SQLite snapshots, imports selected scopes into isolated Substrate SQLite stores,",
    "builds an optional Zvec candidate index, and verifies health plus canonical-search parity.",
  ].join("\n");
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function parseOptionalLimit(raw: string | undefined, label: string): number | null {
  if (raw === undefined || raw === "all") return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer or 'all'`);
  return value;
}

function parsePositiveInteger(raw: string | undefined, label: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    roots: [],
    maxFiles: null,
    maxScopes: null,
    maxScopesPerFile: 3,
    minNodes: 3,
    probesPerScope: 5,
    narrowCandidateLimit: 20,
    resultLimit: 10,
    keepStore: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--root") {
      args.roots.push(readValue(argv, i, flag));
      i += 1;
    } else if (flag === "--output") {
      args.output = readValue(argv, i, flag);
      i += 1;
    } else if (flag === "--max-files") {
      args.maxFiles = parseOptionalLimit(readValue(argv, i, flag), flag);
      i += 1;
    } else if (flag === "--max-scopes") {
      args.maxScopes = parseOptionalLimit(readValue(argv, i, flag), flag);
      i += 1;
    } else if (flag === "--max-scopes-per-file") {
      args.maxScopesPerFile = parsePositiveInteger(readValue(argv, i, flag), flag);
      i += 1;
    } else if (flag === "--min-nodes") {
      args.minNodes = parsePositiveInteger(readValue(argv, i, flag), flag);
      i += 1;
    } else if (flag === "--probes-per-scope") {
      args.probesPerScope = parsePositiveInteger(readValue(argv, i, flag), flag);
      i += 1;
    } else if (flag === "--narrow-candidate-limit") {
      args.narrowCandidateLimit = parsePositiveInteger(readValue(argv, i, flag), flag);
      i += 1;
    } else if (flag === "--result-limit") {
      args.resultLimit = parsePositiveInteger(readValue(argv, i, flag), flag);
      i += 1;
    } else if (flag === "--keep-store") {
      args.keepStore = true;
    } else if (flag === "--help" || flag === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }

  if (args.roots.length === 0) throw new Error("--root is required");
  return args;
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as { name?: string } | undefined;
  return row?.name === tableName;
}

function isSqliteLike(path: string): boolean {
  return /\.(sqlite|sqlite3|db)$/i.test(path);
}

async function walkSqliteFiles(rootPath: string): Promise<string[]> {
  const root = resolve(rootPath);
  const rootStat = await stat(root);
  if (rootStat.isFile()) return isSqliteLike(root) ? [root] : [];

  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        await walk(fullPath);
      } else if (entry.isFile() && isSqliteLike(fullPath)) {
        out.push(fullPath);
      }
    }
  }
  await walk(root);
  return out.sort((a, b) => a.localeCompare(b));
}

async function findSqliteFiles(rootPaths: string[], warnings: string[]): Promise<string[]> {
  const files = new Set<string>();
  for (const rootPath of rootPaths) {
    try {
      for (const file of await walkSqliteFiles(rootPath)) files.add(file);
    } catch (err) {
      warnings.push(`${rootPath}: failed to scan (${(err as Error).message})`);
    }
  }
  return [...files].sort((a, b) => a.localeCompare(b));
}

function readScopeCandidates(sourcePath: string, maxScopesPerFile: number, minNodes: number): ScopeCandidate[] {
  const db = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    if (!tableExists(db, "lite_memory_nodes")) return [];
    const rows = db.prepare(`
      SELECT
        scope,
        COUNT(*) AS node_count,
        MIN(created_at) AS first_created_at,
        MAX(created_at) AS last_created_at
      FROM lite_memory_nodes
      GROUP BY scope
      HAVING COUNT(*) >= ?
      ORDER BY node_count DESC, scope ASC
      LIMIT ?
    `).all(minNodes, maxScopesPerFile) as Array<{
      scope: string;
      node_count: number;
      first_created_at: string | null;
      last_created_at: string | null;
    }>;
    return rows.map((row) => ({
      source_path: sourcePath,
      scope: row.scope,
      node_count: Number(row.node_count),
      first_created_at: row.first_created_at,
      last_created_at: row.last_created_at,
    }));
  } finally {
    db.close();
  }
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

function nodeText(node: AionisMemoryNode): string {
  return [
    node.title ?? "",
    node.summary,
    node.kind,
    node.lifecycle,
    node.authority,
    ...(node.targetFiles ?? []),
  ].filter(Boolean).join(" ");
}

function vectorForNode(node: AionisMemoryNode): number[] | null {
  return vectorizeText(nodeText(node));
}

function ids(results: AionisMemorySearchResult[]): string[] {
  return results.map((result) => result.node.id);
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function chooseProbeNodes(nodes: AionisMemoryNode[], probesPerScope: number): AionisMemoryNode[] {
  return nodes
    .filter((node) => vectorForNode(node))
    .sort((a, b) => b.confidence - a.confidence || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    .slice(0, probesPerScope);
}

async function time<T>(timings: Record<string, number>, name: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    timings[name] = Math.round(performance.now() - start);
  }
}

async function runScope(candidate: ScopeCandidate, args: Args, baseDir: string): Promise<ScopeReport> {
  const timings: Record<string, number> = {};
  const warnings: string[] = [];
  const targetPath = join(baseDir, `${createHash("sha256").update(candidate.source_path).update(candidate.scope).digest("hex")}.sqlite`);
  const zvecPath = join(baseDir, `${createHash("sha256").update(candidate.source_path).update(candidate.scope).digest("hex")}.zvec`);
  let baseline = await openSqliteAionisSubstrate({ path: targetPath });
  try {
    const importSummary = await time(timings, "import_ms", async () => importRuntimeLiteSnapshot({
      sourcePath: candidate.source_path,
      scope: candidate.scope,
      target: baseline,
    }));
    warnings.push(...importSummary.warnings);

    const nodes = await time(timings, "list_nodes_ms", async () => baseline.listNodes(candidate.scope));
    const probeNodes = chooseProbeNodes(nodes, args.probesPerScope);
    const canonicalById = new Map<string, string[]>();
    for (const node of probeNodes) {
      const canonical = await baseline.searchNodes({
        scope: candidate.scope,
        query: nodeText(node),
        limit: args.resultLimit,
      });
      canonicalById.set(node.id, ids(canonical));
    }
    await baseline.close();

    const candidateIndex = createZvecCandidateIndex({
      path: zvecPath,
      embeddingModel: EMBEDDING_MODEL,
      vectorForNode,
      vectorForQuery: (input) => vectorizeText(input.query ?? ""),
    });
    const indexed = await time(timings, "open_rebuild_zvec_ms", async () => openSqliteAionisSubstrate({
      path: targetPath,
      candidateIndex,
    }));
    try {
      const indexedNodes = await indexed.listNodes(candidate.scope);
      const health = await time(timings, "verify_zvec_ms", async () => candidateIndex.verify(indexedNodes));
      const probes: ProbeReport[] = [];

      for (const node of probeNodes) {
        const query = nodeText(node);
        const queryVector = vectorizeText(query);
        if (!queryVector) continue;
        const wide = await indexed.searchNodes({
          scope: candidate.scope,
          query,
          queryVector,
          embeddingModel: EMBEDDING_MODEL,
          candidateLimit: Math.max(indexedNodes.length, args.resultLimit),
          limit: args.resultLimit,
        });
        const narrow = await indexed.searchNodes({
          scope: candidate.scope,
          query,
          queryVector,
          embeddingModel: EMBEDDING_MODEL,
          candidateLimit: args.narrowCandidateLimit,
          limit: args.resultLimit,
        });
        const canonicalIds = canonicalById.get(node.id) ?? [];
        const wideIds = ids(wide);
        const narrowIds = ids(narrow);
        probes.push({
          memory_id: node.id,
          query_preview: query.slice(0, 180),
          canonical_ids: canonicalIds,
          zvec_wide_ids: wideIds,
          zvec_narrow_ids: narrowIds,
          canonical_contains_seed: canonicalIds.includes(node.id),
          wide_matches_canonical: sameIds(canonicalIds, wideIds),
          narrow_contains_seed: narrowIds.includes(node.id),
        });
      }

      const canonicalSeedHits = probes.filter((probe) => probe.canonical_contains_seed).length;
      const wideParityHits = probes.filter((probe) => probe.wide_matches_canonical).length;
      const narrowSeedHits = probes.filter((probe) => probe.narrow_contains_seed).length;
      const status = health.ok && probes.length > 0 && wideParityHits === probes.length && narrowSeedHits === probes.length
        ? "passed"
        : "failed";
      return {
        source_path: candidate.source_path,
        scope: candidate.scope,
        source_node_count: candidate.node_count,
        status,
        nodes_read: importSummary.nodesRead,
        nodes_imported: importSummary.nodesImported,
        nodes_skipped: importSummary.nodesSkipped,
        vector_indexable_nodes: indexedNodes.filter((node) => vectorForNode(node)).length,
        zvec_health: health,
        probes_attempted: probes.length,
        canonical_seed_hits: canonicalSeedHits,
        wide_parity_hits: wideParityHits,
        narrow_seed_hits: narrowSeedHits,
        timings_ms: timings,
        probes,
        warnings,
        error: null,
      };
    } finally {
      await indexed.close();
    }
  } catch (err) {
    await baseline.close().catch(() => undefined);
    return {
      source_path: candidate.source_path,
      scope: candidate.scope,
      source_node_count: candidate.node_count,
      status: "failed",
      nodes_read: 0,
      nodes_imported: 0,
      nodes_skipped: 0,
      vector_indexable_nodes: 0,
      zvec_health: null,
      probes_attempted: 0,
      canonical_seed_hits: 0,
      wide_parity_hits: 0,
      narrow_seed_hits: 0,
      timings_ms: timings,
      probes: [],
      warnings,
      error: (err as Error).message,
    };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const scanWarnings: string[] = [];
  const sqliteFiles = await findSqliteFiles(args.roots, scanWarnings);
  const candidateScopes: ScopeCandidate[] = [];
  let runtimeSqliteFiles = 0;

  for (const file of sqliteFiles) {
    if (args.maxFiles !== null && runtimeSqliteFiles >= args.maxFiles) break;
    try {
      const scopes = readScopeCandidates(file, args.maxScopesPerFile, args.minNodes);
      if (scopes.length === 0) continue;
      runtimeSqliteFiles += 1;
      candidateScopes.push(...scopes);
    } catch (err) {
      scanWarnings.push(`${file}: failed to inspect Runtime scopes (${(err as Error).message})`);
    }
  }

  candidateScopes.sort((a, b) => b.node_count - a.node_count || a.source_path.localeCompare(b.source_path) || a.scope.localeCompare(b.scope));
  const selectedScopes = args.maxScopes === null ? candidateScopes : candidateScopes.slice(0, args.maxScopes);
  const tempDir = await mkdtemp(join(tmpdir(), "aionis-runtime-zvec-check-"));
  const output = args.output
    ? resolve(args.output)
    : resolve("reports", `runtime-zvec-candidate-index-${new Date().toISOString().replace(/[:.]/g, "-")}`, "summary.json");

  try {
    const scopeReports: ScopeReport[] = [];
    for (const candidate of selectedScopes) {
      scopeReports.push(await runScope(candidate, args, tempDir));
    }

    const report: Report = {
      contract_version: "aionis_runtime_zvec_candidate_index_check_v1",
      generated_at: new Date().toISOString(),
      roots: args.roots.map((root) => resolve(root)),
      options: {
        max_files: args.maxFiles,
        max_scopes: args.maxScopes,
        max_scopes_per_file: args.maxScopesPerFile,
        min_nodes: args.minNodes,
        probes_per_scope: args.probesPerScope,
        narrow_candidate_limit: args.narrowCandidateLimit,
        result_limit: args.resultLimit,
        embedding_model: EMBEDDING_MODEL,
        vector_dimension: VECTOR_DIMENSION,
      },
      discovered_sqlite_files: sqliteFiles.length,
      runtime_sqlite_files: runtimeSqliteFiles,
      candidate_scopes: candidateScopes,
      attempted_scopes: scopeReports.length,
      passed_scopes: scopeReports.filter((scope) => scope.status === "passed").length,
      failed_scopes: scopeReports.filter((scope) => scope.status === "failed").length,
      total_nodes_read: scopeReports.reduce((sum, scope) => sum + scope.nodes_read, 0),
      total_nodes_imported: scopeReports.reduce((sum, scope) => sum + scope.nodes_imported, 0),
      total_vector_indexable_nodes: scopeReports.reduce((sum, scope) => sum + scope.vector_indexable_nodes, 0),
      total_probes_attempted: scopeReports.reduce((sum, scope) => sum + scope.probes_attempted, 0),
      total_wide_parity_hits: scopeReports.reduce((sum, scope) => sum + scope.wide_parity_hits, 0),
      total_narrow_seed_hits: scopeReports.reduce((sum, scope) => sum + scope.narrow_seed_hits, 0),
      scan_warnings: scanWarnings,
      scope_reports: scopeReports,
    };

    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      output,
      discovered_sqlite_files: report.discovered_sqlite_files,
      runtime_sqlite_files: report.runtime_sqlite_files,
      attempted_scopes: report.attempted_scopes,
      passed_scopes: report.passed_scopes,
      failed_scopes: report.failed_scopes,
      total_nodes_imported: report.total_nodes_imported,
      total_vector_indexable_nodes: report.total_vector_indexable_nodes,
      total_probes_attempted: report.total_probes_attempted,
      wide_parity_rate: report.total_probes_attempted === 0 ? 0 : report.total_wide_parity_hits / report.total_probes_attempted,
      narrow_seed_hit_rate: report.total_probes_attempted === 0 ? 0 : report.total_narrow_seed_hits / report.total_probes_attempted,
    }, null, 2));

    if (report.attempted_scopes === 0 || report.failed_scopes > 0) process.exitCode = 1;
  } finally {
    if (!args.keepStore) await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error((err as Error).stack ?? String(err));
  console.error(usage());
  process.exit(1);
});
