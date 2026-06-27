import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  openSqliteAionisSubstrate,
  runRuntimeLiveSidecarOnce,
  runRuntimeLiveSidecarWatch,
} from "../src/index.ts";

type Args = {
  outputPath: string;
  keepTemp: boolean;
};

type RecoveryScenarioReport = {
  scenario: string;
  passed: boolean;
  expected_error: string | null;
  event_count_before: number;
  event_count_after: number;
  lock_released?: boolean;
  warning_count?: number;
};

type RecoveryReport = {
  contract_version: "aionis_runtime_live_sidecar_recovery_report_v1";
  generated_at: string;
  temp_dir: string | null;
  source_path: string;
  target_path: string;
  checkpoint_path: string;
  source_nodes: number;
  scenarios: RecoveryScenarioReport[];
  passed: boolean;
};

function usage(): string {
  return [
    "Usage:",
    "  node scripts/runtime-live-sidecar-recovery-check.ts [--output report.json] [--keep-temp]",
    "",
    "Creates real Runtime Lite and Substrate SQLite stores, injects checkpoint failures,",
    "and verifies live-sidecar fails closed without mutating target state.",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    outputPath: resolve("reports", `runtime-live-sidecar-recovery-${new Date().toISOString().replace(/[:.]/g, "-")}`, "summary.json"),
    keepTemp: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--output") {
      if (!value?.trim()) throw new Error("--output requires a value");
      args.outputPath = resolve(value);
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

function insertRuntimeNode(path: string, id: string, summary: string, createdAt: string): void {
  const db = new DatabaseSync(path);
  try {
    db.prepare(`
      INSERT INTO lite_memory_nodes (
        id, scope, client_id, type, tier, title, text_summary, slots_json, raw_ref, evidence_ref,
        embedding_vector_json, embedding_model, memory_lane, producer_agent_id, owner_agent_id,
        owner_team_id, embedding_status, embedding_last_error, salience, importance, confidence,
        redaction_version, commit_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      "repo-a",
      `client-${id}`,
      "procedure",
      "hot",
      id,
      summary,
      JSON.stringify({
        summary_kind: "workflow_anchor",
        contract_trust: "trusted",
        target_files: ["src/runtime.ts"],
      }),
      null,
      null,
      null,
      "fixture-embedding",
      "execution",
      "agent-a",
      "agent-a",
      "team-a",
      "ready",
      null,
      0.8,
      0.8,
      0.95,
      1,
      "commit-a",
      createdAt,
    );
  } finally {
    db.close();
  }
}

function countSourceNodes(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT count(*) AS count FROM lite_memory_nodes").get() as { count: number };
    return Number(row.count);
  } finally {
    db.close();
  }
}

async function lockReleased(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function runCheck(args: Args): Promise<RecoveryReport> {
  const tempDir = await mkdtemp(join(tmpdir(), "aionis-live-sidecar-recovery-"));
  const sourcePath = join(tempDir, "runtime.sqlite");
  const targetPath = join(tempDir, "substrate.sqlite");
  const checkpointPath = join(tempDir, "checkpoint.json");
  const scenarios: RecoveryScenarioReport[] = [];
  let removeTemp = !args.keepTemp;

  try {
    createRuntimeLiteSource(sourcePath);
    insertRuntimeNode(sourcePath, "runtime-current", "Use src/runtime.ts after verifier passed.", "2026-06-01T00:00:00.000Z");

    const store = await openSqliteAionisSubstrate({ path: targetPath });
    try {
      await runRuntimeLiveSidecarOnce({ sourcePath, target: store, checkpointPath, scope: "repo-a" });
      const validCheckpoint = await readFile(checkpointPath, "utf8");
      insertRuntimeNode(sourcePath, "runtime-new", "This row must not mirror while checkpoint is unsafe.", "2026-06-02T00:00:00.000Z");

      const corruptLockPath = join(tempDir, "corrupt-checkpoint.lock");
      const corruptBefore = (await store.getStoreInfo()).eventCount;
      await writeFile(checkpointPath, "{ corrupt checkpoint\n", "utf8");
      await assert.rejects(
        runRuntimeLiveSidecarWatch({
          sourcePath,
          target: store,
          checkpointPath,
          scope: "repo-a",
          intervalMs: 1,
          iterations: 1,
          lockPath: corruptLockPath,
        }),
        /failed to parse Runtime live sidecar checkpoint/,
      );
      const corruptAfter = (await store.getStoreInfo()).eventCount;
      const corruptLockReleased = await lockReleased(corruptLockPath);
      scenarios.push({
        scenario: "corrupt_checkpoint_fails_closed",
        passed: corruptBefore === corruptAfter && corruptLockReleased,
        expected_error: "failed to parse Runtime live sidecar checkpoint",
        event_count_before: corruptBefore,
        event_count_after: corruptAfter,
        lock_released: corruptLockReleased,
      });

      const malformedBefore = (await store.getStoreInfo()).eventCount;
      await writeFile(checkpointPath, `${JSON.stringify({
        contract_version: "aionis_runtime_live_sidecar_checkpoint_v1",
        source_path: sourcePath,
        scope: "repo-a",
        updated_at: "2026-06-01T00:00:00.000Z",
        last_run_id: null,
        fingerprints: {
          nodes: { "repo-a\u0000runtime-current": 123 },
          relations: {},
          feedback: {},
          decisions: {},
        },
      }, null, 2)}\n`, "utf8");
      await assert.rejects(
        runRuntimeLiveSidecarOnce({ sourcePath, target: store, checkpointPath, scope: "repo-a" }),
        /must be a string fingerprint/,
      );
      const malformedAfter = (await store.getStoreInfo()).eventCount;
      scenarios.push({
        scenario: "malformed_checkpoint_fails_closed",
        passed: malformedBefore === malformedAfter,
        expected_error: "must be a string fingerprint",
        event_count_before: malformedBefore,
        event_count_after: malformedAfter,
      });

      const mismatchBefore = (await store.getStoreInfo()).eventCount;
      await writeFile(checkpointPath, `${JSON.stringify({
        contract_version: "aionis_runtime_live_sidecar_checkpoint_v1",
        source_path: join(tempDir, "different-runtime.sqlite"),
        scope: "repo-a",
        updated_at: "2026-06-01T00:00:00.000Z",
        last_run_id: null,
        fingerprints: {
          nodes: {},
          relations: {},
          feedback: {},
          decisions: {},
        },
      }, null, 2)}\n`, "utf8");
      await assert.rejects(
        runRuntimeLiveSidecarOnce({ sourcePath, target: store, checkpointPath, scope: "repo-a" }),
        /checkpoint source_path\/scope does not match/,
      );
      const mismatchAfter = (await store.getStoreInfo()).eventCount;
      scenarios.push({
        scenario: "source_scope_mismatch_fails_closed",
        passed: mismatchBefore === mismatchAfter,
        expected_error: "checkpoint source_path/scope does not match",
        event_count_before: mismatchBefore,
        event_count_after: mismatchAfter,
      });

      const emptyTargetPath = join(tempDir, "substrate-empty.sqlite");
      await writeFile(checkpointPath, validCheckpoint, "utf8");
      const emptyStore = await openSqliteAionisSubstrate({ path: emptyTargetPath });
      try {
        const emptyBefore = (await emptyStore.getStoreInfo()).eventCount;
        const replay = await runRuntimeLiveSidecarOnce({ sourcePath, target: emptyStore, checkpointPath, scope: "repo-a" });
        const emptyAfter = (await emptyStore.getStoreInfo()).eventCount;
        scenarios.push({
          scenario: "empty_target_replays_despite_stale_checkpoint",
          passed: emptyBefore === 0
            && emptyAfter === countSourceNodes(sourcePath)
            && replay.warnings.some((warning) => warning.includes("checkpoint ignored because target store is empty")),
          expected_error: null,
          event_count_before: emptyBefore,
          event_count_after: emptyAfter,
          warning_count: replay.warnings.length,
        });
      } finally {
        await emptyStore.close();
      }
    } finally {
      await store.close();
    }

    const report: RecoveryReport = {
      contract_version: "aionis_runtime_live_sidecar_recovery_report_v1",
      generated_at: new Date().toISOString(),
      temp_dir: args.keepTemp ? tempDir : null,
      source_path: sourcePath,
      target_path: targetPath,
      checkpoint_path: checkpointPath,
      source_nodes: countSourceNodes(sourcePath),
      scenarios,
      passed: scenarios.every((scenario) => scenario.passed),
    };
    removeTemp = !args.keepTemp;
    return report;
  } finally {
    if (removeTemp) await rm(tempDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await runCheck(args);
  await mkdir(dirname(args.outputPath), { recursive: true });
  await writeFile(args.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    output: args.outputPath,
    passed: report.passed,
    scenarios: report.scenarios.map((scenario) => ({
      scenario: scenario.scenario,
      passed: scenario.passed,
      event_count_before: scenario.event_count_before,
      event_count_after: scenario.event_count_after,
      lock_released: scenario.lock_released,
      warning_count: scenario.warning_count,
    })),
  }, null, 2));
  if (!report.passed) process.exit(1);
}

main().catch((error) => {
  console.error((error as Error).stack ?? String(error));
  console.error(usage());
  process.exit(1);
});
