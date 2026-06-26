import { DatabaseSync } from "node:sqlite";
import { readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { runRuntimeSnapshotParity, type RuntimeReferenceSurfaces } from "./runtime-snapshot-parity.ts";
import type { RuntimeSnapshotImportDiagnostics } from "./runtime-snapshot-importer.ts";

export type RuntimeSnapshotCorpusScopeCandidate = {
  source_path: string;
  scope: string;
  node_count: number;
  first_created_at: string | null;
  last_created_at: string | null;
};

export type RuntimeSnapshotCorpusScopeReport = {
  source_path: string;
  scope: string;
  node_count: number;
  status: "passed" | "failed";
  nodes_imported: number;
  nodes_skipped: number;
  import_diagnostics: RuntimeSnapshotImportDiagnostics | null;
  warnings: string[];
  bucket_counts: Record<keyof RuntimeReferenceSurfaces, number>;
  error: string | null;
};

export type RuntimeSnapshotCorpusReport = {
  contract_version: "aionis_runtime_snapshot_corpus_report_v1";
  generated_at: string;
  roots: string[];
  options: {
    max_files: number | null;
    max_scopes: number | null;
    max_scopes_per_file: number;
    min_nodes: number;
    max_per_bucket: number | null;
  };
  discovered_sqlite_files: number;
  runtime_sqlite_files: number;
  candidate_scopes: RuntimeSnapshotCorpusScopeCandidate[];
  attempted_scopes: number;
  passed_scopes: number;
  failed_scopes: number;
  total_nodes_imported: number;
  total_nodes_skipped: number;
  total_warnings: number;
  scan_warnings: string[];
  scope_reports: RuntimeSnapshotCorpusScopeReport[];
};

export type RuntimeSnapshotCorpusOptions = {
  rootPaths: string[];
  outputPath?: string;
  maxFiles?: number | null;
  maxScopes?: number | null;
  maxScopesPerFile?: number;
  minNodes?: number;
  maxPerBucket?: number;
};

type RuntimeScopeRow = {
  scope: string;
  node_count: number;
  first_created_at: string | null;
  last_created_at: string | null;
};

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

function readScopeCandidates(sourcePath: string, maxScopesPerFile: number, minNodes: number): RuntimeSnapshotCorpusScopeCandidate[] {
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
    `).all(minNodes, maxScopesPerFile) as RuntimeScopeRow[];
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

function countBuckets(surfaces: RuntimeReferenceSurfaces): Record<keyof RuntimeReferenceSurfaces, number> {
  return {
    use_now: surfaces.use_now.length,
    inspect_before_use: surfaces.inspect_before_use.length,
    do_not_use: surfaces.do_not_use.length,
    rehydrate: surfaces.rehydrate.length,
  };
}

export async function runRuntimeSnapshotCorpus(options: RuntimeSnapshotCorpusOptions): Promise<RuntimeSnapshotCorpusReport> {
  if (options.rootPaths.length === 0) throw new Error("at least one root path is required");
  const maxFiles = options.maxFiles === undefined ? null : options.maxFiles;
  const maxScopes = options.maxScopes === undefined ? null : options.maxScopes;
  const maxScopesPerFile = options.maxScopesPerFile ?? 3;
  const minNodes = options.minNodes ?? 1;
  const scanWarnings: string[] = [];
  const sqliteFiles = await findSqliteFiles(options.rootPaths, scanWarnings);
  const candidateScopes: RuntimeSnapshotCorpusScopeCandidate[] = [];
  let runtimeSqliteFiles = 0;

  for (const file of sqliteFiles) {
    if (maxFiles !== null && runtimeSqliteFiles >= maxFiles) break;
    try {
      const scopes = readScopeCandidates(file, maxScopesPerFile, minNodes);
      if (scopes.length === 0) continue;
      runtimeSqliteFiles += 1;
      candidateScopes.push(...scopes);
    } catch (err) {
      scanWarnings.push(`${file}: failed to inspect Runtime scopes (${(err as Error).message})`);
    }
  }

  candidateScopes.sort((a, b) => b.node_count - a.node_count || a.source_path.localeCompare(b.source_path) || a.scope.localeCompare(b.scope));
  const selectedScopes = maxScopes === null ? candidateScopes : candidateScopes.slice(0, maxScopes);
  const scopeReports: RuntimeSnapshotCorpusScopeReport[] = [];

  for (const candidate of selectedScopes) {
    try {
      const report = await runRuntimeSnapshotParity({
        sourcePath: candidate.source_path,
        scope: candidate.scope,
        maxPerBucket: options.maxPerBucket,
      });
      scopeReports.push({
        source_path: candidate.source_path,
        scope: candidate.scope,
        node_count: candidate.node_count,
        status: "passed",
        nodes_imported: report.import_summary.nodesImported,
        nodes_skipped: report.import_summary.nodesSkipped,
        import_diagnostics: report.import_summary.diagnostics,
        warnings: report.import_summary.warnings,
        bucket_counts: countBuckets(report.substrate_context),
        error: null,
      });
    } catch (err) {
      scopeReports.push({
        source_path: candidate.source_path,
        scope: candidate.scope,
        node_count: candidate.node_count,
        status: "failed",
        nodes_imported: 0,
        nodes_skipped: 0,
        import_diagnostics: null,
        warnings: [],
        bucket_counts: { use_now: 0, inspect_before_use: 0, do_not_use: 0, rehydrate: 0 },
        error: (err as Error).message,
      });
    }
  }

  const report: RuntimeSnapshotCorpusReport = {
    contract_version: "aionis_runtime_snapshot_corpus_report_v1",
    generated_at: new Date().toISOString(),
    roots: options.rootPaths.map((rootPath) => resolve(rootPath)),
    options: {
      max_files: maxFiles,
      max_scopes: maxScopes,
      max_scopes_per_file: maxScopesPerFile,
      min_nodes: minNodes,
      max_per_bucket: options.maxPerBucket ?? null,
    },
    discovered_sqlite_files: sqliteFiles.length,
    runtime_sqlite_files: runtimeSqliteFiles,
    candidate_scopes: candidateScopes,
    attempted_scopes: scopeReports.length,
    passed_scopes: scopeReports.filter((scope) => scope.status === "passed").length,
    failed_scopes: scopeReports.filter((scope) => scope.status === "failed").length,
    total_nodes_imported: scopeReports.reduce((sum, scope) => sum + scope.nodes_imported, 0),
    total_nodes_skipped: scopeReports.reduce((sum, scope) => sum + scope.nodes_skipped, 0),
    total_warnings: scanWarnings.length + scopeReports.reduce((sum, scope) => sum + scope.warnings.length, 0),
    scan_warnings: scanWarnings,
    scope_reports: scopeReports,
  };

  if (options.outputPath) {
    const outputPath = resolve(options.outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  return report;
}
