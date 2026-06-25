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
  AionisAuthorityState,
  AionisLifecycleState,
  AionisMemoryKind,
  AionisMemoryNodeInput,
} from "../src/types.ts";

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
    governMemory: <T = unknown>(input: Record<string, unknown>) => Promise<T>;
  };
};

type ExternalCandidate = {
  external_memory_id: string;
  source_backend: string;
  text: string;
  metadata: {
    title: string;
    target_files: string[];
    memory_type: string;
    domain: string;
  };
  lifecycle_hint: "current" | "procedure" | "failed" | "contested" | "stale" | "suppressed" | "archived" | "unknown";
  authority: {
    source_trust: "trusted" | "known" | "unknown" | "untrusted";
    scope: "user" | "project" | "team" | "org" | "global" | "unknown";
    evidence_requirement: "none" | "inspect_before_use" | "rehydrate_before_use" | "blocked";
  };
  evidence_refs: string[];
};

type SubstrateProjection = Omit<AionisMemoryNodeInput, "scope" | "id"> & {
  id: string;
};

type Scenario = {
  id: string;
  query: string;
  candidates: ExternalCandidate[];
  substrateNodes: SubstrateProjection[];
};

type ScenarioReport = {
  scenario_id: string;
  scope: string;
  candidate_count: number;
  runtime_surfaces: RuntimeReferenceSurfaces;
  substrate_surfaces: RuntimeReferenceSurfaces;
  parity: {
    exact: boolean;
    bucket_reports: ReturnType<typeof compareSurfaces>;
  };
  runtime_summary: {
    use_now: number;
    inspect_before_use: number;
    do_not_use: number;
    rehydrate: number;
  };
};

type ExternalAdmissionParityReport = {
  contract_version: "aionis_external_admission_parity_report_v1";
  generated_at: string;
  runtime_root: string;
  runtime_base_url: string;
  runtime_write_db_path: string;
  runtime_replay_db_path: string;
  scenario_count: number;
  exact_scenario_count: number;
  failed_scenario_count: number;
  max_per_bucket: number | null;
  notes: string[];
  scenarios: ScenarioReport[];
};

const BUCKETS: AionisAdmissionAction[] = ["use_now", "inspect_before_use", "do_not_use", "rehydrate"];

function usage(): string {
  return [
    "Usage:",
    "  npm run check:external-admission-parity -- --runtime-root /path/AionisRuntime-focused",
    "",
    "Starts focused Runtime in local Lite mode, calls the real /v1/memory/govern product path,",
    "projects the same external candidates into Aionis Substrate, then compares the four admission buckets.",
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
    outputDir: args.outputDir ?? resolve("reports", `external-admission-parity-${new Date().toISOString().replace(/[:.]/g, "-")}`),
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
      LITE_LOCAL_ACTOR_ID: "substrate-external-admission-agent",
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

function candidate(input: {
  id: string;
  text: string;
  targetFiles: string[];
  lifecycle: ExternalCandidate["lifecycle_hint"];
  sourceTrust: ExternalCandidate["authority"]["source_trust"];
  evidenceRequirement: ExternalCandidate["authority"]["evidence_requirement"];
  memoryType: string;
  title: string;
}): ExternalCandidate {
  return {
    external_memory_id: input.id,
    source_backend: "aionis-substrate-parity",
    text: input.text,
    metadata: {
      title: input.title,
      target_files: input.targetFiles,
      memory_type: input.memoryType,
      domain: "external_admission_parity",
    },
    lifecycle_hint: input.lifecycle,
    authority: {
      source_trust: input.sourceTrust,
      scope: "project",
      evidence_requirement: input.evidenceRequirement,
    },
    evidence_refs: [`trace://${input.id}`],
  };
}

function projection(input: {
  id: string;
  kind: AionisMemoryKind;
  title: string;
  summary: string;
  targetFiles: string[];
  lifecycle: AionisLifecycleState;
  authority: AionisAuthorityState;
  confidence: number;
  payloadRef?: string | null;
  metadata?: Record<string, unknown>;
}): SubstrateProjection {
  return {
    id: input.id,
    kind: input.kind,
    title: input.title,
    summary: input.summary,
    lifecycle: input.lifecycle,
    authority: input.authority,
    confidence: input.confidence,
    targetFiles: input.targetFiles,
    payloadRef: input.payloadRef,
    metadata: input.metadata,
  };
}

function buildScenarios(): Scenario[] {
  return [
    {
      id: "four-bucket-governance",
      query: "Continue the active route, review uncertain helper memory before use, keep failed and stale branches out, and restore raw trace only on demand.",
      candidates: [
        candidate({
          id: "current-route",
          title: "Accepted route",
          text: "Current route: continue src/runtime/current-route.ts. Verifier passed and this is the active branch for the next turn.",
          targetFiles: ["src/runtime/current-route.ts"],
          lifecycle: "current",
          sourceTrust: "trusted",
          evidenceRequirement: "none",
          memoryType: "execution_state",
        }),
        candidate({
          id: "candidate-helper",
          title: "Candidate helper",
          text: "Helper idea for src/runtime/current-route.ts is relevant to the current route and should be inspected before use.",
          targetFiles: ["src/runtime/current-route.ts"],
          lifecycle: "unknown",
          sourceTrust: "known",
          evidenceRequirement: "inspect_before_use",
          memoryType: "procedure_candidate",
        }),
        candidate({
          id: "failed-branch",
          title: "Failed branch",
          text: "Failed branch: src/runtime/legacy-route.ts failed verification after retry and must not become direct-use context.",
          targetFiles: ["src/runtime/legacy-route.ts"],
          lifecycle: "failed",
          sourceTrust: "trusted",
          evidenceRequirement: "none",
          memoryType: "execution_state",
        }),
        candidate({
          id: "stale-branch",
          title: "Stale branch",
          text: "Stale branch: src/runtime/old-route.ts was superseded by the current route and should stay out of the prompt.",
          targetFiles: ["src/runtime/old-route.ts"],
          lifecycle: "stale",
          sourceTrust: "known",
          evidenceRequirement: "none",
          memoryType: "execution_state",
        }),
        candidate({
          id: "raw-trace",
          title: "Raw trace payload",
          text: "Raw terminal trace is available for src/runtime/current-route.ts, but only a pointer should be shown unless full evidence is requested.",
          targetFiles: ["src/runtime/current-route.ts"],
          lifecycle: "current",
          sourceTrust: "trusted",
          evidenceRequirement: "rehydrate_before_use",
          memoryType: "trace_pointer",
        }),
      ],
      substrateNodes: [
        projection({
          id: "current-route",
          kind: "execution",
          title: "Accepted route",
          summary: "Current route: continue src/runtime/current-route.ts. Verifier passed and this is the active branch for the next turn.",
          targetFiles: ["src/runtime/current-route.ts"],
          lifecycle: "active",
          authority: "trusted",
          confidence: 0.94,
        }),
        projection({
          id: "candidate-helper",
          kind: "procedure",
          title: "Candidate helper",
          summary: "Helper idea for src/runtime/current-route.ts is relevant to the current route and should be inspected before use.",
          targetFiles: ["src/runtime/current-route.ts"],
          lifecycle: "candidate",
          authority: "advisory",
          confidence: 0.55,
        }),
        projection({
          id: "failed-branch",
          kind: "execution",
          title: "Failed branch",
          summary: "Failed branch: src/runtime/legacy-route.ts failed verification after retry and must not become direct-use context.",
          targetFiles: ["src/runtime/legacy-route.ts"],
          lifecycle: "blocked",
          authority: "rejected",
          confidence: 0.2,
          metadata: { external_lifecycle_hint: "failed" },
        }),
        projection({
          id: "stale-branch",
          kind: "execution",
          title: "Stale branch",
          summary: "Stale branch: src/runtime/old-route.ts was superseded by the current route and should stay out of the prompt.",
          targetFiles: ["src/runtime/old-route.ts"],
          lifecycle: "suppressed",
          authority: "rejected",
          confidence: 0.2,
          metadata: { external_lifecycle_hint: "stale" },
        }),
        projection({
          id: "raw-trace",
          kind: "trace_pointer",
          title: "Raw trace payload",
          summary: "Raw terminal trace is available for src/runtime/current-route.ts, but only a pointer should be shown unless full evidence is requested.",
          targetFiles: ["src/runtime/current-route.ts"],
          lifecycle: "rehydrate_required",
          authority: "trusted",
          confidence: 0.86,
          payloadRef: "trace://raw-trace",
        }),
      ],
    },
    {
      id: "procedure-and-blocked-memory",
      query: "Resume the accepted migration workflow and keep blocked rollback notes out of direct use.",
      candidates: [
        candidate({
          id: "accepted-procedure",
          title: "Accepted migration procedure",
          text: "Procedure: for src/storage/schema.ts, migrate read model first, then run replay verifier. This path passed twice.",
          targetFiles: ["src/storage/schema.ts"],
          lifecycle: "procedure",
          sourceTrust: "trusted",
          evidenceRequirement: "none",
          memoryType: "procedure",
        }),
        candidate({
          id: "blocked-rollback",
          title: "Blocked rollback note",
          text: "Rollback note for src/storage/schema.ts was explicitly blocked after it corrupted replay state.",
          targetFiles: ["src/storage/schema.ts"],
          lifecycle: "suppressed",
          sourceTrust: "known",
          evidenceRequirement: "blocked",
          memoryType: "execution_state",
        }),
        candidate({
          id: "candidate-index",
          title: "Candidate index hint",
          text: "Indexing idea for src/storage/schema.ts is plausible but has no validation result yet.",
          targetFiles: ["src/storage/schema.ts"],
          lifecycle: "unknown",
          sourceTrust: "known",
          evidenceRequirement: "inspect_before_use",
          memoryType: "procedure_candidate",
        }),
        candidate({
          id: "schema-debug-trace",
          title: "Schema debug trace",
          text: "Full schema debug trace can be restored if the next turn needs raw verifier output.",
          targetFiles: ["src/storage/schema.ts"],
          lifecycle: "current",
          sourceTrust: "trusted",
          evidenceRequirement: "rehydrate_before_use",
          memoryType: "trace_pointer",
        }),
      ],
      substrateNodes: [
        projection({
          id: "accepted-procedure",
          kind: "procedure",
          title: "Accepted migration procedure",
          summary: "Procedure: for src/storage/schema.ts, migrate read model first, then run replay verifier. This path passed twice.",
          targetFiles: ["src/storage/schema.ts"],
          lifecycle: "active",
          authority: "verified",
          confidence: 0.95,
        }),
        projection({
          id: "blocked-rollback",
          kind: "execution",
          title: "Blocked rollback note",
          summary: "Rollback note for src/storage/schema.ts was explicitly blocked after it corrupted replay state.",
          targetFiles: ["src/storage/schema.ts"],
          lifecycle: "blocked",
          authority: "rejected",
          confidence: 0.1,
        }),
        projection({
          id: "candidate-index",
          kind: "procedure",
          title: "Candidate index hint",
          summary: "Indexing idea for src/storage/schema.ts is plausible but has no validation result yet.",
          targetFiles: ["src/storage/schema.ts"],
          lifecycle: "candidate",
          authority: "advisory",
          confidence: 0.6,
        }),
        projection({
          id: "schema-debug-trace",
          kind: "trace_pointer",
          title: "Schema debug trace",
          summary: "Full schema debug trace can be restored if the next turn needs raw verifier output.",
          targetFiles: ["src/storage/schema.ts"],
          lifecycle: "rehydrate_required",
          authority: "trusted",
          confidence: 0.84,
          payloadRef: "trace://schema-debug-trace",
        }),
      ],
    },
    {
      id: "general-memory-trust-boundary",
      query: "Use the trusted deployment preference, inspect the weaker note, block the contested preference, and keep raw preference evidence behind a payload hook.",
      candidates: [
        candidate({
          id: "trusted-preference",
          title: "Trusted deployment preference",
          text: "Project preference: deploy previews in the eu-west region unless a task says otherwise.",
          targetFiles: [],
          lifecycle: "current",
          sourceTrust: "trusted",
          evidenceRequirement: "none",
          memoryType: "preference",
        }),
        candidate({
          id: "weaker-note",
          title: "Weaker deployment note",
          text: "Deployment note: ap-south may be useful for one customer group and should be inspected before use.",
          targetFiles: [],
          lifecycle: "current",
          sourceTrust: "known",
          evidenceRequirement: "none",
          memoryType: "fact",
        }),
        candidate({
          id: "contested-preference",
          title: "Contested preference",
          text: "Contested preference: always deploy previews in us-east, conflicting with newer project preference.",
          targetFiles: [],
          lifecycle: "contested",
          sourceTrust: "trusted",
          evidenceRequirement: "none",
          memoryType: "preference",
        }),
        candidate({
          id: "preference-raw-note",
          title: "Preference raw note",
          text: "Raw preference discussion is available as evidence, but the prompt only needs a payload hook.",
          targetFiles: [],
          lifecycle: "current",
          sourceTrust: "trusted",
          evidenceRequirement: "rehydrate_before_use",
          memoryType: "evidence",
        }),
      ],
      substrateNodes: [
        projection({
          id: "trusted-preference",
          kind: "preference",
          title: "Trusted deployment preference",
          summary: "Project preference: deploy previews in the eu-west region unless a task says otherwise.",
          targetFiles: [],
          lifecycle: "active",
          authority: "trusted",
          confidence: 0.9,
        }),
        projection({
          id: "weaker-note",
          kind: "fact",
          title: "Weaker deployment note",
          summary: "Deployment note: ap-south may be useful for one customer group and should be inspected before use.",
          targetFiles: [],
          lifecycle: "candidate",
          authority: "advisory",
          confidence: 0.6,
        }),
        projection({
          id: "contested-preference",
          kind: "preference",
          title: "Contested preference",
          summary: "Contested preference: always deploy previews in us-east, conflicting with newer project preference.",
          targetFiles: [],
          lifecycle: "blocked",
          authority: "rejected",
          confidence: 0.2,
          metadata: { external_lifecycle_hint: "contested" },
        }),
        projection({
          id: "preference-raw-note",
          kind: "trace_pointer",
          title: "Preference raw note",
          summary: "Raw preference discussion is available as evidence, but the prompt only needs a payload hook.",
          targetFiles: [],
          lifecycle: "rehydrate_required",
          authority: "trusted",
          confidence: 0.85,
          payloadRef: "trace://preference-raw-note",
        }),
      ],
    },
    {
      id: "known-source-firewall-inspect",
      query: "Use only the trusted route directly and inspect the known-source route before adopting it.",
      candidates: [
        candidate({
          id: "trusted-route",
          title: "Trusted route",
          text: "Current route: continue src/api/active-route.ts. The route is accepted for the next turn.",
          targetFiles: ["src/api/active-route.ts"],
          lifecycle: "current",
          sourceTrust: "trusted",
          evidenceRequirement: "none",
          memoryType: "execution_memory",
        }),
        candidate({
          id: "known-route",
          title: "Known-source route",
          text: "Known-source route note for src/api/active-route.ts remains useful context from a known source.",
          targetFiles: ["src/api/active-route.ts"],
          lifecycle: "current",
          sourceTrust: "known",
          evidenceRequirement: "none",
          memoryType: "execution_memory",
        }),
        candidate({
          id: "known-route-payload",
          title: "Known route payload",
          text: "Detailed output for src/api/active-route.ts is available as a payload hook.",
          targetFiles: ["src/api/active-route.ts"],
          lifecycle: "current",
          sourceTrust: "trusted",
          evidenceRequirement: "rehydrate_before_use",
          memoryType: "evidence",
        }),
        candidate({
          id: "suppressed-route",
          title: "Suppressed route",
          text: "Suppressed route note for src/api/active-route.ts should not influence the next turn.",
          targetFiles: ["src/api/active-route.ts"],
          lifecycle: "suppressed",
          sourceTrust: "trusted",
          evidenceRequirement: "none",
          memoryType: "execution_memory",
        }),
      ],
      substrateNodes: [
        projection({
          id: "trusted-route",
          kind: "execution",
          title: "Trusted route",
          summary: "Current route: continue src/api/active-route.ts. The route is accepted for the next turn.",
          targetFiles: ["src/api/active-route.ts"],
          lifecycle: "active",
          authority: "trusted",
          confidence: 0.9,
        }),
        projection({
          id: "known-route",
          kind: "execution",
          title: "Known-source route",
          summary: "Known-source route note for src/api/active-route.ts remains useful context from a known source.",
          targetFiles: ["src/api/active-route.ts"],
          lifecycle: "candidate",
          authority: "advisory",
          confidence: 0.65,
        }),
        projection({
          id: "known-route-payload",
          kind: "trace_pointer",
          title: "Known route payload",
          summary: "Detailed output for src/api/active-route.ts is available as a payload hook.",
          targetFiles: ["src/api/active-route.ts"],
          lifecycle: "rehydrate_required",
          authority: "trusted",
          confidence: 0.82,
          payloadRef: "trace://known-route-payload",
        }),
        projection({
          id: "suppressed-route",
          kind: "execution",
          title: "Suppressed route",
          summary: "Suppressed route note for src/api/active-route.ts should not influence the next turn.",
          targetFiles: ["src/api/active-route.ts"],
          lifecycle: "suppressed",
          authority: "rejected",
          confidence: 0.1,
        }),
      ],
    },
    {
      id: "authority-requirement-priority",
      query: "Respect explicit admission requirements before trusting lifecycle hints.",
      candidates: [
        candidate({
          id: "requirement-use",
          title: "Requirement use",
          text: "Current state for src/gates/active.ts is available and trusted for the next turn.",
          targetFiles: ["src/gates/active.ts"],
          lifecycle: "current",
          sourceTrust: "trusted",
          evidenceRequirement: "none",
          memoryType: "execution_memory",
        }),
        candidate({
          id: "requirement-inspect",
          title: "Requirement inspect",
          text: "Current state note for src/gates/active.ts remains relevant and belongs in the review queue.",
          targetFiles: ["src/gates/active.ts"],
          lifecycle: "current",
          sourceTrust: "trusted",
          evidenceRequirement: "inspect_before_use",
          memoryType: "execution_memory",
        }),
        candidate({
          id: "requirement-blocked",
          title: "Requirement blocked",
          text: "Current state note for src/gates/active.ts is present but explicitly blocked by authority.",
          targetFiles: ["src/gates/active.ts"],
          lifecycle: "current",
          sourceTrust: "trusted",
          evidenceRequirement: "blocked",
          memoryType: "execution_memory",
        }),
        candidate({
          id: "requirement-rehydrate",
          title: "Requirement rehydrate",
          text: "Current state payload for src/gates/active.ts needs full payload recovery before use.",
          targetFiles: ["src/gates/active.ts"],
          lifecycle: "current",
          sourceTrust: "trusted",
          evidenceRequirement: "rehydrate_before_use",
          memoryType: "evidence",
        }),
      ],
      substrateNodes: [
        projection({
          id: "requirement-use",
          kind: "execution",
          title: "Requirement use",
          summary: "Current state for src/gates/active.ts is available and trusted for the next turn.",
          targetFiles: ["src/gates/active.ts"],
          lifecycle: "active",
          authority: "trusted",
          confidence: 0.9,
        }),
        projection({
          id: "requirement-inspect",
          kind: "execution",
          title: "Requirement inspect",
          summary: "Current state note for src/gates/active.ts remains relevant and belongs in the review queue.",
          targetFiles: ["src/gates/active.ts"],
          lifecycle: "candidate",
          authority: "advisory",
          confidence: 0.65,
        }),
        projection({
          id: "requirement-blocked",
          kind: "execution",
          title: "Requirement blocked",
          summary: "Current state note for src/gates/active.ts is present but explicitly blocked by authority.",
          targetFiles: ["src/gates/active.ts"],
          lifecycle: "blocked",
          authority: "rejected",
          confidence: 0.1,
        }),
        projection({
          id: "requirement-rehydrate",
          kind: "trace_pointer",
          title: "Requirement rehydrate",
          summary: "Current state payload for src/gates/active.ts needs full payload recovery before use.",
          targetFiles: ["src/gates/active.ts"],
          lifecycle: "rehydrate_required",
          authority: "trusted",
          confidence: 0.85,
          payloadRef: "trace://requirement-rehydrate",
        }),
      ],
    },
    {
      id: "stale-and-contested-firewall",
      query: "Keep the current route, block stale and contested alternatives, and inspect the neutral note.",
      candidates: [
        candidate({
          id: "current-worker-route",
          title: "Current worker route",
          text: "Current route: src/workers/current-worker.ts is the accepted worker path.",
          targetFiles: ["src/workers/current-worker.ts"],
          lifecycle: "current",
          sourceTrust: "trusted",
          evidenceRequirement: "none",
          memoryType: "execution_memory",
        }),
        candidate({
          id: "stale-worker-route",
          title: "Stale worker route",
          text: "Stale worker route: src/workers/old-worker.ts was replaced by the accepted worker path.",
          targetFiles: ["src/workers/old-worker.ts"],
          lifecycle: "stale",
          sourceTrust: "trusted",
          evidenceRequirement: "none",
          memoryType: "execution_memory",
        }),
        candidate({
          id: "contested-worker-route",
          title: "Contested worker route",
          text: "Contested worker route: src/workers/contested-worker.ts conflicts with the accepted worker path.",
          targetFiles: ["src/workers/contested-worker.ts"],
          lifecycle: "contested",
          sourceTrust: "trusted",
          evidenceRequirement: "none",
          memoryType: "execution_memory",
        }),
        candidate({
          id: "neutral-worker-note",
          title: "Neutral worker note",
          text: "Worker note for src/workers/current-worker.ts may help but should be inspected before use.",
          targetFiles: ["src/workers/current-worker.ts"],
          lifecycle: "unknown",
          sourceTrust: "known",
          evidenceRequirement: "inspect_before_use",
          memoryType: "procedure_candidate",
        }),
      ],
      substrateNodes: [
        projection({
          id: "current-worker-route",
          kind: "execution",
          title: "Current worker route",
          summary: "Current route: src/workers/current-worker.ts is the accepted worker path.",
          targetFiles: ["src/workers/current-worker.ts"],
          lifecycle: "active",
          authority: "trusted",
          confidence: 0.9,
        }),
        projection({
          id: "stale-worker-route",
          kind: "execution",
          title: "Stale worker route",
          summary: "Stale worker route: src/workers/old-worker.ts was replaced by the accepted worker path.",
          targetFiles: ["src/workers/old-worker.ts"],
          lifecycle: "suppressed",
          authority: "rejected",
          confidence: 0.2,
          metadata: { external_lifecycle_hint: "stale" },
        }),
        projection({
          id: "contested-worker-route",
          kind: "execution",
          title: "Contested worker route",
          summary: "Contested worker route: src/workers/contested-worker.ts conflicts with the accepted worker path.",
          targetFiles: ["src/workers/contested-worker.ts"],
          lifecycle: "blocked",
          authority: "rejected",
          confidence: 0.2,
          metadata: { external_lifecycle_hint: "contested" },
        }),
        projection({
          id: "neutral-worker-note",
          kind: "procedure",
          title: "Neutral worker note",
          summary: "Worker note for src/workers/current-worker.ts may help but should be inspected before use.",
          targetFiles: ["src/workers/current-worker.ts"],
          lifecycle: "candidate",
          authority: "advisory",
          confidence: 0.6,
        }),
      ],
    },
  ];
}

function contextSurfaces(context: {
  use_now: Array<{ id: string }>;
  inspect_before_use: Array<{ id: string }>;
  do_not_use: Array<{ id: string }>;
  rehydrate: Array<{ id: string }>;
}): RuntimeReferenceSurfaces {
  return {
    use_now: context.use_now.map((node) => node.id),
    inspect_before_use: context.inspect_before_use.map((node) => node.id),
    do_not_use: context.do_not_use.map((node) => node.id),
    rehydrate: context.rehydrate.map((node) => node.id),
  };
}

function summarizeSurfaces(surfaces: RuntimeReferenceSurfaces): ScenarioReport["runtime_summary"] {
  return {
    use_now: surfaces.use_now.length,
    inspect_before_use: surfaces.inspect_before_use.length,
    do_not_use: surfaces.do_not_use.length,
    rehydrate: surfaces.rehydrate.length,
  };
}

async function runScenario(input: {
  scenario: Scenario;
  client: ReturnType<AionisSdkModule["createAionisClient"]>;
  outputDir: string;
  maxPerBucket?: number;
}): Promise<ScenarioReport> {
  const scope = `external-admission-parity:${input.scenario.id}:${randomUUID()}`;
  const runtimeResult = await input.client.governMemory<Record<string, unknown>>({
    mode: "firewall",
    context_mode: "compact_agent",
    include_records: true,
    scope,
    query_text: input.scenario.query,
    candidates: input.scenario.candidates,
  });
  const runtimeSurfaces = extractRuntimeReferenceSurfaces(runtimeResult);
  const targetPath = join(input.outputDir, "substrate", `${input.scenario.id}.sqlite`);
  const store = await openSqliteAionisSubstrate({ path: targetPath });
  try {
    for (const node of input.scenario.substrateNodes) {
      await store.putNode({ ...node, scope });
    }
    const compiled = await store.compileContext({ scope, query: input.scenario.query, maxPerBucket: input.maxPerBucket });
    const substrateSurfaces = contextSurfaces(compiled);
    const bucketReports = compareSurfaces(substrateSurfaces, runtimeSurfaces);
    return {
      scenario_id: input.scenario.id,
      scope,
      candidate_count: input.scenario.candidates.length,
      runtime_surfaces: runtimeSurfaces,
      substrate_surfaces: substrateSurfaces,
      parity: {
        exact: bucketReports.every((bucket) => bucket.exact),
        bucket_reports: bucketReports,
      },
      runtime_summary: summarizeSurfaces(runtimeSurfaces),
    };
  } finally {
    await store.close();
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.outputDir, { recursive: true });
  const runtime = await startRuntime(args);
  try {
    const sdk = await loadSdk(args.runtimeRoot);
    const client = sdk.createAionisClient({ baseUrl: runtime.baseUrl });
    await client.health();
    const scenarios = [];
    for (const scenario of buildScenarios()) {
      scenarios.push(await runScenario({
        scenario,
        client,
        outputDir: args.outputDir,
        maxPerBucket: args.maxPerBucket,
      }));
    }
    const exactScenarioCount = scenarios.filter((scenario) => scenario.parity.exact).length;
    const report: ExternalAdmissionParityReport = {
      contract_version: "aionis_external_admission_parity_report_v1",
      generated_at: new Date().toISOString(),
      runtime_root: args.runtimeRoot,
      runtime_base_url: runtime.baseUrl,
      runtime_write_db_path: runtime.writeDbPath,
      runtime_replay_db_path: runtime.replayDbPath,
      scenario_count: scenarios.length,
      exact_scenario_count: exactScenarioCount,
      failed_scenario_count: scenarios.length - exactScenarioCount,
      max_per_bucket: args.maxPerBucket ?? null,
      notes: [
        "This runner calls the real focused Runtime external memory governance path.",
        "It validates Substrate's minimum four-bucket admission contract against external candidate admission, not full Aionis Runtime guide policy.",
        "It does not mutate AionisRuntime-focused source code or Runtime product databases.",
      ],
      scenarios,
    };
    const reportPath = join(args.outputDir, "summary.json");
    await writeJson(reportPath, report);
    console.log(JSON.stringify({
      report: reportPath,
      scenario_count: report.scenario_count,
      exact_scenario_count: report.exact_scenario_count,
      failed_scenario_count: report.failed_scenario_count,
      buckets: BUCKETS,
    }, null, 2));
    if (report.failed_scenario_count > 0) process.exitCode = 1;
  } finally {
    stopRuntime(runtime);
  }
}

main().catch((error: unknown) => {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : null;
  if (record && "response" in record) {
    console.error(JSON.stringify(record.response, null, 2));
  }
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
