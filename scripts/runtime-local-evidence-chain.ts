import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
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
  sourcePath?: string;
  scope: string;
  outputPath: string;
  keepTemp: boolean;
};

type BucketIds = {
  use_now: string[];
  inspect_before_use: string[];
  do_not_use: string[];
  rehydrate: string[];
};

type LocalEvidenceChainReport = {
  contract_version: "aionis_substrate_runtime_local_evidence_chain_report_v1";
  generated_at: string;
  fixture_mode: boolean;
  temp_dir: string;
  source_path: string;
  source_sha256_before: string;
  source_sha256_after: string;
  source_unchanged: boolean;
  target_path: string;
  checkpoint_path: string;
  backup_path: string;
  restored_path: string;
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
    idempotent_second_pass: boolean;
  };
  backup: {
    ok: boolean;
    event_count: number;
    last_sequence: number;
    events_sha256: string | null;
  };
  restore_plan: {
    read_only: true;
    would_restore: boolean;
    counts: {
      nodes: number;
      relations: number;
      feedback: number;
      decisions: number;
      scopes: string[];
    } | null;
  };
  context: {
    before_backup: BucketIds;
    after_restore: BucketIds;
    equivalent_after_restore: boolean;
    expected_runtime_buckets_present: boolean;
  };
  passed: boolean;
  failures: string[];
};

function usage(): string {
  return [
    "Aionis Substrate Runtime local evidence chain check",
    "",
    "Usage:",
    "  node scripts/runtime-local-evidence-chain.ts [--source <runtime.sqlite>] [--scope <scope>] [--output <report.json>] [--keep-temp]",
    "",
    "Without --source, the script creates a local Runtime Lite fixture. With --source,",
    "the Runtime SQLite file is opened read-only and mirrored into an isolated Substrate target.",
  ].join("\n");
}

function parseArgs(argv = process.argv.slice(2)): Args {
  const args: Args = {
    scope: "repo-a",
    outputPath: resolve("reports", `runtime-local-evidence-chain-${new Date().toISOString().replace(/[:.]/g, "-")}`, "summary.json"),
    keepTemp: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--source") {
      if (!value) throw new Error("--source requires a value");
      args.sourcePath = resolve(value);
      i += 1;
    } else if (flag === "--scope") {
      if (!value) throw new Error("--scope requires a value");
      args.scope = value;
      i += 1;
    } else if (flag === "--output") {
      if (!value) throw new Error("--output requires a value");
      args.outputPath = resolve(value);
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
  return args;
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function createRuntimeLiteFixture(path: string, scope: string): void {
  const db = new DatabaseSync(path);
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

    CREATE TABLE lite_memory_edges (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      type TEXT NOT NULL,
      src_id TEXT NOT NULL,
      dst_id TEXT NOT NULL,
      weight REAL NOT NULL,
      confidence REAL NOT NULL,
      decay_rate REAL NOT NULL,
      metadata_json TEXT NOT NULL,
      commit_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE lite_memory_rule_feedback (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      rule_node_id TEXT NOT NULL,
      run_id TEXT,
      outcome TEXT NOT NULL,
      note TEXT,
      source TEXT NOT NULL,
      decision_id TEXT,
      commit_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE lite_memory_execution_decisions (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      decision_kind TEXT NOT NULL,
      run_id TEXT,
      selected_tool TEXT,
      candidates_json TEXT NOT NULL,
      context_sha256 TEXT NOT NULL,
      policy_sha256 TEXT NOT NULL,
      source_rule_ids_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      commit_id TEXT,
      created_at TEXT NOT NULL
    );
  `);

  insertRuntimeNode(db, {
    id: "runtime-current-route",
    scope,
    type: "procedure",
    tier: "hot",
    title: "Accepted current route",
    summary: "Continue the accepted Runtime route in src/current-route.ts after verifier passed.",
    slots: {
      summary_kind: "workflow_anchor",
      contract_trust: "trusted",
      target_files: ["src/current-route.ts"],
      verification: { passed: true },
    },
    rawRef: null,
    confidence: 0.96,
    createdAt: "2026-06-27T00:00:00.000Z",
  });
  insertRuntimeNode(db, {
    id: "runtime-old-route",
    scope,
    type: "procedure",
    tier: "hot",
    title: "Superseded old route",
    summary: "Old route in src/legacy-route.ts failed verifier and was superseded by the current route.",
    slots: {
      summary_kind: "workflow_anchor",
      target_files: ["src/legacy-route.ts"],
      verification: { passed: false },
      execution_observation_v1: { outcome: "failed" },
    },
    rawRef: null,
    confidence: 0.83,
    createdAt: "2026-06-27T00:01:00.000Z",
  });
  insertRuntimeNode(db, {
    id: "runtime-raw-trace",
    scope,
    type: "trace",
    tier: "cold",
    title: "Raw verifier trace",
    summary: "Raw verifier trace is available for the accepted route and should be rehydrated only on demand.",
    slots: {
      summary_kind: "raw_trace",
      lifecycle: "rehydrate_required",
      target_files: ["src/current-route.ts"],
    },
    rawRef: "file://runtime-trace.log",
    confidence: 0.9,
    createdAt: "2026-06-27T00:02:00.000Z",
  });

  db.prepare(`
    INSERT INTO lite_memory_edges (
      id, scope, type, src_id, dst_id, weight, confidence, decay_rate, metadata_json, commit_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "runtime-current-supersedes-old",
    scope,
    "supersedes",
    "runtime-current-route",
    "runtime-old-route",
    0.95,
    0.95,
    0,
    JSON.stringify({ reason: "current verifier evidence replaced old route" }),
    "fixture-commit",
    "2026-06-27T00:03:00.000Z",
  );

  insertRuntimeFeedback(db, {
    id: "runtime-current-positive-feedback",
    scope,
    ruleNodeId: "runtime-current-route",
    outcome: "positive",
    note: "Accepted route passed verification.",
    decisionId: "runtime-use-current",
    createdAt: "2026-06-27T00:04:00.000Z",
  });
  insertRuntimeFeedback(db, {
    id: "runtime-old-negative-feedback",
    scope,
    ruleNodeId: "runtime-old-route",
    outcome: "negative",
    note: "Old route failed verification.",
    decisionId: "runtime-block-old",
    createdAt: "2026-06-27T00:05:00.000Z",
  });

  insertRuntimeDecision(db, {
    id: "runtime-use-current",
    scope,
    decisionKind: "use_current_route",
    sourceRuleIds: ["runtime-current-route"],
    createdAt: "2026-06-27T00:06:00.000Z",
  });
  insertRuntimeDecision(db, {
    id: "runtime-block-old",
    scope,
    decisionKind: "block_failed_route",
    sourceRuleIds: ["runtime-old-route"],
    createdAt: "2026-06-27T00:07:00.000Z",
  });
  insertRuntimeDecision(db, {
    id: "runtime-rehydrate-trace",
    scope,
    decisionKind: "rehydrate_payload",
    sourceRuleIds: ["runtime-raw-trace"],
    createdAt: "2026-06-27T00:08:00.000Z",
  });

  db.close();
}

function insertRuntimeNode(db: DatabaseSync, input: {
  id: string;
  scope: string;
  type: string;
  tier: string;
  title: string;
  summary: string;
  slots: Record<string, unknown>;
  rawRef: string | null;
  confidence: number;
  createdAt: string;
}): void {
  db.prepare(`
    INSERT INTO lite_memory_nodes (
      id, scope, client_id, type, tier, title, text_summary, slots_json, raw_ref, evidence_ref,
      embedding_vector_json, embedding_model, memory_lane, producer_agent_id, owner_agent_id,
      owner_team_id, embedding_status, embedding_last_error, salience, importance, confidence,
      redaction_version, commit_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.scope,
    `client-${input.id}`,
    input.type,
    input.tier,
    input.title,
    input.summary,
    JSON.stringify(input.slots),
    input.rawRef,
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
    input.confidence,
    1,
    "fixture-commit",
    input.createdAt,
  );
}

function insertRuntimeFeedback(db: DatabaseSync, input: {
  id: string;
  scope: string;
  ruleNodeId: string;
  outcome: string;
  note: string;
  decisionId: string;
  createdAt: string;
}): void {
  db.prepare(`
    INSERT INTO lite_memory_rule_feedback (
      id, scope, rule_node_id, run_id, outcome, note, source, decision_id, commit_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.scope,
    input.ruleNodeId,
    "runtime-local-evidence-chain",
    input.outcome,
    input.note,
    "runtime_fixture",
    input.decisionId,
    "fixture-commit",
    input.createdAt,
  );
}

function insertRuntimeDecision(db: DatabaseSync, input: {
  id: string;
  scope: string;
  decisionKind: string;
  sourceRuleIds: string[];
  createdAt: string;
}): void {
  db.prepare(`
    INSERT INTO lite_memory_execution_decisions (
      id, scope, decision_kind, run_id, selected_tool, candidates_json, context_sha256,
      policy_sha256, source_rule_ids_json, metadata_json, commit_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.scope,
    input.decisionKind,
    "runtime-local-evidence-chain",
    null,
    JSON.stringify([]),
    createHash("sha256").update(input.id).digest("hex"),
    createHash("sha256").update("fixture-policy").digest("hex"),
    JSON.stringify(input.sourceRuleIds),
    JSON.stringify({ fixture: true }),
    "fixture-commit",
    input.createdAt,
  );
}

function totalApplied(summary: LocalEvidenceChainReport["mirror"]["second"]): number {
  return summary.nodes.applied + summary.relations.applied + summary.feedback.applied + summary.decisions.applied;
}

function bucketIds(context: AionisCompiledContext): BucketIds {
  return {
    use_now: context.use_now.map((node) => node.id).sort(),
    inspect_before_use: context.inspect_before_use.map((node) => node.id).sort(),
    do_not_use: context.do_not_use.map((node) => node.id).sort(),
    rehydrate: context.rehydrate.map((node) => node.id).sort(),
  };
}

function sameBuckets(left: BucketIds, right: BucketIds): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasExpectedFixtureBuckets(buckets: BucketIds): boolean {
  return buckets.use_now.includes("runtime-current-route")
    && buckets.do_not_use.includes("runtime-old-route")
    && buckets.rehydrate.includes("runtime-raw-trace");
}

async function main(): Promise<void> {
  const args = parseArgs();
  const tempDir = await mkdtemp(join(tmpdir(), "aionis-runtime-local-evidence-chain-"));
  const fixtureMode = !args.sourcePath;
  const sourcePath = args.sourcePath ?? join(tempDir, "runtime.sqlite");
  const targetPath = join(tempDir, "substrate.sqlite");
  const checkpointPath = join(tempDir, "checkpoint.json");
  const backupPath = join(tempDir, "backup.json");
  const restoredPath = join(tempDir, "restored.sqlite");

  const failures: string[] = [];
  try {
    if (fixtureMode) createRuntimeLiteFixture(sourcePath, args.scope);
    const sourceShaBefore = await sha256File(sourcePath);

    const store = await openSqliteAionisSubstrate({ path: targetPath });
    const first = await runRuntimeLiveSidecarOnce({
      sourcePath,
      target: store,
      checkpointPath,
      scope: args.scope,
    });
    const second = await runRuntimeLiveSidecarOnce({
      sourcePath,
      target: store,
      checkpointPath,
      scope: args.scope,
    });
    const contextBeforeBackup = bucketIds(await store.previewContext({ scope: args.scope, query: "continue accepted route" }));
    const backup = await exportAionisSubstrateBackup(store, { createdAt: "2026-06-27T00:00:00.000Z" });
    const verification = verifyAionisSubstrateBackup(backup);
    await writeFile(backupPath, `${JSON.stringify(backup, null, 2)}\n`, "utf8");
    await store.close();

    const restoreSnapshot = verification.snapshot;
    if (totalApplied(second.apply_summary) !== 0) failures.push("second mirror pass was not idempotent");
    if (first.import_summary.nodesImported <= 0) failures.push("first mirror pass imported zero Runtime nodes");
    if (!verification.ok) failures.push(`backup verification failed: ${verification.errors.join("; ")}`);
    if (!restoreSnapshot) failures.push("restore-plan snapshot was unavailable");
    if (fixtureMode && !hasExpectedFixtureBuckets(contextBeforeBackup)) {
      failures.push("fixture context buckets did not preserve use_now/do_not_use/rehydrate expectations");
    }

    await restoreAionisSubstrateBackupToSqlite(backup, restoredPath);
    const restored = await openSqliteAionisSubstrate({ path: restoredPath });
    const contextAfterRestore = bucketIds(await restored.previewContext({ scope: args.scope, query: "continue accepted route" }));
    await restored.close();
    if (!sameBuckets(contextBeforeBackup, contextAfterRestore)) failures.push("restored context buckets differ from mirrored context buckets");

    const sourceShaAfter = await sha256File(sourcePath);
    if (sourceShaBefore !== sourceShaAfter) failures.push("Runtime source SQLite changed during read-only mirror");

    const report: LocalEvidenceChainReport = {
      contract_version: "aionis_substrate_runtime_local_evidence_chain_report_v1",
      generated_at: new Date().toISOString(),
      fixture_mode: fixtureMode,
      temp_dir: tempDir,
      source_path: sourcePath,
      source_sha256_before: sourceShaBefore,
      source_sha256_after: sourceShaAfter,
      source_unchanged: sourceShaBefore === sourceShaAfter,
      target_path: targetPath,
      checkpoint_path: checkpointPath,
      backup_path: backupPath,
      restored_path: restoredPath,
      mirror: {
        first: first.apply_summary,
        second: second.apply_summary,
        idempotent_second_pass: totalApplied(second.apply_summary) === 0,
      },
      backup: {
        ok: verification.ok,
        event_count: backup.eventCount,
        last_sequence: backup.lastSequence,
        events_sha256: verification.eventsSha256,
      },
      restore_plan: {
        read_only: true,
        would_restore: verification.ok,
        counts: restoreSnapshot ? {
          nodes: restoreSnapshot.nodes.length,
          relations: restoreSnapshot.relations.length,
          feedback: restoreSnapshot.feedback.length,
          decisions: restoreSnapshot.decisions.length,
          scopes: Array.from(new Set([
            ...restoreSnapshot.nodes.map((node) => node.scope),
            ...restoreSnapshot.relations.map((relation) => relation.scope),
            ...restoreSnapshot.feedback.map((feedback) => feedback.scope),
            ...restoreSnapshot.decisions.map((decision) => decision.scope),
          ])).sort(),
        } : null,
      },
      context: {
        before_backup: contextBeforeBackup,
        after_restore: contextAfterRestore,
        equivalent_after_restore: sameBuckets(contextBeforeBackup, contextAfterRestore),
        expected_runtime_buckets_present: fixtureMode ? hasExpectedFixtureBuckets(contextBeforeBackup) : true,
      },
      passed: failures.length === 0,
      failures,
    };

    await mkdir(dirname(args.outputPath), { recursive: true });
    await writeFile(args.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      output: args.outputPath,
      passed: report.passed,
      fixture_mode: report.fixture_mode,
      source_unchanged: report.source_unchanged,
      mirror_idempotent: report.mirror.idempotent_second_pass,
      backup_ok: report.backup.ok,
      restore_would_restore: report.restore_plan.would_restore,
      context_equivalent_after_restore: report.context.equivalent_after_restore,
      failures: report.failures,
    }, null, 2));
    if (!report.passed) process.exitCode = 1;
  } finally {
    if (!args.keepTemp) await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error((err as Error).stack ?? String(err));
  console.error("");
  console.error(usage());
  process.exit(1);
});
