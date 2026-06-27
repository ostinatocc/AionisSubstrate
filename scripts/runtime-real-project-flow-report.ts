import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  exportAionisSubstrateBackup,
  openSqliteAionisSubstrate,
  restoreAionisSubstrateBackupToSqlite,
  runRuntimeLiveSidecarOnce,
  verifyAionisSubstrateBackup,
  type AionisCompiledContext,
  type RuntimeLiveSidecarApplyStats,
} from "../src/index.ts";

type Args = {
  roots: string[];
  outputDir: string;
  maxFiles: number;
  maxScopes: number;
  minNodes: number;
  keepTemp: boolean;
};

type RuntimeScopeCandidate = {
  source_path: string;
  source_file: string;
  scope: string;
  node_count: number;
  relation_count: number;
  feedback_count: number;
  decision_count: number;
};

type BucketSummary = {
  count: number;
  ids_sample: string[];
};

type ContextSummary = {
  use_now: BucketSummary;
  inspect_before_use: BucketSummary;
  do_not_use: BucketSummary;
  rehydrate: BucketSummary;
};

type CaseReport = RuntimeScopeCandidate & {
  passed: boolean;
  failures: string[];
  source_unchanged: boolean;
  mirror_idempotent: boolean;
  backup_ok: boolean;
  restore_would_restore: boolean;
  context_equivalent_after_restore: boolean;
  import_summary: {
    nodes_read: number;
    nodes_imported: number;
    relations_imported: number;
    feedback_imported: number;
    feedback_slot_nodes_imported: number;
    decisions_imported: number;
    warnings_count: number;
  };
  mirror: {
    first: {
      nodes: RuntimeLiveSidecarApplyStats;
      relations: RuntimeLiveSidecarApplyStats;
      feedback: RuntimeLiveSidecarApplyStats;
      decisions: RuntimeLiveSidecarApplyStats;
    };
    second: {
      nodes: RuntimeLiveSidecarApplyStats;
      relations: RuntimeLiveSidecarApplyStats;
      feedback: RuntimeLiveSidecarApplyStats;
      decisions: RuntimeLiveSidecarApplyStats;
    };
  };
  backup: {
    event_count: number;
    last_sequence: number;
    events_sha256: string | null;
  };
  restore_plan_counts: {
    nodes: number;
    relations: number;
    feedback: number;
    decisions: number;
  } | null;
  context_before_backup: ContextSummary;
  context_after_restore: ContextSummary;
};

type RealProjectFlowReport = {
  contract_version: "aionis_substrate_real_project_flow_report_v1";
  generated_at: string;
  root_paths: string[];
  output_dir: string;
  selection: {
    max_files: number;
    max_scopes: number;
    min_nodes: number;
    sqlite_files_discovered: number;
    runtime_sqlite_files: number;
    scope_candidates_discovered: number;
    cases_attempted: number;
  };
  summary: {
    passed: boolean;
    passed_cases: number;
    failed_cases: number;
    source_unchanged_cases: number;
    mirror_idempotent_cases: number;
    backup_ok_cases: number;
    restore_plan_ok_cases: number;
    context_equivalent_cases: number;
    total_nodes_read: number;
    total_nodes_imported: number;
    total_relations_imported: number;
    total_feedback_imported: number;
    total_feedback_slot_nodes_imported: number;
    total_decisions_imported: number;
  };
  cases: CaseReport[];
  caveats: string[];
};

function usage(): string {
  return [
    "Aionis Substrate real Runtime project-flow report",
    "",
    "Usage:",
    "  node scripts/runtime-real-project-flow-report.ts --root <runtime-sqlite-root> [--root <another-root>]",
    "",
    "Options:",
    "  --output-dir <path>  Report directory. Defaults to reports/runtime-real-project-flow-*.",
    "  --max-files <n>      Maximum Runtime SQLite files to inspect. Default: 8.",
    "  --max-scopes <n>     Maximum scope cases to run. Default: 8.",
    "  --min-nodes <n>      Minimum lite_memory_nodes per scope. Default: 20.",
    "  --keep-temp          Keep per-case temporary Substrate stores.",
  ].join("\n");
}

function parsePositiveInteger(raw: string | undefined, label: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function parseArgs(argv = process.argv.slice(2)): Args {
  const args: Args = {
    roots: [],
    outputDir: resolve("reports", `runtime-real-project-flow-${new Date().toISOString().replace(/[:.]/g, "-")}`),
    maxFiles: 8,
    maxScopes: 8,
    minNodes: 20,
    keepTemp: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--root") {
      if (!value) throw new Error("--root requires a value");
      args.roots.push(resolve(value));
      i += 1;
    } else if (flag === "--output-dir") {
      if (!value) throw new Error("--output-dir requires a value");
      args.outputDir = resolve(value);
      i += 1;
    } else if (flag === "--max-files") {
      args.maxFiles = parsePositiveInteger(value, "--max-files");
      i += 1;
    } else if (flag === "--max-scopes") {
      args.maxScopes = parsePositiveInteger(value, "--max-scopes");
      i += 1;
    } else if (flag === "--min-nodes") {
      args.minNodes = parsePositiveInteger(value, "--min-nodes");
      i += 1;
    } else if (flag === "--keep-temp") {
      args.keepTemp = true;
    } else if (flag === "--help" || flag === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (args.roots.length === 0) {
    const defaultRoot = "/Volumes/ziel/AionisRuntime-focused/.tmp";
    args.roots.push(defaultRoot);
  }
  return args;
}

async function walkSqliteFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(path: string): Promise<void> {
    const info = await stat(path);
    if (info.isDirectory()) {
      const entries = await readdir(path);
      for (const entry of entries) await visit(join(path, entry));
      return;
    }
    if (info.isFile() && (path.endsWith(".sqlite") || path.endsWith(".db"))) out.push(path);
  }
  try {
    await visit(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return out.sort();
}

function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { name?: string } | undefined;
  return row?.name === table;
}

function countByScope(db: DatabaseSync, table: string, scopeColumn = "scope"): Map<string, number> {
  if (!tableExists(db, table)) return new Map();
  const rows = db.prepare(`
    SELECT ${scopeColumn} AS scope, COUNT(*) AS count
    FROM ${table}
    GROUP BY ${scopeColumn}
  `).all() as Array<{ scope: string; count: number }>;
  return new Map(rows.map((row) => [row.scope, row.count]));
}

function readScopeCandidates(path: string, minNodes: number): RuntimeScopeCandidate[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (!tableExists(db, "lite_memory_nodes")) return [];
    const relationsByScope = countByScope(db, "lite_memory_edges");
    const feedbackByScope = countByScope(db, "lite_memory_rule_feedback");
    const decisionsByScope = countByScope(db, "lite_memory_execution_decisions");
    const rows = db.prepare(`
      SELECT scope, COUNT(*) AS node_count
      FROM lite_memory_nodes
      GROUP BY scope
      HAVING COUNT(*) >= ?
      ORDER BY node_count DESC, scope ASC
    `).all(minNodes) as Array<{ scope: string; node_count: number }>;
    return rows.map((row) => ({
      source_path: path,
      source_file: basename(path),
      scope: row.scope,
      node_count: row.node_count,
      relation_count: relationsByScope.get(row.scope) ?? 0,
      feedback_count: feedbackByScope.get(row.scope) ?? 0,
      decision_count: decisionsByScope.get(row.scope) ?? 0,
    })).sort((left, right) => {
      const byEvidence = (right.relation_count + right.feedback_count + right.decision_count)
        - (left.relation_count + left.feedback_count + left.decision_count);
      if (byEvidence !== 0) return byEvidence;
      const byNodes = right.node_count - left.node_count;
      if (byNodes !== 0) return byNodes;
      return left.scope.localeCompare(right.scope);
    });
  } finally {
    db.close();
  }
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function totalApplied(summary: CaseReport["mirror"]["second"]): number {
  return summary.nodes.applied + summary.relations.applied + summary.feedback.applied + summary.decisions.applied;
}

function summarizeBucket(ids: string[]): BucketSummary {
  return {
    count: ids.length,
    ids_sample: ids.slice(0, 8),
  };
}

function summarizeContext(context: AionisCompiledContext): ContextSummary {
  return {
    use_now: summarizeBucket(context.use_now.map((node) => node.id).sort()),
    inspect_before_use: summarizeBucket(context.inspect_before_use.map((node) => node.id).sort()),
    do_not_use: summarizeBucket(context.do_not_use.map((node) => node.id).sort()),
    rehydrate: summarizeBucket(context.rehydrate.map((node) => node.id).sort()),
  };
}

function slotsHaveRuntimeFeedback(slots: Record<string, unknown>): boolean {
  const positive = Number(slots.feedback_positive ?? 0);
  const negative = Number(slots.feedback_negative ?? 0);
  return (Number.isFinite(positive) && positive > 0)
    || (Number.isFinite(negative) && negative > 0)
    || typeof slots.last_feedback_at === "string"
    || typeof slots.feedback_learning_control_guide_trace_id === "string";
}

function contextNodeIds(context: AionisCompiledContext): Set<string> {
  return new Set([
    ...context.use_now,
    ...context.inspect_before_use,
    ...context.do_not_use,
    ...context.rehydrate,
  ].map((node) => node.id));
}

function countImportedRuntimeFeedbackSlotNodes(sourcePath: string, scope: string, context: AionisCompiledContext): number {
  const importedIds = contextNodeIds(context);
  if (importedIds.size === 0) return 0;
  const db = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    if (!tableExists(db, "lite_memory_nodes")) return 0;
    const rows = db.prepare("SELECT id, slots_json FROM lite_memory_nodes WHERE scope = ?").all(scope) as Array<{ id: string; slots_json: string }>;
    return rows.filter((row) => {
      if (!importedIds.has(row.id)) return false;
      try {
        const parsed = JSON.parse(row.slots_json) as unknown;
        return !!parsed && typeof parsed === "object" && !Array.isArray(parsed) && slotsHaveRuntimeFeedback(parsed as Record<string, unknown>);
      } catch {
        return false;
      }
    }).length;
  } finally {
    db.close();
  }
}

function contextEquivalent(left: ContextSummary, right: ContextSummary): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function selectScopeCases(candidates: RuntimeScopeCandidate[], maxScopes: number): RuntimeScopeCandidate[] {
  const groups = new Map<string, RuntimeScopeCandidate[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.source_path) ?? [];
    group.push(candidate);
    groups.set(candidate.source_path, group);
  }
  const selected: RuntimeScopeCandidate[] = [];
  const grouped = Array.from(groups.values());
  let cursor = 0;
  while (selected.length < maxScopes) {
    let added = false;
    for (const group of grouped) {
      const candidate = group[cursor];
      if (!candidate) continue;
      selected.push(candidate);
      added = true;
      if (selected.length >= maxScopes) break;
    }
    if (!added) break;
    cursor += 1;
  }
  return selected;
}

async function runCase(candidate: RuntimeScopeCandidate, keepTemp: boolean): Promise<CaseReport> {
  const tempDir = await mkdtemp(join(tmpdir(), "aionis-real-project-flow-"));
  const targetPath = join(tempDir, "substrate.sqlite");
  const checkpointPath = join(tempDir, "checkpoint.json");
  const restoredPath = join(tempDir, "restored.sqlite");
  const failures: string[] = [];
  try {
    const sourceShaBefore = await sha256File(candidate.source_path);
    const store = await openSqliteAionisSubstrate({ path: targetPath });
    const first = await runRuntimeLiveSidecarOnce({
      sourcePath: candidate.source_path,
      target: store,
      checkpointPath,
      scope: candidate.scope,
    });
    const second = await runRuntimeLiveSidecarOnce({
      sourcePath: candidate.source_path,
      target: store,
      checkpointPath,
      scope: candidate.scope,
    });
    const compiledBeforeBackup = await store.previewContext({
      scope: candidate.scope,
      query: "continue the current project flow",
    });
    const contextBeforeBackup = summarizeContext(compiledBeforeBackup);
    const feedbackSlotNodesImported = countImportedRuntimeFeedbackSlotNodes(candidate.source_path, candidate.scope, compiledBeforeBackup);
    const backup = await exportAionisSubstrateBackup(store, { createdAt: "2026-06-27T00:00:00.000Z" });
    const verification = verifyAionisSubstrateBackup(backup);
    await store.close();

    const restoreSnapshot = verification.snapshot;
    await restoreAionisSubstrateBackupToSqlite(backup, restoredPath);
    const restored = await openSqliteAionisSubstrate({ path: restoredPath });
    const contextAfterRestore = summarizeContext(await restored.previewContext({
      scope: candidate.scope,
      query: "continue the current project flow",
    }));
    await restored.close();

    const sourceShaAfter = await sha256File(candidate.source_path);
    const sourceUnchanged = sourceShaBefore === sourceShaAfter;
    const mirrorIdempotent = totalApplied(second.apply_summary) === 0;
    const contextEqual = contextEquivalent(contextBeforeBackup, contextAfterRestore);

    if (!sourceUnchanged) failures.push("Runtime source SQLite changed during mirror/backup flow");
    if (first.import_summary.nodesImported <= 0) failures.push("mirror imported zero Runtime nodes");
    if (!mirrorIdempotent) failures.push("second mirror pass applied changed evidence");
    if (!verification.ok) failures.push(`backup verification failed: ${verification.errors.join("; ")}`);
    if (!contextEqual) failures.push("restored context buckets differ from mirrored context buckets");

    return {
      ...candidate,
      passed: failures.length === 0,
      failures,
      source_unchanged: sourceUnchanged,
      mirror_idempotent: mirrorIdempotent,
      backup_ok: verification.ok,
      restore_would_restore: verification.ok,
      context_equivalent_after_restore: contextEqual,
      import_summary: {
        nodes_read: first.import_summary.nodesRead,
        nodes_imported: first.import_summary.nodesImported,
        relations_imported: first.import_summary.relationsImported,
        feedback_imported: first.import_summary.feedbackImported,
        feedback_slot_nodes_imported: feedbackSlotNodesImported,
        decisions_imported: first.import_summary.decisionsImported,
        warnings_count: first.import_summary.warnings.length,
      },
      mirror: {
        first: first.apply_summary,
        second: second.apply_summary,
      },
      backup: {
        event_count: backup.eventCount,
        last_sequence: backup.lastSequence,
        events_sha256: verification.eventsSha256,
      },
      restore_plan_counts: restoreSnapshot ? {
        nodes: restoreSnapshot.nodes.length,
        relations: restoreSnapshot.relations.length,
        feedback: restoreSnapshot.feedback.length,
        decisions: restoreSnapshot.decisions.length,
      } : null,
      context_before_backup: contextBeforeBackup,
      context_after_restore: contextAfterRestore,
    };
  } finally {
    if (!keepTemp) await rm(tempDir, { recursive: true, force: true });
  }
}

function markdown(report: RealProjectFlowReport): string {
  const lines = [
    "# Aionis Substrate Real Runtime Project-Flow Report",
    "",
    `Generated: ${report.generated_at}`,
    "",
    "## Summary",
    "",
    `- Passed: ${report.summary.passed ? "yes" : "no"}`,
    `- Cases: ${report.summary.passed_cases}/${report.selection.cases_attempted} passed`,
    `- Runtime SQLite files discovered: ${report.selection.sqlite_files_discovered}`,
    `- Runtime SQLite files used: ${report.selection.runtime_sqlite_files}`,
    `- Scope candidates discovered: ${report.selection.scope_candidates_discovered}`,
    `- Total nodes imported: ${report.summary.total_nodes_imported}`,
    `- Total relations imported: ${report.summary.total_relations_imported}`,
    `- Total feedback imported: ${report.summary.total_feedback_imported}`,
    `- Total feedback-slot nodes imported: ${report.summary.total_feedback_slot_nodes_imported}`,
    `- Total decisions imported: ${report.summary.total_decisions_imported}`,
    "",
    "## Gate Results",
    "",
    `- Source unchanged: ${report.summary.source_unchanged_cases}/${report.selection.cases_attempted}`,
    `- Mirror second pass idempotent: ${report.summary.mirror_idempotent_cases}/${report.selection.cases_attempted}`,
    `- Backup verified: ${report.summary.backup_ok_cases}/${report.selection.cases_attempted}`,
    `- Restore-plan accepted: ${report.summary.restore_plan_ok_cases}/${report.selection.cases_attempted}`,
    `- Restored context equivalent: ${report.summary.context_equivalent_cases}/${report.selection.cases_attempted}`,
    "",
    "## Cases",
    "",
    "| # | Source | Runtime nodes | Runtime relations | Imported | Context buckets | Passed |",
    "| --- | --- | ---: | ---: | ---: | --- | --- |",
  ];
  report.cases.forEach((item, index) => {
    const buckets = [
      `use=${item.context_before_backup.use_now.count}`,
      `inspect=${item.context_before_backup.inspect_before_use.count}`,
      `block=${item.context_before_backup.do_not_use.count}`,
      `rehydrate=${item.context_before_backup.rehydrate.count}`,
    ].join(", ");
    lines.push([
      `| ${index + 1}`,
      item.source_file,
      String(item.node_count),
      String(item.relation_count),
      String(item.import_summary.nodes_imported),
      buckets,
      item.passed ? "yes" : `no: ${item.failures.join("; ")}`,
    ].join(" | ") + " |");
  });
  lines.push("", "## Caveats", "");
  for (const caveat of report.caveats) lines.push(`- ${caveat}`);
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs();
  const sqliteFiles = (await Promise.all(args.roots.map(walkSqliteFiles))).flat();
  const runtimeFiles: string[] = [];
  const scopeCandidates: RuntimeScopeCandidate[] = [];
  for (const path of sqliteFiles) {
    if (runtimeFiles.length >= args.maxFiles) break;
    const candidates = readScopeCandidates(path, args.minNodes);
    if (candidates.length === 0) continue;
    runtimeFiles.push(path);
    scopeCandidates.push(...candidates);
  }
  const casesToRun = selectScopeCases(scopeCandidates, args.maxScopes);
  if (casesToRun.length === 0) {
    throw new Error(`no Runtime scope candidates found under ${args.roots.join(", ")} with minNodes=${args.minNodes}`);
  }

  const cases: CaseReport[] = [];
  for (const candidate of casesToRun) {
    cases.push(await runCase(candidate, args.keepTemp));
  }

  const passedCases = cases.filter((item) => item.passed).length;
  const report: RealProjectFlowReport = {
    contract_version: "aionis_substrate_real_project_flow_report_v1",
    generated_at: new Date().toISOString(),
    root_paths: args.roots,
    output_dir: args.outputDir,
    selection: {
      max_files: args.maxFiles,
      max_scopes: args.maxScopes,
      min_nodes: args.minNodes,
      sqlite_files_discovered: sqliteFiles.length,
      runtime_sqlite_files: runtimeFiles.length,
      scope_candidates_discovered: scopeCandidates.length,
      cases_attempted: cases.length,
    },
    summary: {
      passed: passedCases === cases.length,
      passed_cases: passedCases,
      failed_cases: cases.length - passedCases,
      source_unchanged_cases: cases.filter((item) => item.source_unchanged).length,
      mirror_idempotent_cases: cases.filter((item) => item.mirror_idempotent).length,
      backup_ok_cases: cases.filter((item) => item.backup_ok).length,
      restore_plan_ok_cases: cases.filter((item) => item.restore_would_restore).length,
      context_equivalent_cases: cases.filter((item) => item.context_equivalent_after_restore).length,
      total_nodes_read: cases.reduce((sum, item) => sum + item.import_summary.nodes_read, 0),
      total_nodes_imported: cases.reduce((sum, item) => sum + item.import_summary.nodes_imported, 0),
      total_relations_imported: cases.reduce((sum, item) => sum + item.import_summary.relations_imported, 0),
      total_feedback_imported: cases.reduce((sum, item) => sum + item.import_summary.feedback_imported, 0),
      total_feedback_slot_nodes_imported: cases.reduce((sum, item) => sum + item.import_summary.feedback_slot_nodes_imported, 0),
      total_decisions_imported: cases.reduce((sum, item) => sum + item.import_summary.decisions_imported, 0),
    },
    cases,
    caveats: [
      "This report validates local evidence continuity, backup/restore, auditability, and context bucket preservation. It does not claim downstream Agent task success.",
      "Runtime remains the source of real-time guide/admission behavior; Substrate mirrors evidence into an isolated store.",
      "The report records ids and counts, not raw prompt text, memory summaries, or payload contents.",
    ],
  };

  await mkdir(args.outputDir, { recursive: true });
  const jsonPath = join(args.outputDir, "summary.json");
  const markdownPath = join(args.outputDir, "summary.md");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, markdown(report), "utf8");
  console.log(JSON.stringify({
    output_dir: args.outputDir,
    json: jsonPath,
    markdown: markdownPath,
    passed: report.summary.passed,
    cases: `${report.summary.passed_cases}/${report.selection.cases_attempted}`,
    total_nodes_imported: report.summary.total_nodes_imported,
    total_relations_imported: report.summary.total_relations_imported,
    total_feedback_imported: report.summary.total_feedback_imported,
    total_feedback_slot_nodes_imported: report.summary.total_feedback_slot_nodes_imported,
    total_decisions_imported: report.summary.total_decisions_imported,
  }, null, 2));
  if (!report.summary.passed) process.exitCode = 1;
}

main().catch((err) => {
  console.error((err as Error).stack ?? String(err));
  console.error("");
  console.error(usage());
  process.exit(1);
});
