import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
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
  generatedCount: number;
  chainProbeCount: number;
  concurrency: number;
  seed: string;
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
  scenario_source: "fixed" | "generated";
  latency_ms: number;
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
  write_integrity: {
    invalid_relation_rejected: boolean;
    invalid_feedback_rejected: boolean;
    event_count_unchanged: boolean;
  };
  feedback_recorded: boolean;
  measure_recorded: boolean;
};

type ReopenReport = {
  scenario_id: string;
  scope: string;
  latency_ms: number;
  persisted_surfaces: RuntimeReferenceSurfaces;
  parity: {
    exact: boolean;
    bucket_reports: ReturnType<typeof compareSurfaces>;
  };
};

type ChainProbeReport = {
  probe_id: string;
  scope: string;
  latency_ms: number;
  expected_surfaces: RuntimeReferenceSurfaces;
  substrate_surfaces: RuntimeReferenceSurfaces;
  parity: {
    exact: boolean;
    bucket_reports: ReturnType<typeof compareSurfaces>;
  };
  event_counts: Record<AionisEvent["type"], number>;
  relation_count: number;
  transition_verified: boolean;
};

type ChainProbeReopenReport = {
  probe_id: string;
  scope: string;
  latency_ms: number;
  persisted_surfaces: RuntimeReferenceSurfaces;
  parity: {
    exact: boolean;
    bucket_reports: ReturnType<typeof compareSurfaces>;
  };
};

type LatencySummary = {
  count: number;
  min_ms: number;
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
  avg_ms: number;
};

type EventSequenceReport = {
  event_count: number;
  first_sequence: number | null;
  last_sequence: number | null;
  contiguous: boolean;
  duplicate_count: number;
  gap_count: number;
};

type DbSizeReport = {
  substrate_sqlite_bytes: number;
  substrate_wal_bytes: number;
  substrate_shm_bytes: number;
  runtime_write_sqlite_bytes: number;
  runtime_replay_sqlite_bytes: number;
};

type RuntimeDualWriteExperimentReport = {
  contract_version: "aionis_runtime_dual_write_experiment_report_v4";
  generated_at: string;
  runtime_root: string;
  runtime_base_url: string;
  runtime_write_db_path: string;
  runtime_replay_db_path: string;
  substrate_db_path: string;
  scenario_count: number;
  fixed_scenario_count: number;
  generated_scenario_count: number;
  chain_probe_count: number;
  exact_scenario_count: number;
  persisted_exact_scenario_count: number;
  write_integrity_pass_count: number;
  chain_probe_pass_count: number;
  persisted_chain_probe_pass_count: number;
  failed_scenario_count: number;
  failed_chain_probe_count: number;
  max_per_bucket: number | null;
  concurrency: number;
  seed: string;
  soak: {
    total_elapsed_ms: number;
    scenario_latency: LatencySummary;
    chain_probe_latency: LatencySummary;
    reopen_latency: LatencySummary;
    chain_probe_reopen_latency: LatencySummary;
    event_sequence: EventSequenceReport;
    db_sizes: DbSizeReport;
  };
  notes: string[];
  scenarios: ScenarioReport[];
  reopen: ReopenReport[];
  chain_probes: ChainProbeReport[];
  chain_probe_reopen: ChainProbeReopenReport[];
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

const GENERATED_DOMAINS = [
  {
    id: "auth-session",
    taskFamily: "dual_write_auth_session",
    workflowSignature: "accepted-auth-session-route",
    activeTarget: "src/auth/session-state.ts",
    failedTarget: "src/auth/legacy-cookie-state.ts",
    activeNoun: "session state route",
    failedNoun: "legacy cookie route",
    verifier: "auth session verifier passed",
  },
  {
    id: "billing-ledger",
    taskFamily: "dual_write_billing_ledger",
    workflowSignature: "accepted-billing-ledger-route",
    activeTarget: "src/billing/ledger-writer.ts",
    failedTarget: "src/billing/legacy-invoice-writer.ts",
    activeNoun: "ledger writer route",
    failedNoun: "legacy invoice writer",
    verifier: "billing replay verifier passed",
  },
  {
    id: "search-index",
    taskFamily: "dual_write_search_index",
    workflowSignature: "accepted-search-index-route",
    activeTarget: "src/search/index-maintainer.ts",
    failedTarget: "src/search/old-tokenizer-sync.ts",
    activeNoun: "index maintainer route",
    failedNoun: "old tokenizer sync",
    verifier: "search index verifier passed",
  },
  {
    id: "ci-runner",
    taskFamily: "dual_write_ci_runner",
    workflowSignature: "accepted-ci-runner-route",
    activeTarget: "src/ci/runner-state.ts",
    failedTarget: "src/ci/retry-shortcut.ts",
    activeNoun: "runner state route",
    failedNoun: "retry shortcut",
    verifier: "CI verifier passed",
  },
  {
    id: "docs-builder",
    taskFamily: "dual_write_docs_builder",
    workflowSignature: "accepted-docs-builder-route",
    activeTarget: "src/docs/site-builder.ts",
    failedTarget: "src/docs/stale-nav-generator.ts",
    activeNoun: "site builder route",
    failedNoun: "stale nav generator",
    verifier: "docs build verifier passed",
  },
] as const;

function usage(): string {
  return [
    "Usage:",
    "  npm run check:runtime-dual-write -- --runtime-root /path/AionisRuntime-focused [--generated-count 8] [--concurrency 4]",
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
    } else if (flag === "--generated-count") {
      if (!value) throw new Error("--generated-count requires a value");
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) throw new Error("--generated-count must be a non-negative integer");
      args.generatedCount = parsed;
      i += 1;
    } else if (flag === "--chain-probe-count") {
      if (!value) throw new Error("--chain-probe-count requires a value");
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) throw new Error("--chain-probe-count must be a non-negative integer");
      args.chainProbeCount = parsed;
      i += 1;
    } else if (flag === "--concurrency") {
      if (!value) throw new Error("--concurrency requires a value");
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) throw new Error("--concurrency must be a positive integer");
      args.concurrency = parsed;
      i += 1;
    } else if (flag === "--seed") {
      if (!value) throw new Error("--seed requires a value");
      args.seed = value;
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
    generatedCount: args.generatedCount ?? 0,
    chainProbeCount: args.chainProbeCount ?? 0,
    concurrency: args.concurrency ?? 1,
    seed: args.seed ?? "runtime-dual-write-v2",
    maxPerBucket: args.maxPerBucket,
  };
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function makePrng(seed: string): () => number {
  let state = hashString(seed) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function generatedScenarios(count: number, seed: string): DualWriteScenario[] {
  const rand = makePrng(seed);
  const scenarios: DualWriteScenario[] = [];
  for (let index = 0; index < count; index += 1) {
    const domain = GENERATED_DOMAINS[Math.floor(rand() * GENERATED_DOMAINS.length) % GENERATED_DOMAINS.length];
    const variant = Math.floor(rand() * 10_000).toString(36).padStart(3, "0");
    const activeTarget = domain.activeTarget.replace(".ts", `-${variant}.ts`);
    const failedTarget = domain.failedTarget.replace(".ts", `-${variant}.ts`);
    scenarios.push({
      id: `generated-${domain.id}-${index + 1}-${variant}`,
      taskFamily: domain.taskFamily,
      workflowSignature: `${domain.workflowSignature}-${variant}`,
      activeTarget,
      failedTarget,
      activeTitle: `Accepted ${domain.activeNoun}`,
      failedTitle: `Rejected ${domain.failedNoun}`,
      activeSummary: `Current route: continue {activeTarget}; ${domain.verifier} and this is the accepted route for the next worker.`,
      failedSummary: `Failed branch: {failedTarget} failed replay validation and must not become direct-use context.`,
      queryText: `Continue {activeTarget}; keep {failedTarget} blocked unless raw evidence is explicitly requested.`,
      acceptanceCheck: domain.verifier,
    });
  }
  return scenarios;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function latencySummary(values: number[]): LatencySummary {
  if (values.length === 0) {
    return { count: 0, min_ms: 0, p50_ms: 0, p95_ms: 0, max_ms: 0, avg_ms: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  const percentile = (p: number): number => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return roundMs(sorted[index] ?? 0);
  };
  return {
    count: sorted.length,
    min_ms: roundMs(sorted[0] ?? 0),
    p50_ms: percentile(50),
    p95_ms: percentile(95),
    max_ms: roundMs(sorted[sorted.length - 1] ?? 0),
    avg_ms: roundMs(sum / sorted.length),
  };
}

function eventSequenceReport(events: AionisEvent[]): EventSequenceReport {
  if (events.length === 0) {
    return {
      event_count: 0,
      first_sequence: null,
      last_sequence: null,
      contiguous: true,
      duplicate_count: 0,
      gap_count: 0,
    };
  }
  const sequences = events.map((event) => event.sequence).sort((a, b) => a - b);
  const seen = new Set<number>();
  let duplicateCount = 0;
  let gapCount = 0;
  for (const sequence of sequences) {
    if (seen.has(sequence)) duplicateCount += 1;
    seen.add(sequence);
  }
  for (let i = 1; i < sequences.length; i += 1) {
    const previous = sequences[i - 1] ?? 0;
    const current = sequences[i] ?? 0;
    if (current > previous + 1) gapCount += current - previous - 1;
  }
  const first = sequences[0] ?? null;
  const last = sequences[sequences.length - 1] ?? null;
  return {
    event_count: events.length,
    first_sequence: first,
    last_sequence: last,
    contiguous: duplicateCount === 0 && gapCount === 0 && first === 1 && last === events.length,
    duplicate_count: duplicateCount,
    gap_count: gapCount,
  };
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") return 0;
    throw err;
  }
}

async function dbSizeReport(args: {
  substratePath: string;
  runtimeWritePath: string;
  runtimeReplayPath: string;
}): Promise<DbSizeReport> {
  const [substrate, substrateWal, substrateShm, runtimeWrite, runtimeReplay] = await Promise.all([
    fileSize(args.substratePath),
    fileSize(`${args.substratePath}-wal`),
    fileSize(`${args.substratePath}-shm`),
    fileSize(args.runtimeWritePath),
    fileSize(args.runtimeReplayPath),
  ]);
  return {
    substrate_sqlite_bytes: substrate,
    substrate_wal_bytes: substrateWal,
    substrate_shm_bytes: substrateShm,
    runtime_write_sqlite_bytes: runtimeWrite,
    runtime_replay_sqlite_bytes: runtimeReplay,
  };
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

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }));
  return results;
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
    "substrate.checkpoint.created": 0,
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

async function runWriteIntegrityProbe(input: {
  store: AionisSubstrate;
  scope: string;
  activeMemoryId: string;
  failedMemoryId: string;
  runId: string;
}): Promise<ScenarioReport["write_integrity"]> {
  const beforeEvents = (await input.store.listEvents()).filter((event) => eventScope(event) === input.scope).length;
  let invalidRelationRejected = false;
  let invalidFeedbackRejected = false;
  try {
    await input.store.putRelation({
      scope: input.scope,
      kind: "invalidates",
      sourceId: input.activeMemoryId,
      targetId: `${input.failedMemoryId}:missing`,
      confidence: 0.99,
      reasons: ["probe invalid relation rollback"],
    });
  } catch {
    invalidRelationRejected = true;
  }
  try {
    await input.store.recordFeedback({
      scope: input.scope,
      memoryId: `${input.activeMemoryId}:missing`,
      outcome: "negative",
      strength: "strong",
      runId: input.runId,
      evidenceRef: `feedback://dual-write/${input.runId}/invalid-feedback-probe`,
    });
  } catch {
    invalidFeedbackRejected = true;
  }
  const afterEvents = (await input.store.listEvents()).filter((event) => eventScope(event) === input.scope).length;
  return {
    invalid_relation_rejected: invalidRelationRejected,
    invalid_feedback_rejected: invalidFeedbackRejected,
    event_count_unchanged: beforeEvents === afterEvents,
  };
}

async function runScenario(input: {
  args: Args;
  sdk: AionisSdkModule;
  handle: RuntimeHandle;
  store: AionisSubstrate;
  scenario: DualWriteScenario;
  scenarioSource: ScenarioReport["scenario_source"];
}): Promise<ScenarioReport> {
  const startedAt = Date.now();
  const { args, sdk, handle, store, scenario, scenarioSource } = input;
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
  const writeIntegrity = await runWriteIntegrityProbe({
    store,
    scope,
    activeMemoryId,
    failedMemoryId,
    runId,
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
    scenario_source: scenarioSource,
    latency_ms: Date.now() - startedAt,
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
    write_integrity: writeIntegrity,
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
      const startedAt = Date.now();
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
        latency_ms: Date.now() - startedAt,
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

async function runChainProbe(input: {
  store: AionisSubstrate;
  probeId: string;
  maxPerBucket?: number;
}): Promise<ChainProbeReport> {
  const startedAt = Date.now();
  const scope = `substrate-chain-probe:${input.probeId}:${randomUUID().slice(0, 8)}`;
  const currentId = `${input.probeId}:current`;
  const priorId = `${input.probeId}:prior`;
  const failedId = `${input.probeId}:failed`;
  const inspectId = `${input.probeId}:inspect`;
  const rawId = `${input.probeId}:raw-payload`;

  await input.store.putNode({
    id: currentId,
    scope,
    kind: "execution",
    title: "Accepted active chain route",
    summary: "Current accepted route with verified outcome evidence.",
    lifecycle: "active",
    authority: "verified",
    confidence: 0.97,
    targetFiles: ["src/chain/current.ts"],
  });
  await input.store.putNode({
    id: priorId,
    scope,
    kind: "execution",
    title: "Prior route now superseded",
    summary: "Older route that is related to the same target but superseded by current evidence.",
    lifecycle: "active",
    authority: "trusted",
    confidence: 0.82,
    targetFiles: ["src/chain/current.ts"],
  });
  await input.store.putNode({
    id: failedId,
    scope,
    kind: "execution",
    title: "Failed route pending lifecycle transition",
    summary: "A route that was initially recorded and then blocked after outcome attribution.",
    lifecycle: "candidate",
    authority: "advisory",
    confidence: 0.45,
    targetFiles: ["src/chain/failed.ts"],
  });
  await input.store.putNode({
    id: inspectId,
    scope,
    kind: "procedure",
    title: "Procedure candidate still needs inspection",
    summary: "Potential reusable procedure without enough authority for direct use.",
    lifecycle: "candidate",
    authority: "advisory",
    confidence: 0.58,
    targetFiles: ["src/chain/current.ts"],
  });
  await input.store.putNode({
    id: rawId,
    scope,
    kind: "trace_pointer",
    title: "Raw payload pointer",
    summary: "Raw terminal payload should stay out of direct prompt context unless recovered.",
    lifecycle: "candidate",
    authority: "advisory",
    confidence: 0.5,
    targetFiles: ["src/chain/raw.log"],
    payloadRef: `trace://chain-probe/${input.probeId}/raw`,
  });

  await input.store.putRelation({
    scope,
    kind: "supersedes",
    sourceId: currentId,
    targetId: priorId,
    confidence: 0.91,
    reasons: ["current verified route supersedes prior route"],
  });
  await input.store.putRelation({
    scope,
    kind: "invalidates",
    sourceId: currentId,
    targetId: failedId,
    confidence: 0.88,
    reasons: ["current route invalidates the failed branch"],
  });
  await input.store.putRelation({
    scope,
    kind: "supports",
    sourceId: currentId,
    targetId: inspectId,
    confidence: 0.74,
    reasons: ["current route supports reviewing the procedure candidate"],
  });
  await input.store.putRelation({
    scope,
    kind: "requires_payload",
    sourceId: currentId,
    targetId: rawId,
    confidence: 0.83,
    reasons: ["raw terminal evidence must be rehydrated before direct use"],
  });

  const transitioned = await input.store.transitionLifecycle({
    scope,
    memoryId: failedId,
    lifecycle: "blocked",
    authority: "rejected",
    confidence: 0.22,
    reason: "failed branch received negative outcome evidence",
  });

  const compiled = await input.store.compileContext({
    scope,
    query: "continue the verified current chain route",
    maxPerBucket: input.maxPerBucket,
  });
  const substrateSurfaces = contextSurfaces(compiled);
  const expectedSurfaces: RuntimeReferenceSurfaces = {
    use_now: [currentId],
    inspect_before_use: [inspectId],
    do_not_use: [failedId, priorId],
    rehydrate: [rawId],
  };
  const bucketReports = compareSurfaces(substrateSurfaces, expectedSurfaces);
  const events = await input.store.listEvents();
  const relations = await input.store.listRelations(scope);
  return {
    probe_id: input.probeId,
    scope,
    latency_ms: Date.now() - startedAt,
    expected_surfaces: expectedSurfaces,
    substrate_surfaces: substrateSurfaces,
    parity: {
      exact: bucketReports.every((bucket) => bucket.exact),
      bucket_reports: bucketReports,
    },
    event_counts: eventCountsForScope(events, scope),
    relation_count: relations.length,
    transition_verified: transitioned.lifecycle === "blocked"
      && transitioned.authority === "rejected"
      && transitioned.confidence === 0.22,
  };
}

async function runReopenChainProbeCheck(input: {
  substratePath: string;
  chainProbes: ChainProbeReport[];
  maxPerBucket?: number;
}): Promise<ChainProbeReopenReport[]> {
  const store = await openSqliteAionisSubstrate({ path: input.substratePath });
  try {
    const reports: ChainProbeReopenReport[] = [];
    for (const probe of input.chainProbes) {
      const startedAt = Date.now();
      const compiled = await store.compileContext({
        scope: probe.scope,
        query: `reopen chain probe ${probe.probe_id}`,
        maxPerBucket: input.maxPerBucket,
      });
      const persistedSurfaces = contextSurfaces(compiled);
      const bucketReports = compareSurfaces(persistedSurfaces, probe.expected_surfaces);
      reports.push({
        probe_id: probe.probe_id,
        scope: probe.scope,
        latency_ms: Date.now() - startedAt,
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
  const experimentStartedAt = Date.now();
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.outputDir, { recursive: true });
  const handle = await startRuntime(args);
  const substratePath = join(args.outputDir, "substrate-dual-write.sqlite");
  const store = await openSqliteAionisSubstrate({ path: substratePath });
  try {
    const sdk = await loadSdk(args.runtimeRoot);
    const scenarioReports: ScenarioReport[] = [];
    const fixedScenarios = SCENARIOS.slice(0, args.scenarioCount).map((scenario) => ({
      scenario,
      scenarioSource: "fixed" as const,
    }));
    const generated = generatedScenarios(args.generatedCount, args.seed).map((scenario) => ({
      scenario,
      scenarioSource: "generated" as const,
    }));
    scenarioReports.push(...await mapWithConcurrency(
      [...fixedScenarios, ...generated],
      args.concurrency,
      async ({ scenario, scenarioSource }) => await runScenario({
        args,
        sdk,
        handle,
        store,
        scenario,
        scenarioSource,
      }),
    ));
    const chainProbeIds = Array.from({ length: args.chainProbeCount }, (_, index) => `chain-${index + 1}`);
    const chainProbeReports = await mapWithConcurrency(
      chainProbeIds,
      args.concurrency,
      async (probeId) => await runChainProbe({
        store,
        probeId,
        maxPerBucket: args.maxPerBucket,
      }),
    );
    const finalEvents = await store.listEvents();
    await store.close();
    const reopenReports = await runReopenCheck({
      substratePath,
      scenarios: scenarioReports,
      maxPerBucket: args.maxPerBucket,
    });
    const chainProbeReopenReports = await runReopenChainProbeCheck({
      substratePath,
      chainProbes: chainProbeReports,
      maxPerBucket: args.maxPerBucket,
    });
    const dbSizes = await dbSizeReport({
      substratePath,
      runtimeWritePath: handle.writeDbPath,
      runtimeReplayPath: handle.replayDbPath,
    });

    const exactScenarioCount = scenarioReports.filter((scenario) => scenario.parity.exact).length;
    const persistedExactScenarioCount = reopenReports.filter((scenario) => scenario.parity.exact).length;
    const writeIntegrityPassCount = scenarioReports.filter((scenario) => (
      scenario.write_integrity.invalid_relation_rejected
      && scenario.write_integrity.invalid_feedback_rejected
      && scenario.write_integrity.event_count_unchanged
    )).length;
    const chainProbePassCount = chainProbeReports.filter((probe) => probe.parity.exact && probe.transition_verified).length;
    const persistedChainProbePassCount = chainProbeReopenReports.filter((probe) => probe.parity.exact).length;
    const reopenByScenario = new Map(reopenReports.map((scenario) => [scenario.scenario_id, scenario]));
    const failedScenarioCount = scenarioReports.filter((scenario) => {
      const reopen = reopenByScenario.get(scenario.scenario_id);
      const writeIntegrityPassed = scenario.write_integrity.invalid_relation_rejected
        && scenario.write_integrity.invalid_feedback_rejected
        && scenario.write_integrity.event_count_unchanged;
      return !scenario.parity.exact || !reopen?.parity.exact || !writeIntegrityPassed;
    }).length;
    const reopenByChainProbe = new Map(chainProbeReopenReports.map((probe) => [probe.probe_id, probe]));
    const failedChainProbeCount = chainProbeReports.filter((probe) => {
      const reopen = reopenByChainProbe.get(probe.probe_id);
      return !probe.parity.exact || !probe.transition_verified || !reopen?.parity.exact;
    }).length;
    const report: RuntimeDualWriteExperimentReport = {
      contract_version: "aionis_runtime_dual_write_experiment_report_v4",
      generated_at: new Date().toISOString(),
      runtime_root: args.runtimeRoot,
      runtime_base_url: handle.baseUrl,
      runtime_write_db_path: handle.writeDbPath,
      runtime_replay_db_path: handle.replayDbPath,
      substrate_db_path: substratePath,
      scenario_count: scenarioReports.length,
      fixed_scenario_count: fixedScenarios.length,
      generated_scenario_count: generated.length,
      chain_probe_count: chainProbeReports.length,
      exact_scenario_count: exactScenarioCount,
      persisted_exact_scenario_count: persistedExactScenarioCount,
      write_integrity_pass_count: writeIntegrityPassCount,
      chain_probe_pass_count: chainProbePassCount,
      persisted_chain_probe_pass_count: persistedChainProbePassCount,
      failed_scenario_count: failedScenarioCount,
      failed_chain_probe_count: failedChainProbeCount,
      max_per_bucket: args.maxPerBucket ?? null,
      concurrency: args.concurrency,
      seed: args.seed,
      soak: {
        total_elapsed_ms: Date.now() - experimentStartedAt,
        scenario_latency: latencySummary(scenarioReports.map((scenario) => scenario.latency_ms)),
        chain_probe_latency: latencySummary(chainProbeReports.map((probe) => probe.latency_ms)),
        reopen_latency: latencySummary(reopenReports.map((scenario) => scenario.latency_ms)),
        chain_probe_reopen_latency: latencySummary(chainProbeReopenReports.map((probe) => probe.latency_ms)),
        event_sequence: eventSequenceReport(finalEvents),
        db_sizes: dbSizes,
      },
      notes: [
        "This experiment runs real focused Runtime observe/guide/feedback/measure calls.",
        "Substrate is written as an external sidecar using the same observed memory ids and outcomes.",
        "Generated scenarios are deterministic from the recorded seed and do not mutate Runtime policy.",
        "Write integrity probes verify invalid sidecar relation/feedback writes do not append partial events.",
        "Chain probes validate Substrate lifecycle transitions and relation chains in independent scopes.",
        "This is not Runtime storage replacement and does not mutate AionisRuntime-focused source code.",
      ],
      scenarios: scenarioReports,
      reopen: reopenReports,
      chain_probes: chainProbeReports,
      chain_probe_reopen: chainProbeReopenReports,
    };
    const reportPath = join(args.outputDir, "summary.json");
    await writeJson(reportPath, report);
    console.log(JSON.stringify({
      report: reportPath,
      runtime_write_sqlite_path: handle.writeDbPath,
      substrate_db_path: substratePath,
      scenario_count: report.scenario_count,
      fixed_scenario_count: report.fixed_scenario_count,
      generated_scenario_count: report.generated_scenario_count,
      chain_probe_count: report.chain_probe_count,
      exact_scenario_count: report.exact_scenario_count,
      persisted_exact_scenario_count: report.persisted_exact_scenario_count,
      write_integrity_pass_count: report.write_integrity_pass_count,
      chain_probe_pass_count: report.chain_probe_pass_count,
      persisted_chain_probe_pass_count: report.persisted_chain_probe_pass_count,
      failed_scenario_count: report.failed_scenario_count,
      failed_chain_probe_count: report.failed_chain_probe_count,
      event_sequence_contiguous: report.soak.event_sequence.contiguous,
      substrate_sqlite_bytes: report.soak.db_sizes.substrate_sqlite_bytes,
      scenario_p95_ms: report.soak.scenario_latency.p95_ms,
      total_elapsed_ms: report.soak.total_elapsed_ms,
    }, null, 2));
    if (report.failed_scenario_count > 0 || report.failed_chain_probe_count > 0) process.exitCode = 1;
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
