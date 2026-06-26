import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compareSurfaces,
  openSqliteAionisSubstrate,
  runRuntimeLiveSidecarOnce,
  type AionisCompiledContext,
  type RuntimeReferenceSurfaces,
} from "../src/index.ts";

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

type RuntimeDualWriteSummary = {
  runtime_write_db_path: string;
  scenario_count: number;
  exact_scenario_count: number;
  persisted_exact_scenario_count: number;
  write_integrity_pass_count: number;
  chain_probe_count: number;
  chain_probe_pass_count: number;
  persisted_chain_probe_pass_count: number;
  failed_scenario_count: number;
  failed_chain_probe_count: number;
  scenarios: Array<{
    scenario_id: string;
    scope: string;
    runtime_surfaces: RuntimeReferenceSurfaces;
  }>;
  soak: {
    event_sequence: {
      contiguous: boolean;
    };
  };
};

type ProductBridgeParityScenario = {
  scenario_id: string;
  scope: string;
  exact: boolean;
  substrate_surfaces: RuntimeReferenceSurfaces;
  runtime_surfaces: RuntimeReferenceSurfaces;
  bucket_reports: ReturnType<typeof compareSurfaces>;
};

type ProductBridgeGateReport = {
  contract_version: "aionis_runtime_product_bridge_gate_report_v1";
  generated_at: string;
  runtime_root: string;
  output_dir: string;
  dual_write_summary_path: string;
  live_sidecar_first_path: string;
  live_sidecar_second_path: string;
  live_sidecar_parity_path: string;
  passed: boolean;
  failures: string[];
  summary: {
    scenario_count: number;
    exact_scenario_count: number;
    persisted_exact_scenario_count: number;
    write_integrity_pass_count: number;
    chain_probe_count: number;
    chain_probe_pass_count: number;
    persisted_chain_probe_pass_count: number;
    live_sidecar_imported_nodes: number;
    live_sidecar_skipped_nodes: number;
    live_sidecar_second_applied_nodes: number;
    live_sidecar_second_unchanged_nodes: number;
    live_sidecar_exact_scenario_count: number;
  };
};

function usage(): string {
  return [
    "Usage:",
    "  npm run check:runtime-product-bridge -- --runtime-root /path/AionisRuntime-focused",
    "",
    "Runs the real focused Runtime product bridge gate:",
    "  1. focused Runtime observe -> guide -> feedback -> measure",
    "  2. external Substrate dual-write parity",
    "  3. Substrate reopen parity",
    "  4. chain-probe relation/lifecycle parity",
    "  5. read-only live-sidecar mirror from Runtime Lite SQLite",
    "  6. repeated live-sidecar idempotency",
    "  7. live-sidecar previewContext parity against Runtime guide surfaces",
    "",
    "Options:",
    "  --runtime-root <path>       Required focused Runtime checkout.",
    "  --output-dir <path>         Defaults to reports/runtime-product-bridge-gate-<timestamp>.",
    "  --scenario-count <n>        Fixed scenario count. Defaults to 4.",
    "  --generated-count <n>       Deterministic generated scenario count. Defaults to 96.",
    "  --chain-probe-count <n>     Independent chain probe count. Defaults to 16.",
    "  --concurrency <n>           Runtime scenario concurrency. Defaults to 8.",
    "  --seed <text>               Generated scenario seed. Defaults to runtime-product-bridge-gate-v1.",
    "  --max-per-bucket <n>        Optional context bucket cap.",
  ].join("\n");
}

function parseNonNegativeInteger(raw: string | undefined, label: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function parsePositiveInteger(raw: string | undefined, label: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {
    outputDir: resolve("reports", `runtime-product-bridge-gate-${new Date().toISOString().replace(/[:.]/g, "-")}`),
    scenarioCount: 4,
    generatedCount: 96,
    chainProbeCount: 16,
    concurrency: 8,
    seed: "runtime-product-bridge-gate-v1",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--runtime-root") {
      if (!value?.trim()) throw new Error("--runtime-root requires a value");
      args.runtimeRoot = resolve(value);
      index += 1;
    } else if (flag === "--output-dir") {
      if (!value?.trim()) throw new Error("--output-dir requires a value");
      args.outputDir = resolve(value);
      index += 1;
    } else if (flag === "--scenario-count") {
      args.scenarioCount = parsePositiveInteger(value, "--scenario-count");
      index += 1;
    } else if (flag === "--generated-count") {
      args.generatedCount = parseNonNegativeInteger(value, "--generated-count");
      index += 1;
    } else if (flag === "--chain-probe-count") {
      args.chainProbeCount = parseNonNegativeInteger(value, "--chain-probe-count");
      index += 1;
    } else if (flag === "--concurrency") {
      args.concurrency = parsePositiveInteger(value, "--concurrency");
      index += 1;
    } else if (flag === "--seed") {
      if (!value?.trim()) throw new Error("--seed requires a value");
      args.seed = value;
      index += 1;
    } else if (flag === "--max-per-bucket") {
      args.maxPerBucket = parsePositiveInteger(value, "--max-per-bucket");
      index += 1;
    } else if (flag === "--help" || flag === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (!args.runtimeRoot) throw new Error("--runtime-root is required");
  return args as Args;
}

function contextSurfaces(context: AionisCompiledContext): RuntimeReferenceSurfaces {
  return {
    use_now: context.use_now.map((node) => node.id),
    inspect_before_use: context.inspect_before_use.map((node) => node.id),
    do_not_use: context.do_not_use.map((node) => node.id),
    rehydrate: context.rehydrate.map((node) => node.id),
  };
}

function totalApplied(report: Awaited<ReturnType<typeof runRuntimeLiveSidecarOnce>>): number {
  return Object.values(report.apply_summary).reduce((sum, stats) => sum + stats.applied, 0);
}

function totalUnchanged(report: Awaited<ReturnType<typeof runRuntimeLiveSidecarOnce>>): number {
  return Object.values(report.apply_summary).reduce((sum, stats) => sum + stats.unchanged, 0);
}

async function runChild(args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot(),
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", rejectPromise);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`child process failed with code ${code ?? "null"} signal ${signal ?? "null"}`));
    });
  });
}

function repoRoot(): string {
  return fileURLToPath(new URL("..", import.meta.url));
}

async function readSummary(path: string): Promise<RuntimeDualWriteSummary> {
  return JSON.parse(await readFile(path, "utf8")) as RuntimeDualWriteSummary;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function runLiveSidecarParity(input: {
  summary: RuntimeDualWriteSummary;
  liveSidecarDbPath: string;
  outputPath: string;
  maxPerBucket?: number;
}): Promise<{ exactScenarioCount: number; scenarios: ProductBridgeParityScenario[] }> {
  const store = await openSqliteAionisSubstrate({ path: input.liveSidecarDbPath });
  try {
    const scenarios: ProductBridgeParityScenario[] = [];
    for (const scenario of input.summary.scenarios) {
      const compiled = await store.previewContext({
        scope: scenario.scope,
        query: `runtime product bridge parity for ${scenario.scenario_id}`,
        maxPerBucket: input.maxPerBucket,
      });
      const substrateSurfaces = contextSurfaces(compiled);
      const bucketReports = compareSurfaces(substrateSurfaces, scenario.runtime_surfaces);
      scenarios.push({
        scenario_id: scenario.scenario_id,
        scope: scenario.scope,
        exact: bucketReports.every((bucket) => bucket.exact),
        substrate_surfaces: substrateSurfaces,
        runtime_surfaces: scenario.runtime_surfaces,
        bucket_reports: bucketReports,
      });
    }
    const exactScenarioCount = scenarios.filter((scenario) => scenario.exact).length;
    await writeJson(input.outputPath, {
      contract_version: "aionis_runtime_product_bridge_live_sidecar_parity_v1",
      generated_at: new Date().toISOString(),
      live_sidecar_db_path: input.liveSidecarDbPath,
      scenario_count: scenarios.length,
      exact_scenario_count: exactScenarioCount,
      failed_scenario_count: scenarios.length - exactScenarioCount,
      scenarios,
    });
    return { exactScenarioCount, scenarios };
  } finally {
    await store.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.outputDir, { recursive: true });

  const dualWriteScript = fileURLToPath(new URL("runtime-dual-write-experiment.ts", import.meta.url));
  const dualWriteArgs = [
    dualWriteScript,
    "--runtime-root",
    args.runtimeRoot,
    "--scenario-count",
    String(args.scenarioCount),
    "--generated-count",
    String(args.generatedCount),
    "--chain-probe-count",
    String(args.chainProbeCount),
    "--concurrency",
    String(args.concurrency),
    "--seed",
    args.seed,
    "--output-dir",
    args.outputDir,
  ];
  if (args.maxPerBucket !== undefined) {
    dualWriteArgs.push("--max-per-bucket", String(args.maxPerBucket));
  }
  await runChild(dualWriteArgs);

  const dualWriteSummaryPath = join(args.outputDir, "summary.json");
  const summary = await readSummary(dualWriteSummaryPath);
  const liveSidecarDbPath = join(args.outputDir, "substrate-live-sidecar.sqlite");
  const checkpointPath = join(args.outputDir, "live-sidecar-checkpoint.json");
  const liveSidecarFirstPath = join(args.outputDir, "live-sidecar-first.json");
  const liveSidecarSecondPath = join(args.outputDir, "live-sidecar-second.json");
  const liveSidecarParityPath = join(args.outputDir, "live-sidecar-product-bridge-parity.json");

  const firstStore = await openSqliteAionisSubstrate({ path: liveSidecarDbPath });
  const liveSidecarFirst = await runRuntimeLiveSidecarOnce({
    sourcePath: summary.runtime_write_db_path,
    target: firstStore,
    checkpointPath,
  });
  await firstStore.close();
  await writeJson(liveSidecarFirstPath, liveSidecarFirst);

  const secondStore = await openSqliteAionisSubstrate({ path: liveSidecarDbPath });
  const liveSidecarSecond = await runRuntimeLiveSidecarOnce({
    sourcePath: summary.runtime_write_db_path,
    target: secondStore,
    checkpointPath,
  });
  await secondStore.close();
  await writeJson(liveSidecarSecondPath, liveSidecarSecond);

  const liveSidecarParity = await runLiveSidecarParity({
    summary,
    liveSidecarDbPath,
    outputPath: liveSidecarParityPath,
    maxPerBucket: args.maxPerBucket,
  });

  const failures: string[] = [];
  if (summary.exact_scenario_count !== summary.scenario_count) failures.push("dual-write parity was not exact for every scenario");
  if (summary.persisted_exact_scenario_count !== summary.scenario_count) failures.push("dual-write reopen parity was not exact for every scenario");
  if (summary.write_integrity_pass_count !== summary.scenario_count) failures.push("write-integrity probes did not pass for every scenario");
  if (summary.chain_probe_pass_count !== summary.chain_probe_count) failures.push("chain probes did not all pass");
  if (summary.persisted_chain_probe_pass_count !== summary.chain_probe_count) failures.push("persisted chain probes did not all pass");
  if (summary.failed_scenario_count !== 0) failures.push("dual-write reported failed scenarios");
  if (summary.failed_chain_probe_count !== 0) failures.push("dual-write reported failed chain probes");
  if (!summary.soak.event_sequence.contiguous) failures.push("Substrate event sequence was not contiguous");
  if (liveSidecarFirst.import_summary.nodesImported === 0) failures.push("live-sidecar imported zero Runtime nodes");
  if (totalApplied(liveSidecarFirst) === 0) failures.push("first live-sidecar pass applied zero events");
  if (totalApplied(liveSidecarSecond) !== 0) failures.push("second live-sidecar pass was not idempotent");
  if (totalUnchanged(liveSidecarSecond) !== totalApplied(liveSidecarFirst)) {
    failures.push("second live-sidecar unchanged count did not match first applied count");
  }
  if (liveSidecarParity.exactScenarioCount !== summary.scenario_count) {
    failures.push("live-sidecar previewContext parity was not exact for every scenario");
  }

  const report: ProductBridgeGateReport = {
    contract_version: "aionis_runtime_product_bridge_gate_report_v1",
    generated_at: new Date().toISOString(),
    runtime_root: args.runtimeRoot,
    output_dir: args.outputDir,
    dual_write_summary_path: dualWriteSummaryPath,
    live_sidecar_first_path: liveSidecarFirstPath,
    live_sidecar_second_path: liveSidecarSecondPath,
    live_sidecar_parity_path: liveSidecarParityPath,
    passed: failures.length === 0,
    failures,
    summary: {
      scenario_count: summary.scenario_count,
      exact_scenario_count: summary.exact_scenario_count,
      persisted_exact_scenario_count: summary.persisted_exact_scenario_count,
      write_integrity_pass_count: summary.write_integrity_pass_count,
      chain_probe_count: summary.chain_probe_count,
      chain_probe_pass_count: summary.chain_probe_pass_count,
      persisted_chain_probe_pass_count: summary.persisted_chain_probe_pass_count,
      live_sidecar_imported_nodes: liveSidecarFirst.import_summary.nodesImported,
      live_sidecar_skipped_nodes: liveSidecarFirst.import_summary.nodesSkipped,
      live_sidecar_second_applied_nodes: liveSidecarSecond.apply_summary.nodes.applied,
      live_sidecar_second_unchanged_nodes: liveSidecarSecond.apply_summary.nodes.unchanged,
      live_sidecar_exact_scenario_count: liveSidecarParity.exactScenarioCount,
    },
  };
  const reportPath = join(args.outputDir, "product-bridge-gate-summary.json");
  await writeJson(reportPath, report);
  console.log(JSON.stringify({ report: reportPath, passed: report.passed, ...report.summary }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

main().catch((err) => {
  console.error((err as Error).stack ?? String(err));
  console.error(usage());
  process.exit(1);
});
