import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  openFileAionisSubstrate,
  openSqliteAionisSubstrate,
  type AionisAdmissionAction,
  type AionisCompiledContext,
  type AionisSubstrate,
} from "../src/index.ts";

type AdapterName = "file" | "sqlite";

type ScenarioExpectation = Partial<Record<AionisAdmissionAction, string[]>> & {
  minEvents?: number;
};

type Scenario = {
  id: string;
  description: string;
  seed(store: AionisSubstrate): Promise<void>;
  expected: ScenarioExpectation;
};

type AdapterScenarioResult = {
  adapter: AdapterName;
  scenario_id: string;
  passed: boolean;
  buckets: Record<AionisAdmissionAction, string[]>;
  expected: ScenarioExpectation;
  event_count: number;
  decision_trace_present: boolean;
  failures: string[];
};

type BenchmarkReport = {
  benchmark: "aionis_substrate_contract";
  generated_at: string;
  adapter_count: number;
  scenario_count: number;
  total_runs: number;
  passed_runs: number;
  failed_runs: number;
  parity_passed: boolean;
  results: AdapterScenarioResult[];
};

const ACTIONS: AionisAdmissionAction[] = ["use_now", "inspect_before_use", "do_not_use", "rehydrate"];

const scenarios: Scenario[] = [
  {
    id: "active_trusted_direct_use",
    description: "active trusted execution memory enters use_now",
    async seed(store) {
      await store.putNode({
        id: "current-route",
        scope: "repo-a",
        kind: "execution",
        summary: "Current route is validated by verifier evidence.",
        lifecycle: "active",
        authority: "trusted",
        confidence: 0.94,
      });
    },
    expected: {
      use_now: ["current-route"],
      minEvents: 2,
    },
  },
  {
    id: "candidate_inspect_first",
    description: "candidate memory is relevant but not direct-use",
    async seed(store) {
      await store.putNode({
        id: "candidate-workflow",
        scope: "repo-a",
        kind: "procedure",
        summary: "Potential workflow with no outcome proof yet.",
        lifecycle: "candidate",
        authority: "advisory",
        confidence: 0.62,
      });
    },
    expected: {
      inspect_before_use: ["candidate-workflow"],
      minEvents: 2,
    },
  },
  {
    id: "superseded_old_route_blocked",
    description: "new relation blocks stale trusted memory from direct use",
    async seed(store) {
      await store.putNode({
        id: "old-route",
        scope: "repo-a",
        kind: "procedure",
        summary: "Old route that looked valid before later evidence.",
        lifecycle: "active",
        authority: "trusted",
        confidence: 0.8,
      });
      await store.putNode({
        id: "new-route",
        scope: "repo-a",
        kind: "procedure",
        summary: "New route with later accepted verifier evidence.",
        lifecycle: "active",
        authority: "trusted",
        confidence: 0.92,
      });
      await store.putRelation({
        id: "new-supersedes-old",
        scope: "repo-a",
        kind: "supersedes",
        sourceId: "new-route",
        targetId: "old-route",
        confidence: 0.88,
        reasons: ["later accepted evidence replaced the old route"],
      });
    },
    expected: {
      use_now: ["new-route"],
      do_not_use: ["old-route"],
      minEvents: 4,
    },
  },
  {
    id: "archived_trace_rehydrates",
    description: "archived trace pointer becomes rehydrate hook",
    async seed(store) {
      await store.putNode({
        id: "raw-trace",
        scope: "repo-a",
        kind: "trace_pointer",
        summary: "Full terminal trace should stay out of prompt until requested.",
        lifecycle: "archived",
        authority: "trusted",
        confidence: 0.91,
        payloadRef: "file://traces/run.log",
      });
    },
    expected: {
      rehydrate: ["raw-trace"],
      minEvents: 2,
    },
  },
  {
    id: "controlled_forgetting_keeps_evidence",
    description: "suppression changes lifecycle while keeping old evidence in the event log",
    async seed(store) {
      await store.putNode({
        id: "bad-pattern",
        scope: "repo-a",
        kind: "procedure",
        summary: "Procedure demoted after repeated negative feedback.",
        lifecycle: "active",
        authority: "trusted",
        confidence: 0.7,
      });
      await store.recordFeedback({
        id: "negative-feedback",
        scope: "repo-a",
        memoryId: "bad-pattern",
        outcome: "negative",
        strength: "strong",
        runId: "run-7",
      });
      await store.transitionLifecycle({
        scope: "repo-a",
        memoryId: "bad-pattern",
        lifecycle: "suppressed",
        authority: "rejected",
        confidence: 0.2,
        reason: "negative feedback crossed suppression threshold",
      });
    },
    expected: {
      do_not_use: ["bad-pattern"],
      minEvents: 4,
    },
  },
  {
    id: "scope_isolation",
    description: "relations in repo-a cannot affect same memory id in repo-b",
    async seed(store) {
      await store.putNode({
        id: "shared-id",
        scope: "repo-a",
        kind: "fact",
        summary: "Repo A old fact.",
        lifecycle: "active",
        authority: "trusted",
        confidence: 0.8,
      });
      await store.putNode({
        id: "repo-a-new",
        scope: "repo-a",
        kind: "fact",
        summary: "Repo A newer fact.",
        lifecycle: "active",
        authority: "trusted",
        confidence: 0.9,
      });
      await store.putRelation({
        id: "repo-a-invalidates-shared",
        scope: "repo-a",
        kind: "invalidates",
        sourceId: "repo-a-new",
        targetId: "shared-id",
        confidence: 0.9,
        reasons: ["repo-a-only invalidation"],
      });
      await store.putNode({
        id: "shared-id",
        scope: "repo-b",
        kind: "fact",
        summary: "Repo B fact should remain usable.",
        lifecycle: "active",
        authority: "trusted",
        confidence: 0.8,
      });
    },
    expected: {
      use_now: ["repo-a-new"],
      do_not_use: ["shared-id"],
      minEvents: 5,
    },
  },
];

function bucketIds(context: AionisCompiledContext): Record<AionisAdmissionAction, string[]> {
  return {
    use_now: context.use_now.map((node) => node.id).sort(),
    inspect_before_use: context.inspect_before_use.map((node) => node.id).sort(),
    do_not_use: context.do_not_use.map((node) => node.id).sort(),
    rehydrate: context.rehydrate.map((node) => node.id).sort(),
  };
}

function assertContains(actual: string[], expected: string[] | undefined, label: string, failures: string[]): void {
  for (const id of expected ?? []) {
    if (!actual.includes(id)) failures.push(`${label} missing ${id}`);
  }
}

async function openAdapter(adapter: AdapterName, root: string): Promise<AionisSubstrate> {
  if (adapter === "file") return await openFileAionisSubstrate({ dir: join(root, "file") });
  return await openSqliteAionisSubstrate({ path: join(root, "sqlite", "substrate.sqlite") });
}

async function runScenario(adapter: AdapterName, scenario: Scenario): Promise<AdapterScenarioResult> {
  const root = await mkdtemp(join(tmpdir(), `aionis-substrate-${adapter}-${scenario.id}-`));
  try {
    let store = await openAdapter(adapter, root);
    await scenario.seed(store);
    await store.close();

    store = await openAdapter(adapter, root);
    const context = await store.compileContext({ scope: "repo-a", query: scenario.description });
    const events = await store.listEvents();
    const buckets = bucketIds(context);
    const failures: string[] = [];

    for (const action of ACTIONS) assertContains(buckets[action], scenario.expected[action], action, failures);
    if ((scenario.expected.minEvents ?? 0) > events.length) {
      failures.push(`event_count expected >= ${scenario.expected.minEvents}, got ${events.length}`);
    }
    if (!context.decision_trace.decisions.length) failures.push("decision trace has no decisions");

    return {
      adapter,
      scenario_id: scenario.id,
      passed: failures.length === 0,
      buckets,
      expected: scenario.expected,
      event_count: events.length,
      decision_trace_present: context.decision_trace.decisions.length > 0,
      failures,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function parityFailures(results: AdapterScenarioResult[]): string[] {
  const failures: string[] = [];
  for (const scenario of scenarios) {
    const file = results.find((result) => result.adapter === "file" && result.scenario_id === scenario.id);
    const sqlite = results.find((result) => result.adapter === "sqlite" && result.scenario_id === scenario.id);
    if (!file || !sqlite) {
      failures.push(`${scenario.id}: missing adapter result`);
      continue;
    }
    for (const action of ACTIONS) {
      if (JSON.stringify(file.buckets[action]) !== JSON.stringify(sqlite.buckets[action])) {
        failures.push(`${scenario.id}: ${action} parity mismatch`);
      }
    }
  }
  return failures;
}

function markdownReport(report: BenchmarkReport, parity: string[]): string {
  const lines: string[] = [
    "# Aionis Substrate Contract Benchmark",
    "",
    `Generated: ${report.generated_at}`,
    "",
    `Adapters: ${report.adapter_count}`,
    `Scenarios: ${report.scenario_count}`,
    `Runs: ${report.passed_runs}/${report.total_runs} passed`,
    `Adapter parity: ${report.parity_passed ? "passed" : "failed"}`,
    "",
    "## Results",
    "",
    "| Adapter | Scenario | Passed | use_now | inspect | do_not_use | rehydrate | Events |",
    "|---|---|---:|---|---|---|---|---:|",
  ];
  for (const result of report.results) {
    lines.push([
      result.adapter,
      result.scenario_id,
      result.passed ? "yes" : "no",
      result.buckets.use_now.join(", ") || "-",
      result.buckets.inspect_before_use.join(", ") || "-",
      result.buckets.do_not_use.join(", ") || "-",
      result.buckets.rehydrate.join(", ") || "-",
      String(result.event_count),
    ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
  }
  if (parity.length) {
    lines.push("", "## Parity Failures", "");
    for (const failure of parity) lines.push(`- ${failure}`);
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const results: AdapterScenarioResult[] = [];
  for (const scenario of scenarios) {
    results.push(await runScenario("file", scenario));
    results.push(await runScenario("sqlite", scenario));
  }
  const parity = parityFailures(results);
  const report: BenchmarkReport = {
    benchmark: "aionis_substrate_contract",
    generated_at: new Date().toISOString(),
    adapter_count: 2,
    scenario_count: scenarios.length,
    total_runs: results.length,
    passed_runs: results.filter((result) => result.passed).length,
    failed_runs: results.filter((result) => !result.passed).length,
    parity_passed: parity.length === 0,
    results,
  };
  const outDir = resolve("reports", `substrate-contract-${report.generated_at.replace(/[:.]/g, "-")}`);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(join(outDir, "summary.md"), markdownReport(report, parity), "utf8");

  const failed = report.failed_runs > 0 || !report.parity_passed;
  console.log(JSON.stringify({
    report_dir: outDir,
    passed_runs: report.passed_runs,
    total_runs: report.total_runs,
    parity_passed: report.parity_passed,
  }, null, 2));
  if (failed) process.exitCode = 1;
}

await main();
