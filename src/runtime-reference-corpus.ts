import { DatabaseSync } from "node:sqlite";
import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  extractRuntimeReferenceSurfaces,
  runRuntimeSnapshotParity,
  type RuntimeReferenceSurfaces,
  type RuntimeSnapshotParityBucket,
} from "./runtime-snapshot-parity.ts";

export type RuntimeReferenceCandidate = {
  reference_path: string;
  id_count: number;
  ids_sample: string[];
  surfaces: RuntimeReferenceSurfaces;
};

export type RuntimeReferenceScopeCandidate = {
  source_path: string;
  scope: string;
  node_count: number;
  ids_sample: string[];
};

export type RuntimeReferenceCorpusMatchedReport = {
  reference_path: string;
  source_path: string;
  scope: string;
  status: "passed" | "failed";
  reference_id_count: number;
  runtime_scope_node_count: number;
  overlap_count: number;
  overlap_ids_sample: string[];
  parity_exact: boolean | null;
  bucket_reports: RuntimeSnapshotParityBucket[];
  error: string | null;
};

export type RuntimeReferenceCorpusUnmatchedReport = {
  reference_path: string;
  reference_id_count: number;
  ids_sample: string[];
  reason: "no_reference_surface_ids" | "no_runtime_scope_overlap";
};

export type RuntimeReferenceCorpusReport = {
  contract_version: "aionis_runtime_reference_corpus_report_v1";
  generated_at: string;
  source_roots: string[];
  reference_roots: string[];
  options: {
    max_source_files: number | null;
    max_scopes: number | null;
    max_scopes_per_file: number;
    max_references: number | null;
    min_nodes: number;
    min_overlap: number;
    max_per_bucket: number | null;
  };
  discovered_sqlite_files: number;
  runtime_sqlite_files: number;
  candidate_scopes: RuntimeReferenceScopeCandidate[];
  discovered_reference_files: number;
  reference_files_with_surfaces: number;
  reference_files_without_surfaces: number;
  matched_references: number;
  unmatched_references: number;
  passed_matches: number;
  failed_matches: number;
  exact_matches: number;
  partial_matches: number;
  scan_warnings: string[];
  matched_reports: RuntimeReferenceCorpusMatchedReport[];
  unmatched_reference_reports: RuntimeReferenceCorpusUnmatchedReport[];
};

export type RuntimeReferenceCorpusOptions = {
  sourceRootPaths: string[];
  referenceRootPaths: string[];
  outputPath?: string;
  maxSourceFiles?: number | null;
  maxScopes?: number | null;
  maxScopesPerFile?: number;
  maxReferences?: number | null;
  minNodes?: number;
  minOverlap?: number;
  maxPerBucket?: number;
};

type RuntimeScopeRow = {
  scope: string;
  node_count: number;
};

type RuntimeScopeWithIds = RuntimeReferenceScopeCandidate & {
  ids: Set<string>;
};

function emptySurfaces(): RuntimeReferenceSurfaces {
  return {
    use_now: [],
    inspect_before_use: [],
    do_not_use: [],
    rehydrate: [],
  };
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function surfaceIds(surfaces: RuntimeReferenceSurfaces): string[] {
  return unique([
    ...surfaces.use_now,
    ...surfaces.inspect_before_use,
    ...surfaces.do_not_use,
    ...surfaces.rehydrate,
  ]);
}

function mergeSurfaces(target: RuntimeReferenceSurfaces, source: RuntimeReferenceSurfaces): RuntimeReferenceSurfaces {
  return {
    use_now: unique([...target.use_now, ...source.use_now]),
    inspect_before_use: unique([...target.inspect_before_use, ...source.inspect_before_use]),
    do_not_use: unique([...target.do_not_use, ...source.do_not_use]),
    rehydrate: unique([...target.rehydrate, ...source.rehydrate]),
  };
}

function isSqliteLike(path: string): boolean {
  return /\.(sqlite|sqlite3|db)$/i.test(path);
}

function isJsonLike(path: string): boolean {
  return /\.(json|jsonl)$/i.test(path);
}

async function walkFiles(rootPath: string, predicate: (path: string) => boolean): Promise<string[]> {
  const root = resolve(rootPath);
  const rootStat = await stat(root);
  if (rootStat.isFile()) return predicate(root) ? [root] : [];

  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        await walk(fullPath);
      } else if (entry.isFile() && predicate(fullPath)) {
        out.push(fullPath);
      }
    }
  }
  await walk(root);
  return out.sort((a, b) => a.localeCompare(b));
}

async function findFiles(rootPaths: string[], predicate: (path: string) => boolean, warnings: string[]): Promise<string[]> {
  const files = new Set<string>();
  for (const rootPath of rootPaths) {
    try {
      for (const file of await walkFiles(rootPath, predicate)) files.add(file);
    } catch (err) {
      warnings.push(`${rootPath}: failed to scan (${(err as Error).message})`);
    }
  }
  return [...files].sort((a, b) => a.localeCompare(b));
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as { name?: string } | undefined;
  return row?.name === tableName;
}

function readRuntimeScopes(sourcePath: string, maxScopesPerFile: number, minNodes: number): RuntimeScopeWithIds[] {
  const db = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    if (!tableExists(db, "lite_memory_nodes")) return [];
    const rows = db.prepare(`
      SELECT scope, COUNT(*) AS node_count
      FROM lite_memory_nodes
      GROUP BY scope
      HAVING COUNT(*) >= ?
      ORDER BY node_count DESC, scope ASC
      LIMIT ?
    `).all(minNodes, maxScopesPerFile) as RuntimeScopeRow[];
    return rows.map((row) => {
      const idRows = db.prepare(`
        SELECT id
        FROM lite_memory_nodes
        WHERE scope = ?
        ORDER BY id ASC
      `).all(row.scope) as { id: string }[];
      const ids = new Set(idRows.map((idRow) => idRow.id));
      const idsSample = [...ids].slice(0, 20);
      return {
        source_path: sourcePath,
        scope: row.scope,
        node_count: Number(row.node_count),
        ids,
        ids_sample: idsSample,
      };
    });
  } finally {
    db.close();
  }
}

async function readReference(path: string, warnings: string[]): Promise<RuntimeReferenceCandidate | null> {
  try {
    const raw = await readFile(path, "utf8");
    let surfaces = emptySurfaces();
    if (/\.jsonl$/i.test(path)) {
      for (const [index, line] of raw.split(/\r?\n/).entries()) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          surfaces = mergeSurfaces(surfaces, extractRuntimeReferenceSurfaces(JSON.parse(trimmed)));
        } catch (err) {
          warnings.push(`${path}:${index + 1}: failed to parse JSONL line (${(err as Error).message})`);
        }
      }
    } else {
      surfaces = extractRuntimeReferenceSurfaces(JSON.parse(raw));
    }
    const ids = surfaceIds(surfaces);
    return {
      reference_path: path,
      id_count: ids.length,
      ids_sample: ids.slice(0, 20),
      surfaces,
    };
  } catch (err) {
    warnings.push(`${path}: failed to read Runtime reference (${(err as Error).message})`);
    return null;
  }
}

function overlapIds(referenceIds: string[], scope: RuntimeScopeWithIds): string[] {
  return referenceIds.filter((id) => scope.ids.has(id));
}

function bestScope(referenceIds: string[], scopes: RuntimeScopeWithIds[]): { scope: RuntimeScopeWithIds; overlap: string[] } | null {
  let best: { scope: RuntimeScopeWithIds; overlap: string[] } | null = null;
  for (const scope of scopes) {
    const overlap = overlapIds(referenceIds, scope);
    if (!best) {
      best = { scope, overlap };
      continue;
    }
    if (
      overlap.length > best.overlap.length
      || (overlap.length === best.overlap.length && scope.node_count < best.scope.node_count)
      || (
        overlap.length === best.overlap.length
        && scope.node_count === best.scope.node_count
        && `${scope.source_path}\u0000${scope.scope}`.localeCompare(`${best.scope.source_path}\u0000${best.scope.scope}`) < 0
      )
    ) {
      best = { scope, overlap };
    }
  }
  return best;
}

export async function runRuntimeReferenceCorpus(options: RuntimeReferenceCorpusOptions): Promise<RuntimeReferenceCorpusReport> {
  if (options.sourceRootPaths.length === 0) throw new Error("at least one source root is required");
  if (options.referenceRootPaths.length === 0) throw new Error("at least one reference root is required");
  const maxSourceFiles = options.maxSourceFiles === undefined ? null : options.maxSourceFiles;
  const maxScopes = options.maxScopes === undefined ? null : options.maxScopes;
  const maxReferences = options.maxReferences === undefined ? null : options.maxReferences;
  const maxScopesPerFile = options.maxScopesPerFile ?? 3;
  const minNodes = options.minNodes ?? 1;
  const minOverlap = options.minOverlap ?? 1;
  const scanWarnings: string[] = [];

  const sqliteFiles = await findFiles(options.sourceRootPaths, isSqliteLike, scanWarnings);
  const scopes: RuntimeScopeWithIds[] = [];
  let runtimeSqliteFiles = 0;
  for (const file of sqliteFiles) {
    if (maxSourceFiles !== null && runtimeSqliteFiles >= maxSourceFiles) break;
    try {
      const fileScopes = readRuntimeScopes(file, maxScopesPerFile, minNodes);
      if (fileScopes.length === 0) continue;
      runtimeSqliteFiles += 1;
      scopes.push(...fileScopes);
    } catch (err) {
      scanWarnings.push(`${file}: failed to inspect Runtime scopes (${(err as Error).message})`);
    }
  }
  scopes.sort((a, b) => b.node_count - a.node_count || a.source_path.localeCompare(b.source_path) || a.scope.localeCompare(b.scope));
  const selectedScopes = maxScopes === null ? scopes : scopes.slice(0, maxScopes);

  const referenceFiles = await findFiles(options.referenceRootPaths, isJsonLike, scanWarnings);
  const references: RuntimeReferenceCandidate[] = [];
  for (const file of referenceFiles) {
    if (maxReferences !== null && references.length >= maxReferences) break;
    const reference = await readReference(file, scanWarnings);
    if (reference) references.push(reference);
  }

  const withSurfaces = references.filter((reference) => reference.id_count > 0);
  const matchedReports: RuntimeReferenceCorpusMatchedReport[] = [];
  const unmatchedReports: RuntimeReferenceCorpusUnmatchedReport[] = references
    .filter((reference) => reference.id_count === 0)
    .map((reference) => ({
      reference_path: reference.reference_path,
      reference_id_count: 0,
      ids_sample: [],
      reason: "no_reference_surface_ids",
    }));

  for (const reference of withSurfaces) {
    const referenceIds = surfaceIds(reference.surfaces);
    const match = bestScope(referenceIds, selectedScopes);
    if (!match || match.overlap.length < minOverlap) {
      unmatchedReports.push({
        reference_path: reference.reference_path,
        reference_id_count: reference.id_count,
        ids_sample: reference.ids_sample,
        reason: "no_runtime_scope_overlap",
      });
      continue;
    }

    try {
      const parityReport = await runRuntimeSnapshotParity({
        sourcePath: match.scope.source_path,
        scope: match.scope.scope,
        referencePath: reference.reference_path,
        maxPerBucket: options.maxPerBucket,
      });
      matchedReports.push({
        reference_path: reference.reference_path,
        source_path: match.scope.source_path,
        scope: match.scope.scope,
        status: "passed",
        reference_id_count: reference.id_count,
        runtime_scope_node_count: match.scope.node_count,
        overlap_count: match.overlap.length,
        overlap_ids_sample: match.overlap.slice(0, 20),
        parity_exact: parityReport.parity.exact,
        bucket_reports: parityReport.parity.bucket_reports,
        error: null,
      });
    } catch (err) {
      matchedReports.push({
        reference_path: reference.reference_path,
        source_path: match.scope.source_path,
        scope: match.scope.scope,
        status: "failed",
        reference_id_count: reference.id_count,
        runtime_scope_node_count: match.scope.node_count,
        overlap_count: match.overlap.length,
        overlap_ids_sample: match.overlap.slice(0, 20),
        parity_exact: null,
        bucket_reports: [],
        error: (err as Error).message,
      });
    }
  }

  const report: RuntimeReferenceCorpusReport = {
    contract_version: "aionis_runtime_reference_corpus_report_v1",
    generated_at: new Date().toISOString(),
    source_roots: options.sourceRootPaths.map((rootPath) => resolve(rootPath)),
    reference_roots: options.referenceRootPaths.map((rootPath) => resolve(rootPath)),
    options: {
      max_source_files: maxSourceFiles,
      max_scopes: maxScopes,
      max_scopes_per_file: maxScopesPerFile,
      max_references: maxReferences,
      min_nodes: minNodes,
      min_overlap: minOverlap,
      max_per_bucket: options.maxPerBucket ?? null,
    },
    discovered_sqlite_files: sqliteFiles.length,
    runtime_sqlite_files: runtimeSqliteFiles,
    candidate_scopes: selectedScopes.map((scope) => ({
      source_path: scope.source_path,
      scope: scope.scope,
      node_count: scope.node_count,
      ids_sample: scope.ids_sample,
    })),
    discovered_reference_files: referenceFiles.length,
    reference_files_with_surfaces: withSurfaces.length,
    reference_files_without_surfaces: references.length - withSurfaces.length,
    matched_references: matchedReports.length,
    unmatched_references: unmatchedReports.length,
    passed_matches: matchedReports.filter((match) => match.status === "passed").length,
    failed_matches: matchedReports.filter((match) => match.status === "failed").length,
    exact_matches: matchedReports.filter((match) => match.parity_exact === true).length,
    partial_matches: matchedReports.filter((match) => match.status === "passed" && match.parity_exact === false).length,
    scan_warnings: scanWarnings,
    matched_reports: matchedReports,
    unmatched_reference_reports: unmatchedReports,
  };

  if (options.outputPath) {
    const outputPath = resolve(options.outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  return report;
}
