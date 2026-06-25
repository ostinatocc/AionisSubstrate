import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runRuntimeReferenceCorpus } from "../src/index.ts";

type Args = {
  runtimeRoot: string;
  outputDir: string;
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

function usage(): string {
  return [
    "Usage:",
    "  node scripts/runtime-product-reference-fixture.ts --runtime-root /path/AionisRuntime-focused",
    "",
    "Starts focused Runtime with a persistent Lite SQLite path, runs a real product guide/measure loop,",
    "writes same-source reference JSON, then runs Substrate Runtime reference corpus parity.",
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
    outputDir: args.outputDir ?? resolve("reports", `runtime-product-reference-${new Date().toISOString().replace(/[:.]/g, "-")}`),
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
      LITE_LOCAL_ACTOR_ID: "substrate-reference-agent",
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

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function runProductLoop(args: Args, handle: RuntimeHandle): Promise<{
  referencePath: string;
  runSummaryPath: string;
  parityPath: string;
  parity: Awaited<ReturnType<typeof runRuntimeReferenceCorpus>>;
}> {
  const sdk = await loadSdk(args.runtimeRoot);
  const runId = `substrate-reference-${randomUUID().slice(0, 8)}`;
  const scope = `substrate-reference:${runId}`;
  const taskSignature = `substrate-reference-task:${runId}`;
  const taskFamily = "substrate_reference_parity";
  const workflowSignature = "active-route-with-failed-branch";
  const activeTarget = "src/runtime/current-route.ts";
  const failedTarget = "src/runtime/failed-legacy-route.ts";
  const agentId = "substrate-reference-agent";
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
    task_family: taskFamily,
    workflow_signature: workflowSignature,
    query_text: "Continue runtime reference parity task if prior execution memory exists.",
    context_mode: "compact_agent",
    include_packets: true,
    limit: 8,
  });

  const activeObserve = await client.execution.observeStep<Record<string, unknown>>({
    agent_id: agentId,
    role: "worker",
    run_id: `run:${runId}:active`,
    task_signature: taskSignature,
    task_family: taskFamily,
    workflow_signature: workflowSignature,
    title: "Accepted current runtime route",
    summary: `Current route: continue ${activeTarget}; verifier passed and this is the active route for the next worker.`,
    outcome: "succeeded",
    target_files: [activeTarget],
    workflow_steps: ["inspect current route", "patch active file", "run verifier"],
    tool_set: ["read", "edit", "test"],
    acceptance_checks: ["verifier passed"],
    continuation_hint: `Continue ${activeTarget}.`,
    confidence: 0.96,
    evidence_ref: `evidence://substrate-reference/${runId}/active-route`,
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
    task_family: taskFamily,
    workflow_signature: "failed-legacy-route",
    title: "Rejected legacy route",
    summary: `Failed branch: ${failedTarget} failed verifier and must not be direct-use context.`,
    outcome: "failed",
    target_files: [failedTarget],
    workflow_steps: ["inspect legacy route", "patch legacy file", "verifier failed"],
    tool_set: ["read", "edit", "test"],
    acceptance_checks: ["verifier failed"],
    continuation_hint: `Do not continue ${failedTarget}; use ${activeTarget}.`,
    confidence: 0.31,
    raw_ref: `trace://substrate-reference/${runId}/failed/raw`,
    evidence_ref: `evidence://substrate-reference/${runId}/failed-route`,
    verification: {
      verifier_agent_id: "verifier",
      passed: false,
      reason: "Failed legacy route regressed the Runtime reference task.",
    },
    slots: {
      execution_result_summary: {
        status: "failed",
        summary: "Failed route is counter-evidence, not a reusable workflow.",
      },
    },
  });
  const failedMemoryId = firstNodeId(failedObserve, "failed route");

  const afterGuide = await client.execution.guideForRole<Record<string, unknown>>({
    agent_id: agentId,
    role: "worker",
    run_id: `run:${runId}:after`,
    task_signature: taskSignature,
    task_family: taskFamily,
    workflow_signature: workflowSignature,
    query_text: `Continue ${activeTarget} and avoid the failed legacy route.`,
    context: {
      task_signature: taskSignature,
      task_family: taskFamily,
      workflow_signature: workflowSignature,
      requested_targets: [activeTarget],
      blocked_targets: [failedTarget],
    },
    context_mode: "compact_agent",
    include_packets: true,
    limit: 12,
  });
  const agentContext = asRecord(afterGuide.agent_context);
  const useNowMemoryIds = stringArray(agentContext.use_now_memory_ids);
  const feedback = await client.execution.feedbackFromOutcome<Record<string, unknown>>({
    agent_id: agentId,
    role: "worker",
    run_id: `run:${runId}:feedback`,
    task_signature: taskSignature,
    task_family: taskFamily,
    workflow_signature: workflowSignature,
    title: "Reference parity worker used active route",
    summary: "Worker used the active route exposed by Aionis and avoided the failed branch.",
    outcome: "succeeded",
    guide: afterGuide,
    used_memory_ids: useNowMemoryIds.includes(activeMemoryId) ? [activeMemoryId] : useNowMemoryIds.slice(0, 1),
    feedback_outcome: "positive",
    used_surface: "use_now",
    verifier_status: "passed",
    tool_status: "succeeded",
    feedback_reason: "Active route was exposed and used successfully.",
  });

  const measure = await client.execution.measureRun<Record<string, unknown>>({
    run_id: runId,
    task_signature: taskSignature,
    task_family: taskFamily,
    workflow_signature: workflowSignature,
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

  const reference = {
    contract_version: "aionis_runtime_same_source_reference_v1",
    tenant_id: "default",
    scope,
    run_id: runId,
    source_runtime_write_sqlite_path: handle.writeDbPath,
    agent_context: afterGuide.agent_context,
    memory_decision_trace: measure.memory_decision_trace,
  };
  const referencePath = join(args.outputDir, "reference.json");
  await writeJson(referencePath, reference);

  const parityPath = join(args.outputDir, "parity-summary.json");
  const parity = await runRuntimeReferenceCorpus({
    sourceRootPaths: [handle.writeDbPath],
    referenceRootPaths: [referencePath],
    outputPath: parityPath,
    maxSourceFiles: null,
    maxScopes: null,
    maxScopesPerFile: 100,
    maxReferences: null,
    minNodes: 1,
    minOverlap: 1,
    maxPerBucket: args.maxPerBucket,
  });

  const runSummaryPath = join(args.outputDir, "run-summary.json");
  await writeJson(runSummaryPath, {
    contract_version: "aionis_substrate_runtime_product_reference_fixture_v1",
    run_id: runId,
    scope,
    runtime_root: args.runtimeRoot,
    runtime_base_url: handle.baseUrl,
    runtime_write_sqlite_path: handle.writeDbPath,
    runtime_replay_sqlite_path: handle.replayDbPath,
    reference_path: referencePath,
    parity_path: parityPath,
    memory_ids: {
      active: activeMemoryId,
      failed: failedMemoryId,
    },
    runtime_agent_context: {
      use_now_memory_ids: stringArray(agentContext.use_now_memory_ids),
      inspect_before_use_memory_ids: stringArray(agentContext.inspect_before_use_memory_ids),
      do_not_use_memory_ids: stringArray(agentContext.do_not_use_memory_ids),
      rehydrate_hints: agentContext.rehydrate_hints ?? [],
    },
    parity: {
      matched_references: parity.matched_references,
      passed_matches: parity.passed_matches,
      exact_matches: parity.exact_matches,
      partial_matches: parity.partial_matches,
      unmatched_references: parity.unmatched_references,
      first_match: parity.matched_reports[0] ?? null,
    },
  });

  return { referencePath, runSummaryPath, parityPath, parity };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const handle = await startRuntime(args);
  try {
    const result = await runProductLoop(args, handle);
    console.log(JSON.stringify({
      output_dir: args.outputDir,
      runtime_write_sqlite_path: handle.writeDbPath,
      reference_path: result.referencePath,
      run_summary_path: result.runSummaryPath,
      parity_path: result.parityPath,
      matched_references: result.parity.matched_references,
      passed_matches: result.parity.passed_matches,
      exact_matches: result.parity.exact_matches,
      partial_matches: result.parity.partial_matches,
      unmatched_references: result.parity.unmatched_references,
    }, null, 2));
  } finally {
    stopRuntime(handle);
  }
}

main().catch((err) => {
  console.error((err as Error).stack ?? String(err));
  console.error(usage());
  process.exit(1);
});
