import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  openSqliteAionisSubstrate,
  runRuntimeLiveSidecarWatch,
  type RuntimeLiveSidecarCheckpoint,
  type RuntimeLiveSidecarWatchReport,
} from "../src/index.ts";

type Args = {
  batches: number;
  batchSize: number;
  intervalMs: number;
  scope: string;
  output: string;
  keepTemp: boolean;
};

type SoakBatchReport = {
  batch_index: number;
  inserted_before_run: number;
  inserted_after_run: number;
  lock_path: string;
  applied: number;
  unchanged: number;
  attempted: number;
  event_count_after: number;
  warning_count: number;
};

type SoakReport = {
  contract_version: "aionis_runtime_live_sidecar_soak_report_v1";
  generated_at: string;
  temp_dir: string;
  temp_dir_removed: boolean;
  source_path: string;
  target_path: string;
  checkpoint_path: string;
  scope: string;
  batches: number;
  batch_size: number;
  inserted_nodes: number;
  target_nodes: number;
  reopened_target_nodes: number;
  target_events: number;
  reopened_target_events: number;
  checkpoint_nodes: number;
  final_unchanged: {
    attempted: number;
    applied: number;
    unchanged: number;
  };
  watch_runs: SoakBatchReport[];
  passed: boolean;
  failures: string[];
};

function usage(): string {
  return [
    "Usage:",
    "  node scripts/runtime-live-sidecar-soak.ts [--batches 8] [--batch-size 50] [--interval-ms 1]",
    "",
    "Creates a real Runtime Lite SQLite fixture, repeatedly appends evidence, and verifies",
    "checkpointed live-sidecar watch sync into a separate real Substrate SQLite store.",
  ].join("\n");
}

function parsePositiveInteger(raw: string | undefined, label: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function parseNonNegativeInteger(raw: string | undefined, label: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    batches: 8,
    batchSize: 50,
    intervalMs: 1,
    scope: "runtime-live-sidecar-soak",
    output: resolve("reports", `runtime-live-sidecar-soak-${new Date().toISOString().replace(/[:.]/g, "-")}`, "summary.json"),
    keepTemp: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--batches") {
      args.batches = parsePositiveInteger(value, "--batches");
      index += 1;
    } else if (flag === "--batch-size") {
      args.batchSize = parsePositiveInteger(value, "--batch-size");
      index += 1;
    } else if (flag === "--interval-ms") {
      args.intervalMs = parseNonNegativeInteger(value, "--interval-ms");
      index += 1;
    } else if (flag === "--scope") {
      if (!value?.trim()) throw new Error("--scope requires a value");
      args.scope = value.trim();
      index += 1;
    } else if (flag === "--output") {
      if (!value?.trim()) throw new Error("--output requires a value");
      args.output = resolve(value);
      index += 1;
    } else if (flag === "--keep-temp") {
      args.keepTemp = true;
    } else if (flag === "--help" || flag === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  return args;
}

function createRuntimeLiteSource(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE lite_memory_nodes (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        client_id TEXT,
        type TEXT NOT NULL,
        tier TEXT NOT NULL,
        title TEXT,
        text_summary TEXT,
        slots_json TEXT NOT NULL,
        raw_ref TEXT,
        evidence_ref TEXT,
        embedding_vector_json TEXT,
        embedding_model TEXT,
        memory_lane TEXT NOT NULL,
        producer_agent_id TEXT,
        owner_agent_id TEXT,
        owner_team_id TEXT,
        embedding_status TEXT NOT NULL,
        embedding_last_error TEXT,
        salience REAL NOT NULL,
        importance REAL NOT NULL,
        confidence REAL NOT NULL,
        redaction_version INTEGER NOT NULL,
        commit_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  } finally {
    db.close();
  }
}

function insertRuntimeNodeBatch(path: string, scope: string, batchIndex: number, batchSize: number): void {
  const db = new DatabaseSync(path);
  try {
    const insert = db.prepare(`
      INSERT INTO lite_memory_nodes (
        id, scope, client_id, type, tier, title, text_summary, slots_json, raw_ref, evidence_ref,
        embedding_vector_json, embedding_model, memory_lane, producer_agent_id, owner_agent_id,
        owner_team_id, embedding_status, embedding_last_error, salience, importance, confidence,
        redaction_version, commit_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.exec("BEGIN");
    try {
      for (let index = 0; index < batchSize; index += 1) {
        const id = `runtime-node-${String(batchIndex).padStart(3, "0")}-${String(index).padStart(4, "0")}`;
        const moduleIndex = batchIndex % 17;
        insert.run(
          id,
          scope,
          `client-${id}`,
          "procedure",
          "hot",
          `Verified route ${batchIndex}.${index}`,
          `Use src/module-${moduleIndex}.ts with tests/module-${moduleIndex}.test.ts after verifier passed for route ${batchIndex}.${index}.`,
          JSON.stringify({
            summary_kind: "workflow_anchor",
            contract_trust: "trusted",
            target_files: [`src/module-${moduleIndex}.ts`, `tests/module-${moduleIndex}.test.ts`],
            execution_result_summary: { status: "passed" },
            source: "runtime-live-sidecar-soak",
          }),
          `raw://trace/${id}`,
          `evidence://verifier/${id}`,
          null,
          "fixture-embedding",
          "execution",
          "agent-soak",
          "agent-soak",
          "team-soak",
          "ready",
          null,
          0.8,
          0.85,
          0.95,
          1,
          `commit-${batchIndex}`,
          new Date(Date.UTC(2026, 5, 26, 0, batchIndex, index)).toISOString(),
        );
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } finally {
    db.close();
  }
}

function countSourceNodes(path: string, scope: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT count(*) AS count FROM lite_memory_nodes WHERE scope = ?").get(scope) as { count: number };
    return Number(row.count);
  } finally {
    db.close();
  }
}

async function checkpointNodeCount(path: string): Promise<number> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as RuntimeLiveSidecarCheckpoint;
  return Object.keys(parsed.fingerprints.nodes).length;
}

async function lockWasReleased(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw err;
  }
}

function pushFailure(failures: string[], condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

function summarizeBatch(
  batchIndex: number,
  insertedBeforeRun: number,
  insertedAfterRun: number,
  lockPath: string,
  watchReport: RuntimeLiveSidecarWatchReport,
): SoakBatchReport {
  const lastReport = watchReport.reports[watchReport.reports.length - 1];
  return {
    batch_index: batchIndex,
    inserted_before_run: insertedBeforeRun,
    inserted_after_run: insertedAfterRun,
    lock_path: lockPath,
    applied: watchReport.apply_summary.nodes.applied,
    unchanged: watchReport.apply_summary.nodes.unchanged,
    attempted: watchReport.apply_summary.nodes.attempted,
    event_count_after: lastReport?.store_after.eventCount ?? 0,
    warning_count: watchReport.warnings.length,
  };
}

async function runSoak(args: Args): Promise<SoakReport> {
  const tempDir = await mkdtemp(join(tmpdir(), "aionis-live-sidecar-soak-"));
  const sourcePath = join(tempDir, "runtime.sqlite");
  const targetPath = join(tempDir, "substrate.sqlite");
  const checkpointPath = join(tempDir, "checkpoint.json");
  createRuntimeLiteSource(sourcePath);

  const failures: string[] = [];
  const watchRuns: SoakBatchReport[] = [];
  let tempDirRemoved = false;
  let targetNodes = 0;
  let targetEvents = 0;
  let reopenedTargetNodes = 0;
  let reopenedTargetEvents = 0;
  let checkpointNodes = 0;
  let finalUnchanged = { attempted: 0, applied: 0, unchanged: 0 };

  try {
    const store = await openSqliteAionisSubstrate({ path: targetPath });
    try {
      for (let batchIndex = 1; batchIndex <= args.batches; batchIndex += 1) {
        const insertedBeforeRun = countSourceNodes(sourcePath, args.scope);
        insertRuntimeNodeBatch(sourcePath, args.scope, batchIndex, args.batchSize);
        const insertedAfterRun = countSourceNodes(sourcePath, args.scope);
        const lockPath = join(tempDir, `sidecar-${batchIndex}.lock`);
        const watchReport = await runRuntimeLiveSidecarWatch({
          sourcePath,
          target: store,
          checkpointPath,
          scope: args.scope,
          intervalMs: args.intervalMs,
          iterations: 2,
          lockPath,
        });
        const batchSummary = summarizeBatch(batchIndex, insertedBeforeRun, insertedAfterRun, lockPath, watchReport);
        watchRuns.push(batchSummary);

        pushFailure(failures, watchReport.iterations_completed === 2, `batch ${batchIndex}: watch did not complete 2 iterations`);
        pushFailure(failures, batchSummary.applied === args.batchSize, `batch ${batchIndex}: expected ${args.batchSize} applied nodes, got ${batchSummary.applied}`);
        pushFailure(failures, batchSummary.attempted === insertedAfterRun * 2, `batch ${batchIndex}: expected ${insertedAfterRun * 2} attempted nodes, got ${batchSummary.attempted}`);
        pushFailure(
          failures,
          batchSummary.unchanged === insertedBeforeRun + insertedAfterRun,
          `batch ${batchIndex}: expected ${insertedBeforeRun + insertedAfterRun} unchanged nodes, got ${batchSummary.unchanged}`,
        );
        pushFailure(failures, batchSummary.event_count_after === insertedAfterRun, `batch ${batchIndex}: target event count ${batchSummary.event_count_after} did not match source count ${insertedAfterRun}`);
        pushFailure(failures, await lockWasReleased(lockPath), `batch ${batchIndex}: lock was not released`);
      }

      const finalLockPath = join(tempDir, "sidecar-final.lock");
      const finalWatch = await runRuntimeLiveSidecarWatch({
        sourcePath,
        target: store,
        checkpointPath,
        scope: args.scope,
        intervalMs: args.intervalMs,
        iterations: 1,
        lockPath: finalLockPath,
      });
      finalUnchanged = {
        attempted: finalWatch.apply_summary.nodes.attempted,
        applied: finalWatch.apply_summary.nodes.applied,
        unchanged: finalWatch.apply_summary.nodes.unchanged,
      };
      const insertedNodes = countSourceNodes(sourcePath, args.scope);
      pushFailure(failures, finalUnchanged.applied === 0, `final unchanged run applied ${finalUnchanged.applied} nodes`);
      pushFailure(failures, finalUnchanged.unchanged === insertedNodes, `final unchanged run expected ${insertedNodes} unchanged nodes, got ${finalUnchanged.unchanged}`);
      pushFailure(failures, await lockWasReleased(finalLockPath), "final unchanged run lock was not released");

      targetNodes = (await store.listNodes(args.scope)).length;
      targetEvents = (await store.getStoreInfo()).eventCount;
      checkpointNodes = await checkpointNodeCount(checkpointPath);
      pushFailure(failures, targetNodes === insertedNodes, `target node count ${targetNodes} did not match inserted node count ${insertedNodes}`);
      pushFailure(failures, targetEvents === insertedNodes, `target event count ${targetEvents} did not match inserted node count ${insertedNodes}`);
      pushFailure(failures, checkpointNodes === insertedNodes, `checkpoint node count ${checkpointNodes} did not match inserted node count ${insertedNodes}`);
    } finally {
      await store.close();
    }

    const reopened = await openSqliteAionisSubstrate({ path: targetPath });
    try {
      reopenedTargetNodes = (await reopened.listNodes(args.scope)).length;
      reopenedTargetEvents = (await reopened.getStoreInfo()).eventCount;
      const insertedNodes = countSourceNodes(sourcePath, args.scope);
      pushFailure(failures, reopenedTargetNodes === insertedNodes, `reopened node count ${reopenedTargetNodes} did not match inserted node count ${insertedNodes}`);
      pushFailure(failures, reopenedTargetEvents === insertedNodes, `reopened event count ${reopenedTargetEvents} did not match inserted node count ${insertedNodes}`);
    } finally {
      await reopened.close();
    }
  } finally {
    if (!args.keepTemp) {
      await rm(tempDir, { recursive: true, force: true });
      tempDirRemoved = true;
    }
  }

  const insertedNodes = args.batches * args.batchSize;
  return {
    contract_version: "aionis_runtime_live_sidecar_soak_report_v1",
    generated_at: new Date().toISOString(),
    temp_dir: tempDir,
    temp_dir_removed: tempDirRemoved,
    source_path: sourcePath,
    target_path: targetPath,
    checkpoint_path: checkpointPath,
    scope: args.scope,
    batches: args.batches,
    batch_size: args.batchSize,
    inserted_nodes: insertedNodes,
    target_nodes: targetNodes,
    reopened_target_nodes: reopenedTargetNodes,
    target_events: targetEvents,
    reopened_target_events: reopenedTargetEvents,
    checkpoint_nodes: checkpointNodes,
    final_unchanged: finalUnchanged,
    watch_runs: watchRuns,
    passed: failures.length === 0,
    failures,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await runSoak(args);
  await mkdir(dirname(args.output), { recursive: true });
  await writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    output: args.output,
    passed: report.passed,
    batches: report.batches,
    batch_size: report.batch_size,
    inserted_nodes: report.inserted_nodes,
    target_nodes: report.target_nodes,
    target_events: report.target_events,
    checkpoint_nodes: report.checkpoint_nodes,
    final_unchanged: report.final_unchanged,
  }, null, 2));
  if (!report.passed) process.exit(1);
}

main().catch((err) => {
  console.error((err as Error).stack ?? String(err));
  console.error(usage());
  process.exit(1);
});
