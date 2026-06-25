import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  compareSurfaces,
  extractRuntimeReferenceSurfaces,
  openSqliteAionisSubstrate,
  type RuntimeReferenceSurfaces,
} from "../src/index.ts";
import type {
  AionisAdmissionAction,
  AionisCompiledContext,
  AionisEvent,
  AionisSubstrate,
} from "../src/types.ts";

type Args = {
  runtimeRoot: string;
  outputDir: string;
  scenarioCount: number;
  maxPerBucket?: number;
};

type RuntimeHandle = {
  baseUrl: string;
  child: ChildProcess;
  logs: string[];
  writeDbPath: string;
  replayDbPath: string;
};

type AionisSdkModule = {
  createAionisClient: (options: Record<string, unknown>) => {
    health: () => Promise<unknown>;
    execution: {
      observeStep: <T = unknown>(input: Record<string, unknown>) => Promise<T>;
      guideForRole: <T = unknown>(input: Record<string, unknown>) => Promise<T>;
      feedbackFromOutcome: <T = unknown>(input: Record<string, unknown>) => Promise<T | null>;
      measureRun: <T = unknown>(input: Record<string, unknown>) => Promise<T>;
    };
  };
};

type DualWriteScenario = {
  id: string;
  taskFamily: string;
  workflowSignature: string;
  activeTarget: string;
  failedTarget: string;
  activeTitle: string;
  failedTitle: string;
  activeSummary: string;
  failedSummary: string;
  queryText: string;
  acceptanceCheck: string;
};

type ScenarioReport = {
  scenario_id: string;
  scope: string;
  run_id: string;
  runtime_memory_ids: {
    active: string;
    failed: string;
  };
  runtime_surfaces: RuntimeReferenceSurfaces;
  substrate_surfaces: RuntimeReferenceSurfaces;
  parity: {
    exact: boolean;
    bucket_reports: ReturnType<typeof compareSurfaces>;
  };
  event_counts: Record<AionisEvent["type"], number>;
  feedback_recorded: boolean;
  measure_recorded: boolean;
};

type ReopenReport = {
  scenario_id: string;
  scope: string;
  persisted_surfaces: RuntimeReferenceSurfaces;
  parity: {
    exact: boolean;
    bucket_reports: ReturnType<typeof compareSurfaces>;
  };
};

type RuntimeDualWriteExperimentReport = {
  contract_version: "aionis_runtime_dual_write_experiment_report_v1";
  generated_at: string;
  runtime_root: string;
  runtime_base_url: string;
  runtime_write_db_path: string;
  runtime_replay_db_path: string;
  substrate_db_path: string;
  scenario_count: number;
  exact_scenario_count: number;
  persisted_exact_scenario_count: number;
  failed_scenario_count: number;
  max_per_bucket: number | null;
  notes: string[];
  scenarios: ScenarioReport[];
  reopen: ReopenReport[];
};

const SCENARIOS: DualWriteScenario[] = [
  {
    id: "active-route",
    taskFamily: "dual_write_route_continuity",
    workflowSignature: "active-route-with-failed-branch",
    activeTarget: "src/runtime/current-route.ts",
    failedTarget: "src/runtime/failed-legacy-route.ts",
    activeTitle: "Accepted current runtime route",
    failedTitle: "Rejected legacy route",
    activeSummary: "Current route: continue {activeTarget}; verifier passed and this is the active route for the next worker.",
    failedSummary: "Failed branch: {failedTarget} failed verifier and must not be direct-use context.",
    queryText: "Continue {activeTarget} and avoid the failed legacy route.",
    acceptanceCheck: "verifier passed",
  },
  {
    id: "schema-migration",
    taskFamily: "dual_write_schema_migration",
    workflowSignature: "accepted-schema-migration-with-rejected-rollback",
    activeTarget: "src/storage/schema-migration.ts",
    failedTarget: "src/storage/rollback-adapter.ts",
    activeTitle: "Accepted schema migration route",
    failedTitle: "Rejected rollback adapter",
    activeSummary: "Current route: continue {activeTarget}; migration verifier passed and this is the accepted storage path.",
    failedSummary: "Failed branch: {failedTarget} produced incompatible replay state and must not be direct-use context.",
    queryText: "Continue the accepted migration route in {activeTarget} and avoid the rejected rollback branch.",
    acceptanceCheck: "migration verifier passed",
  },
  {
    id: "context-compiler",
    taskFamily: "dual_write_context_compiler",
    workflowSignature: "accepted-context-compiler-with-rejected-shortcut",
    activeTarget: "src/context/compiler.ts",
    failedTarget: "src/context/shortcut-summary.ts",
    activeTitle: "Accepted context compiler route",
    failedTitle: "Rejected shortcut summary route",
    activeSummary: "Current route: continue {activeTarget}; context compiler verifier passed with governed buckets intact.",
    failedSummary: "Failed branch: {failedTarget} collapsed blocked evidence into direct-use context and must not be reused.",
    queryText: "Continue the governed context compiler path in {activeTarget}.",
    acceptanceCheck: "context compiler verifier passed",
  },
  {
    id: "feedback-attribution",
    taskFamily: "dual_write_feedback_attribution",
    workflowSignature: "accepted-feedback-attribution-with-rejected-broad-counter-signal",
    activeTarget: "src/feedback/attribution.ts",
    failedTarget: "src/feedback/broad-negative-counter.ts",
    activeTitle: "Accepted attribution route",
    failedTitle: "Rejected broad negative counter-signal",
    activeSummary: "Current route: continue {activeTarget}; attribution verifier passed and feedback remained scoped to used memory.",
    failedSummary: "Failed branch: {failedTarget} attributed failure to exposed-but-unused memory and must not be direct-use context.",
    queryText: "Continue scoped feedback attribution in {activeTarget}.",
    acceptanceCheck: "attribution verifier passed",
  },
];

function usage(): string {
  return [
    "Usage:",
    "  npm run check:runtime-dual-write -- --runtime-root /path/AionisRuntime-focused [--scenario-count 4]",
    "",
    "Starts focused Runtime, runs real observe/guide/feedback/measure loops, writes the same observed",
    "execution states into an isolated Substrate SQLite store, and compares guide buckets before and after reopen.",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--runtime-root") {
      if (!value) throw new Error("--runtime-root requires a value");
      args.runtimeRoot = resolve(value);
      i += 1;
    } else if (flag === "--output-dir") {
      if (!value) throw new Error("--output-dir requires a value");
      args.outputDir = resolve(value);
      i += 1;
    } else if (flag === "--scenario-count") {
      if (!value) throw new Error("--scenario-count requires a value");
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) throw new Error("--scenario-count must be a positive integer");
      if (parsed > SCENARIOS.length) throw new Error(`--scenario-count cannot exceed ${SCENARIOS.length}`);
      args.scenarioCount = parsed;
      i += 1;
    } else if (flag === "--max-per-bucket") {
      if (!value) throw new Error("--max-per-bucket requires a value");
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) throw new Error("--max-per-bucket must be a non-negative integer");
      args.maxPerBucket = parsed;
      i += 1;
    } else if (flag === "--help" || flag === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (!args.runtimeRoot) throw new Error("--runtime-root is required");
  return {
    runtimeRoot: args.runtimeRoot,
    outputDir: args.outputDir ?? resolve("reports", `runtime-dual-write-${new Date().toISOString().replace(/[:.]/g, "-")}`),
    scenarioCount: args.scenarioCount ?? SCENARIOS.length,
    maxPerBucket: args.maxPerBucket,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate free port")));
        return;
      }
      const port = address.port;
      server.close(() => resolvePromise(port));
    });
  });
}

async function startRuntime(args: Args): Promise<RuntimeHandle> {
  await mkdir(args.outputDir, { recursive: true });
  const port = await findFreePort();
  const logs: string[] = [];
  const writeDbPath = join(args.outputDir, "runtime-write.sqlite");
  const replayDbPath = join(args.outputDir, "runtime-replay.sqlite");
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const child = spawn(npx, ["tsx", "src/index.ts"], {
    cwd: args.runtimeRoot,
    env: {
      ...process.env,
      AIONIS_EDITION: "lite",
      AIONIS_MODE: "local",
      APP_ENV: "ci",
      AIONIS_LISTEN_HOST: "127.0.0.1",
      PORT: String(port),
      MEMORY_AUTH_MODE: "off",
      TENANT_QUOTA_ENABLED: "false",
      RATE_LIMIT_ENABLED: "false",
      RATE_LIMIT_BYPASS_LOOPBACK: "true",
      LITE_LOCAL_ACTOR_ID: "substrate-dual-write-agent",
      LITE_WRITE_SQLITE_PATH: writeDbPath,
      LITE_REPLAY_SQLITE_PATH: replayDbPath,
      EMBEDDING_PROVIDER: "none",
      SANDBOX_ENABLED: "false",
      SANDBOX_ADMIN_ONLY: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    logs.push(String(chunk));
    if (logs.length > 100) logs.splice(0, logs.length - 100);
  });
  child.stderr.on("data", (chunk) => {
    logs.push(String(chunk));
    if (logs.length > 100) logs.splice(0, logs.length - 100);
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return { baseUrl, child, logs, writeDbPath, replayDbPath };
    } catch {
      // Runtime is still starting.
    }
    await sleep(250);
  }
  stopRuntime({ baseUrl, child, logs, writeDbPath, replayDbPath });
  throw new Error(`focused Runtime did not become healthy.\n${logs.join("").slice(-4_000)}`);
}

function stopRuntime(handle: RuntimeHandle): void {
  if (handle.child.exitCode === null) handle.child.kill("SIGTERM");
}

async function loadSdk(runtimeRoot: string): Promise<AionisSdkModule> {
  const moduleUrl = pathToFileURL(join(runtimeRoot, "src", "sdk.ts")).href;
  return await import(moduleUrl) as AionisSdkModule;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function firstNodeId(observeBody: unknown, label: string): string {
  const write = asRecord(asRecord(observeBody).memory_write);
  const nodes = Array.isArray(write.nodes) ? write.nodes.map(asRecord) : [];
  const id = nodes[0]?.id;
  if (typeof id !== "string" || !id) throw new Error(`${label} did not return a memory node id`);
  return id;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function scenarioText(template: string, scenario: DualWriteScenario): string {
  return template
    .replaceAll("{activeTarget}", scenario.activeTarget)
    .replaceAll("{failedTarget}", scenario.failedTarget);
}

function contextSurfaces(context: AionisCompiledContext): RuntimeReferenceSurfaces {
  return {
    use_now: context.use_now.map((node) => node.id),
    inspect_before_use: context.inspect_before_use.map((node) => node.id),
    do_not_use: context.do_not_use.map((node) => node.id),
    rehydrate: context.rehydrate.map((node) => node.id),
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function eventScope(event: AionisEvent): string | null {
  const payload = asRecord(event.payload);
  const scope = payload.scope;
  return typeof scope === "string" ? scope : null;
}

function eventCountsForScope(events: AionisEvent[], scope: string): Record<AionisEvent["type"], number> {
  const counts: Record<AionisEvent["type"], number> = {
    "memory.node.upsert": 0,
    "memory.lifecycle.transition": 0,
    "memory.relation.upsert": 0,
    "memory.feedback.recorded": 0,
    "memory.decision.recorded": 0,
  };
  for (const event of events) {
    if (eventScope(event) === scope) counts[event.type] += 1;
  }
  return counts;
}

async function writeObservedStateToSubstrate(input: {
  store: AionisSubstrate;
  scope: string;
  runId: string;
  scenario: DualWriteScenario;
  activeMemoryId: string;
  failedMemoryId: string;
}): Promise<void> {
  const { store, scope, runId, scenario, activeMemoryId, failedMemoryId } = input;
  await store.putNode({
    id: activeMemoryId,
    scope,
    kind: "execution",
    title: scenario.activeTitle,
    summary: scenarioText(scenario.activeSummary, scenario),
    lifecycle: "active",
    authority: "trusted",
    confidence: 0.96,
    targetFiles: [scenario.activeTarget],
    metadata: {
      source: "runtime_dual_write_experiment",
      run_id: runId,
      runtime_outcome: "succeeded",
      workflow_signature: scenario.workflowSignature,
    },
  });
  await store.putNode({
    id: failedMemoryId,
    scope,
    kind: "execution",
    title: scenario.failedTitle,
    summary: scenarioText(scenario.failedSummary, scenario),
    lifecycle: "blocked",
    authority: "rejected",
    confidence: 0.31,
    targetFiles: [scenario.failedTarget],
    payloadRef: `trace://dual-write/${runId}/${scenario.id}/failed/raw`,
    metadata: {
      source: "runtime_dual_write_experiment",
      run_id: runId,
      runtime_outcome: "failed",
      workflow_signature: "failed-legacy-route",
    },
  });
  await store.putRelation({
    scope,
    kind: "invalidates",
    sourceId: activeMemoryId,
    targetId: failedMemoryId,
    confidence: 0.9,
    reasons: ["accepted Runtime route invalidates failed branch for direct-use context"],
    metadata: { source: "runtime_dual_write_experiment", run_id: runId },
  });
}

async function runScenario(input: {
  args: Args;
  sdk: AionisSdkModule;
  handle: RuntimeHandle;
  store: AionisSubstrate;
  scenario: DualWriteScenario;
}): Promise<ScenarioReport> {
  const { args, sdk, handle, store, scenario } = input;
  const runId = `substrate-dual-write-${scenario.id}-${randomUUID().slice(0, 8)}`;
  const scope = `substrate-dual-write:${scenario.id}:${runId}`;
  const taskSignature = `substrate-dual-write-task:${scenario.id}:${runId}`;
  const agentId = "substrate-dual-write-agent";
  const client = sdk.createAionisClient({
    baseUrl: handle.baseUrl,
    tenant_id: "default",
    scope,
  });
  await client.health();

  const beforeGuide = await client.execution.guideForRole<Record<string, unknown>>({
    agent_id: agentId,
    role: "worker",
    run_id: `run:${runId}:before`,
    task_signature: taskSignature,
    task_family: scenario.taskFamily,
    workflow_signature: scenario.workflowSignature,
    query_text: "Continue dual-write validation if prior execution memory exists.",
    context_mode: "compact_agent",
    include_packets: true,
    limit: 8,
  });

  const activeObserve = await client.execution.observeStep<Record<string, unknown>>({
    agent_id: agentId,
    role: "worker",
    run_id: `run:${runId}:active`,
    task_signature: taskSignature,
    task_family: scenario.taskFamily,
    workflow_signature: scenario.workflowSignature,
    title: scenario.activeTitle,
    summary: scenarioText(scenario.activeSummary, scenario),
    outcome: "succeeded",
    target_files: [scenario.activeTarget],
    workflow_steps: ["inspect current route", "patch active file", "run verifier"],
    tool_set: ["read", "edit", "test"],
    acceptance_checks: [scenario.acceptanceCheck],
    continuation_hint: `Continue ${scenario.activeTarget}.`,
    confidence: 0.96,
    evidence_ref: `evidence://dual-write/${runId}/${scenario.id}/active-route`,
    slots: {
      execution_result_summary: {
        status: "passed",
        summary: "Accepted active route should remain directly usable.",
      },
    },
  });
  const activeMemoryId = firstNodeId(activeObserve, "active route");

  const failedObserve = await client.execution.observeStep<Record<string, unknown>>({
    agent_id: agentId,
    role: "worker",
    run_id: `run:${runId}:failed`,
    task_signature: taskSignature,
    task_family: scenario.taskFamily,
    workflow_signature: "failed-legacy-route",
    title: scenario.failedTitle,
    summary: scenarioText(scenario.failedSummary, scenario),
    outcome: "failed",
    target_files: [scenario.failedTarget],
    workflow_steps: ["inspect legacy route", "patch legacy file", "verifier failed"],
    tool_set: ["read", "edit", "test"],
    acceptance_checks: ["verifier failed"],
    continuation_hint: `Do not continue ${scenario.failedTarget}; use ${scenario.activeTarget}.`,
    confidence: 0.31,
    raw_ref: `trace://dual-write/${runId}/${scenario.id}/failed/raw`,
    evidence_ref: `evidence://dual-write/${runId}/${scenario.id}/failed-route`,
    verification: {
      verifier_agent_id: "verifier",
      passed: false,
      reason: `${scenario.failedTitle} regressed the dual-write validation task.`,
    },
    slots: {
      execution_result_summary: {
        status: "failed",
        summary: "Failed route is counter-evidence, not a reusable workflow.",
      },
    },
  });
  const failedMemoryId = firstNodeId(failedObserve, "failed route");

  await writeObservedStateToSubstrate({
    store,
    scope,
    runId,
    scenario,
    activeMemoryId,
    failedMemoryId,
  });

  const afterGuide = await client.execution.guideForRole<Record<string, unknown>>({
    agent_id: agentId,
    role: "worker",
    run_id: `run:${runId}:after`,
    task_signature: taskSignature,
    task_family: scenario.taskFamily,
    workflow_signature: scenario.workflowSignature,
    query_text: scenarioText(scenario.queryText, scenario),
    context: {
      task_signature: taskSignature,
      task_family: scenario.taskFamily,
      workflow_signature: scenario.workflowSignature,
      requested_targets: [scenario.activeTarget],
      blocked_targets: [scenario.failedTarget],
    },
    context_mode: "compact_agent",
    include_packets: true,
    limit: 12,
  });
  const runtimeSurfaces = extractRuntimeReferenceSurfaces({ agent_context: afterGuide.agent_context });
  const compiled = await store.compileContext({
    scope,
    query: scenarioText(scenario.queryText, scenario),
    maxPerBucket: args.maxPerBucket,
  });
  const substrateSurfaces = contextSurfaces(compiled);
  const bucketReports = compareSurfaces(substrateSurfaces, runtimeSurfaces);

  const usedMemoryIds = stringArray(asRecord(afterGuide.agent_context).use_now_memory_ids);
  const feedback = await client.execution.feedbackFromOutcome<Record<string, unknown>>({
    agent_id: agentId,
    role: "worker",
    run_id: `run:${runId}:feedback`,
    task_signature: taskSignature,
    task_family: scenario.taskFamily,
    workflow_signature: scenario.workflowSignature,
    title: "Dual-write worker used active route",
    summary: "Worker used the active route exposed by focused Runtime and avoided the failed branch.",
    outcome: "succeeded",
    guide: afterGuide,
    used_memory_ids: usedMemoryIds.includes(activeMemoryId) ? [activeMemoryId] : usedMemoryIds.slice(0, 1),
    feedback_outcome: "positive",
    used_surface: "use_now",
    verifier_status: "passed",
    tool_status: "succeeded",
    feedback_reason: "Active route was exposed and used successfully.",
  });
  await store.recordFeedback({
    scope,
    memoryId: activeMemoryId,
    outcome: "positive",
    strength: "strong",
    runId,
    evidenceRef: `feedback://dual-write/${runId}/${scenario.id}/positive-use`,
  });

  const measure = await client.execution.measureRun<Record<string, unknown>>({
    run_id: runId,
    task_signature: taskSignature,
    task_family: scenario.taskFamily,
    workflow_signature: scenario.workflowSignature,
    before_guide: beforeGuide,
    after_guide: afterGuide,
    feedback_result: feedback,
    sufficient_evidence: true,
    evidence_ids: [
      `memory:${activeMemoryId}`,
      `memory:${failedMemoryId}`,
      `feedback:${runId}`,
    ],
  });

  const events = await store.listEvents();
  return {
    scenario_id: scenario.id,
    scope,
    run_id: runId,
    runtime_memory_ids: {
      active: activeMemoryId,
      failed: failedMemoryId,
    },
    runtime_surfaces: runtimeSurfaces,
    substrate_surfaces: substrateSurfaces,
    parity: {
      exact: bucketReports.every((bucket) => bucket.exact),
      bucket_reports: bucketReports,
    },
    event_counts: eventCountsForScope(events, scope),
    feedback_recorded: feedback !== null,
    measure_recorded: Object.keys(measure).length > 0,
  };
}

async function runReopenCheck(input: {
  substratePath: string;
  scenarios: ScenarioReport[];
  maxPerBucket?: number;
}): Promise<ReopenReport[]> {
  const store = await openSqliteAionisSubstrate({ path: input.substratePath });
  try {
    const reports: ReopenReport[] = [];
    for (const scenario of input.scenarios) {
      const compiled = await store.compileContext({
        scope: scenario.scope,
        query: `reopen check for ${scenario.scenario_id}`,
        maxPerBucket: input.maxPerBucket,
      });
      const persistedSurfaces = contextSurfaces(compiled);
      const bucketReports = compareSurfaces(persistedSurfaces, scenario.runtime_surfaces);
      reports.push({
        scenario_id: scenario.scenario_id,
        scope: scenario.scope,
        persisted_surfaces: persistedSurfaces,
        parity: {
          exact: bucketReports.every((bucket) => bucket.exact),
          bucket_reports: bucketReports,
        },
      });
    }
    return reports;
  } finally {
    await store.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.outputDir, { recursive: true });
  const handle = await startRuntime(args);
  const substratePath = join(args.outputDir, "substrate-dual-write.sqlite");
  const store = await openSqliteAionisSubstrate({ path: substratePath });
  try {
    const sdk = await loadSdk(args.runtimeRoot);
    const scenarioReports: ScenarioReport[] = [];
    for (const scenario of SCENARIOS.slice(0, args.scenarioCount)) {
      scenarioReports.push(await runScenario({
        args,
        sdk,
        handle,
        store,
        scenario,
      }));
    }
    await store.close();
    const reopenReports = await runReopenCheck({
      substratePath,
      scenarios: scenarioReports,
      maxPerBucket: args.maxPerBucket,
    });

    const exactScenarioCount = scenarioReports.filter((scenario) => scenario.parity.exact).length;
    const persistedExactScenarioCount = reopenReports.filter((scenario) => scenario.parity.exact).length;
    const reopenByScenario = new Map(reopenReports.map((scenario) => [scenario.scenario_id, scenario]));
    const failedScenarioCount = scenarioReports.filter((scenario) => {
      const reopen = reopenByScenario.get(scenario.scenario_id);
      return !scenario.parity.exact || !reopen?.parity.exact;
    }).length;
    const report: RuntimeDualWriteExperimentReport = {
      contract_version: "aionis_runtime_dual_write_experiment_report_v1",
      generated_at: new Date().toISOString(),
      runtime_root: args.runtimeRoot,
      runtime_base_url: handle.baseUrl,
      runtime_write_db_path: handle.writeDbPath,
      runtime_replay_db_path: handle.replayDbPath,
      substrate_db_path: substratePath,
      scenario_count: scenarioReports.length,
      exact_scenario_count: exactScenarioCount,
      persisted_exact_scenario_count: persistedExactScenarioCount,
      failed_scenario_count: failedScenarioCount,
      max_per_bucket: args.maxPerBucket ?? null,
      notes: [
        "This experiment runs real focused Runtime observe/guide/feedback/measure calls.",
        "Substrate is written as an external sidecar using the same observed memory ids and outcomes.",
        "This is not Runtime storage replacement and does not mutate AionisRuntime-focused source code.",
      ],
      scenarios: scenarioReports,
      reopen: reopenReports,
    };
    const reportPath = join(args.outputDir, "summary.json");
    await writeJson(reportPath, report);
    console.log(JSON.stringify({
      report: reportPath,
      runtime_write_sqlite_path: handle.writeDbPath,
      substrate_db_path: substratePath,
      scenario_count: report.scenario_count,
      exact_scenario_count: report.exact_scenario_count,
      persisted_exact_scenario_count: report.persisted_exact_scenario_count,
      failed_scenario_count: report.failed_scenario_count,
    }, null, 2));
    if (report.failed_scenario_count > 0) process.exitCode = 1;
  } finally {
    await store.close().catch(() => undefined);
    stopRuntime(handle);
  }
}

main().catch((err) => {
  console.error((err as Error).stack ?? String(err));
  console.error(usage());
  process.exit(1);
});
