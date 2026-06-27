import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

type PackageJson = {
  name: string;
  version: string;
};

type Args = {
  roots: string[];
  maxFiles: number | null;
  minNodes: number;
  limit: number;
  livePasses: number;
  packageSpec: string;
  outputPath: string;
  keepTemp: boolean;
};

type RuntimeSourceCandidate = {
  source_path: string;
  node_count: number;
  scope_count: number;
  first_created_at: string | null;
  last_created_at: string | null;
};

type RuntimeImportReport = {
  nodesRead?: number;
  nodesImported?: number;
  nodesSkipped?: number;
  relationsRead?: number;
  relationsImported?: number;
  relationsSkipped?: number;
  feedbackImported?: number;
  decisionsImported?: number;
  scopes?: string[];
};

type RuntimeLiveSidecarReport = {
  import_summary?: RuntimeImportReport;
};

type InspectReport = {
  info: {
    lastSequence: number;
    eventCount: number;
  };
};

type LivePassSummary = {
  pass: number;
  reported_imported_events: number;
  changed_events: number;
  changed_sequence: number;
  event_count: number;
  last_sequence: number;
};

type BridgeSourceReport = RuntimeSourceCandidate & {
  status: "passed" | "failed";
  error: string | null;
  snapshot: {
    nodes_read: number;
    nodes_imported: number;
    nodes_skipped: number;
    relations_read: number;
    relations_imported: number;
    relations_skipped: number;
    feedback_imported: number;
    decisions_imported: number;
    scopes: number;
    event_count: number;
  } | null;
  live_sidecar: {
    passes: LivePassSummary[];
    event_count: number;
  } | null;
  source_immutable: boolean;
};

type CorpusReport = {
  contract_version: "aionis_published_runtime_bridge_corpus_report_v1";
  generated_at: string;
  package: string;
  roots: string[];
  options: {
    max_files: number | null;
    min_nodes: number;
    limit: number;
    live_passes: number;
  };
  discovered_sqlite_files: number;
  runtime_sqlite_files: number;
  attempted_files: number;
  passed_files: number;
  failed_files: number;
  total_nodes_read: number;
  total_nodes_imported: number;
  total_relations_imported: number;
  total_events: number;
  temp_dir: string | null;
  reports: BridgeSourceReport[];
};

function registryPackageSpec(): string {
  const override = process.env.AIONIS_SUBSTRATE_REGISTRY_PACKAGE?.trim();
  if (override) return override;
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;
  return `${pkg.name}@${pkg.version}`;
}

function usage(): never {
  throw new Error([
    "Usage:",
    "  node scripts/published-runtime-bridge-corpus.ts --root /path/runtime/.tmp [--max-files 5] [--min-nodes 1] [--limit 1000] [--live-passes 3]",
    "",
    "Installs the published npm package once into a fresh temp project, scans real Runtime Lite SQLite sources read-only,",
    "and verifies published-package snapshot/live-sidecar parity plus checkpoint idempotency per source.",
  ].join("\n"));
}

function parsePositiveInteger(raw: string | undefined, label: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function parseOptionalLimit(raw: string | undefined, label: string): number | null {
  if (raw === undefined || raw === "all") return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer or 'all'`);
  return parsed;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    roots: [],
    maxFiles: 5,
    minNodes: 1,
    limit: Number(process.env.AIONIS_RUNTIME_BRIDGE_LIMIT ?? "1000"),
    livePasses: Number(process.env.AIONIS_RUNTIME_BRIDGE_LIVE_PASSES ?? "3"),
    packageSpec: registryPackageSpec(),
    outputPath: resolve("reports", `published-runtime-bridge-corpus-${new Date().toISOString().replace(/[:.]/g, "-")}`, "summary.json"),
    keepTemp: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--root") {
      if (!value?.trim()) throw new Error("--root requires a value");
      args.roots.push(resolve(value));
      index += 1;
    } else if (flag === "--max-files") {
      args.maxFiles = parseOptionalLimit(value, "--max-files");
      index += 1;
    } else if (flag === "--min-nodes") {
      args.minNodes = parsePositiveInteger(value, "--min-nodes");
      index += 1;
    } else if (flag === "--limit") {
      args.limit = parsePositiveInteger(value, "--limit");
      index += 1;
    } else if (flag === "--live-passes") {
      args.livePasses = parsePositiveInteger(value, "--live-passes");
      index += 1;
    } else if (flag === "--package") {
      if (!value?.trim()) throw new Error("--package requires a value");
      args.packageSpec = value.trim();
      index += 1;
    } else if (flag === "--output") {
      if (!value?.trim()) throw new Error("--output requires a value");
      args.outputPath = resolve(value);
      index += 1;
    } else if (flag === "--keep-temp") {
      args.keepTemp = true;
    } else if (flag === "--help" || flag === "-h") {
      usage();
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (args.roots.length === 0) usage();
  if (args.livePasses < 2) throw new Error("--live-passes must be >= 2");
  return args;
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

async function findSqliteFiles(rootPaths: string[]): Promise<string[]> {
  const files = new Set<string>();
  for (const root of rootPaths) {
    for (const file of await walkSqliteFiles(root)) files.add(file);
  }
  return [...files].sort((a, b) => a.localeCompare(b));
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as { name?: string } | undefined;
  return row?.name === tableName;
}

function readRuntimeSourceCandidate(sourcePath: string, minNodes: number): RuntimeSourceCandidate | null {
  const db = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    if (!tableExists(db, "lite_memory_nodes")) return null;
    const row = db.prepare(`
      SELECT
        COUNT(*) AS node_count,
        COUNT(DISTINCT scope) AS scope_count,
        MIN(created_at) AS first_created_at,
        MAX(created_at) AS last_created_at
      FROM lite_memory_nodes
    `).get() as {
      node_count: number;
      scope_count: number;
      first_created_at: string | null;
      last_created_at: string | null;
    };
    const nodeCount = Number(row.node_count);
    if (nodeCount < minNodes) return null;
    return {
      source_path: sourcePath,
      node_count: nodeCount,
      scope_count: Number(row.scope_count),
      first_created_at: row.first_created_at,
      last_created_at: row.last_created_at,
    };
  } finally {
    db.close();
  }
}

function runCli(workspace: string, args: string[]): string {
  return execFileSync(join(workspace, "node_modules", ".bin", "aionis-substrate"), args, {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`${label} did not return valid JSON: ${(error as Error).message}\n${raw}`);
  }
}

function importedEvents(report: RuntimeImportReport): number {
  return (report.nodesImported ?? 0)
    + (report.relationsImported ?? 0)
    + (report.feedbackImported ?? 0)
    + (report.decisionsImported ?? 0);
}

function importSummaryFromLive(report: RuntimeLiveSidecarReport): RuntimeImportReport {
  if (!report.import_summary) throw new Error("live-sidecar report did not include import_summary");
  return report.import_summary;
}

async function assertSourceUnchanged(path: string, before: { size: number; mtimeMs: number }): Promise<boolean> {
  const after = await stat(path);
  return after.size === before.size && after.mtimeMs === before.mtimeMs;
}

async function runBridgeForSource(
  workspace: string,
  candidate: RuntimeSourceCandidate,
  index: number,
  args: Args,
): Promise<BridgeSourceReport> {
  const beforeSourceStat = await stat(candidate.source_path);
  const snapshotPath = join(workspace, `substrate-snapshot-${index}.sqlite`);
  const livePath = join(workspace, `substrate-live-${index}.sqlite`);
  const checkpointPath = join(workspace, `runtime-live-checkpoint-${index}.json`);
  const limitArgs = ["--limit", String(args.limit)];

  try {
    const importReport = parseJson<RuntimeImportReport>(runCli(workspace, [
      "import-runtime-snapshot",
      "--source", candidate.source_path,
      "--target", snapshotPath,
      "--adapter", "sqlite",
      ...limitArgs,
    ]), `${candidate.source_path}: import-runtime-snapshot`);

    const inspectSnapshot = parseJson<InspectReport>(runCli(workspace, [
      "inspect",
      "--adapter", "sqlite",
      "--path", snapshotPath,
    ]), `${candidate.source_path}: inspect snapshot`);

    const livePasses: LivePassSummary[] = [];
    let previousInspect: InspectReport | null = null;
    let inspectLive: InspectReport | null = null;
    for (let pass = 1; pass <= args.livePasses; pass += 1) {
      const liveReport = parseJson<RuntimeLiveSidecarReport>(runCli(workspace, [
        "live-sidecar",
        "--source", candidate.source_path,
        "--target", livePath,
        "--adapter", "sqlite",
        "--checkpoint", checkpointPath,
        ...limitArgs,
      ]), `${candidate.source_path}: live-sidecar pass ${pass}`);
      const currentInspect = parseJson<InspectReport>(runCli(workspace, [
        "inspect",
        "--adapter", "sqlite",
        "--path", livePath,
      ]), `${candidate.source_path}: inspect live after pass ${pass}`);
      const reportedEvents = importedEvents(importSummaryFromLive(liveReport));
      const changedEvents = previousInspect
        ? currentInspect.info.eventCount - previousInspect.info.eventCount
        : currentInspect.info.eventCount;
      const changedSequence = previousInspect
        ? currentInspect.info.lastSequence - previousInspect.info.lastSequence
        : currentInspect.info.lastSequence;
      if (pass > 1 && (changedEvents !== 0 || changedSequence !== 0)) {
        throw new Error(`live-sidecar pass ${pass} mutated target after checkpoint: event delta ${changedEvents}, sequence delta ${changedSequence}`);
      }
      livePasses.push({
        pass,
        reported_imported_events: reportedEvents,
        changed_events: changedEvents,
        changed_sequence: changedSequence,
        event_count: currentInspect.info.eventCount,
        last_sequence: currentInspect.info.lastSequence,
      });
      previousInspect = currentInspect;
      inspectLive = currentInspect;
    }
    if (!inspectLive) throw new Error("live-sidecar did not run");
    if ((importReport.nodesImported ?? 0) <= 0) throw new Error("snapshot import imported zero Runtime nodes");
    if (importedEvents(importReport) <= 0) throw new Error("snapshot import applied zero Substrate events");
    if ((livePasses[0]?.reported_imported_events ?? 0) <= 0) throw new Error("first live-sidecar pass applied zero Substrate events");
    if (inspectSnapshot.info.eventCount !== inspectLive.info.eventCount) {
      throw new Error(`snapshot/live event count mismatch: ${inspectSnapshot.info.eventCount} vs ${inspectLive.info.eventCount}`);
    }
    if (inspectSnapshot.info.lastSequence !== inspectLive.info.lastSequence) {
      throw new Error(`snapshot/live sequence mismatch: ${inspectSnapshot.info.lastSequence} vs ${inspectLive.info.lastSequence}`);
    }
    const sourceImmutable = await assertSourceUnchanged(candidate.source_path, beforeSourceStat);
    if (!sourceImmutable) throw new Error("Runtime source changed during bridge corpus check");

    return {
      ...candidate,
      status: "passed",
      error: null,
      snapshot: {
        nodes_read: importReport.nodesRead ?? 0,
        nodes_imported: importReport.nodesImported ?? 0,
        nodes_skipped: importReport.nodesSkipped ?? 0,
        relations_read: importReport.relationsRead ?? 0,
        relations_imported: importReport.relationsImported ?? 0,
        relations_skipped: importReport.relationsSkipped ?? 0,
        feedback_imported: importReport.feedbackImported ?? 0,
        decisions_imported: importReport.decisionsImported ?? 0,
        scopes: importReport.scopes?.length ?? 0,
        event_count: inspectSnapshot.info.eventCount,
      },
      live_sidecar: {
        passes: livePasses,
        event_count: inspectLive.info.eventCount,
      },
      source_immutable: true,
    };
  } catch (error) {
    return {
      ...candidate,
      status: "failed",
      error: (error as Error).message,
      snapshot: null,
      live_sidecar: null,
      source_immutable: await assertSourceUnchanged(candidate.source_path, beforeSourceStat),
    };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const sqliteFiles = await findSqliteFiles(args.roots);
  const candidates: RuntimeSourceCandidate[] = [];
  for (const file of sqliteFiles) {
    const candidate = readRuntimeSourceCandidate(file, args.minNodes);
    if (candidate) candidates.push(candidate);
  }
  candidates.sort((a, b) => b.node_count - a.node_count || a.source_path.localeCompare(b.source_path));
  const selected = args.maxFiles === null ? candidates : candidates.slice(0, args.maxFiles);
  const workspace = await mkdtemp(join(tmpdir(), "aionis-substrate-published-bridge-corpus-"));

  try {
    await writeFile(join(workspace, "package.json"), "{\"type\":\"module\"}\n", "utf8");
    execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund", args.packageSpec], {
      cwd: workspace,
      stdio: "pipe",
    });

    const reports: BridgeSourceReport[] = [];
    for (let index = 0; index < selected.length; index += 1) {
      reports.push(await runBridgeForSource(workspace, selected[index], index, args));
    }

    const report: CorpusReport = {
      contract_version: "aionis_published_runtime_bridge_corpus_report_v1",
      generated_at: new Date().toISOString(),
      package: args.packageSpec,
      roots: args.roots,
      options: {
        max_files: args.maxFiles,
        min_nodes: args.minNodes,
        limit: args.limit,
        live_passes: args.livePasses,
      },
      discovered_sqlite_files: sqliteFiles.length,
      runtime_sqlite_files: candidates.length,
      attempted_files: reports.length,
      passed_files: reports.filter((item) => item.status === "passed").length,
      failed_files: reports.filter((item) => item.status === "failed").length,
      total_nodes_read: reports.reduce((sum, item) => sum + (item.snapshot?.nodes_read ?? 0), 0),
      total_nodes_imported: reports.reduce((sum, item) => sum + (item.snapshot?.nodes_imported ?? 0), 0),
      total_relations_imported: reports.reduce((sum, item) => sum + (item.snapshot?.relations_imported ?? 0), 0),
      total_events: reports.reduce((sum, item) => sum + (item.snapshot?.event_count ?? 0), 0),
      temp_dir: args.keepTemp ? workspace : null,
      reports,
    };

    await mkdir(dirname(args.outputPath), { recursive: true });
    await writeFile(args.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      output: args.outputPath,
      package: report.package,
      discovered_sqlite_files: report.discovered_sqlite_files,
      runtime_sqlite_files: report.runtime_sqlite_files,
      attempted_files: report.attempted_files,
      passed_files: report.passed_files,
      failed_files: report.failed_files,
      total_nodes_read: report.total_nodes_read,
      total_nodes_imported: report.total_nodes_imported,
      total_relations_imported: report.total_relations_imported,
      total_events: report.total_events,
    }, null, 2));
    if (report.failed_files > 0) process.exit(1);
  } finally {
    if (!args.keepTemp) await rm(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error((error as Error).stack ?? String(error));
  console.error(usage());
  process.exit(1);
});
