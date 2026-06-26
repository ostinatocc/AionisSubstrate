import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  runRuntimeReferenceCorpus,
  type RuntimeReferenceCorpusOptions,
  type RuntimeReferenceCorpusReport,
} from "./runtime-reference-corpus.ts";
import {
  runRuntimeSnapshotParity,
  type RuntimeSnapshotParityOptions,
  type RuntimeSnapshotParityReport,
} from "./runtime-snapshot-parity.ts";

export type RuntimeSidecarSnapshotCheckOptions = RuntimeSnapshotParityOptions;
export type RuntimeSidecarReferenceCorpusCheckOptions = RuntimeReferenceCorpusOptions;

export type RuntimeSidecarCheckOptions = {
  snapshot?: RuntimeSidecarSnapshotCheckOptions;
  referenceCorpus?: RuntimeSidecarReferenceCorpusCheckOptions;
  outputPath?: string;
};

export type RuntimeSidecarStageSummary = {
  requested: boolean;
  passed: boolean | null;
  status: "not_requested" | "passed" | "failed" | "no_reference" | "no_matched_reference";
  detail: string;
};

export type RuntimeSidecarCheckReport = {
  contract_version: "aionis_runtime_sidecar_check_report_v1";
  generated_at: string;
  stages_requested: Array<"snapshot_parity" | "reference_corpus">;
  summary: {
    passed: boolean;
    snapshot_parity: RuntimeSidecarStageSummary;
    reference_corpus: RuntimeSidecarStageSummary;
  };
  snapshot_parity: RuntimeSnapshotParityReport | null;
  reference_corpus: RuntimeReferenceCorpusReport | null;
  notes: string[];
};

function notRequested(detail: string): RuntimeSidecarStageSummary {
  return {
    requested: false,
    passed: null,
    status: "not_requested",
    detail,
  };
}

function summarizeSnapshot(report: RuntimeSnapshotParityReport | null): RuntimeSidecarStageSummary {
  if (!report) return notRequested("No Runtime SQLite snapshot was supplied.");
  if (!report.reference_present) {
    return {
      requested: true,
      passed: true,
      status: "no_reference",
      detail: `Imported ${report.import_summary.nodesImported} Runtime nodes read-only; no Runtime reference JSON was supplied for bucket parity.`,
    };
  }
  const passed = report.parity.exact === true;
  return {
    requested: true,
    passed,
    status: passed ? "passed" : "failed",
    detail: passed
      ? "Substrate compiled buckets exactly match the supplied Runtime reference surfaces."
      : "Substrate compiled buckets differ from the supplied Runtime reference surfaces.",
  };
}

function summarizeReferenceCorpus(report: RuntimeReferenceCorpusReport | null): RuntimeSidecarStageSummary {
  if (!report) return notRequested("No Runtime source/reference corpus roots were supplied.");
  if (report.matched_references === 0) {
    return {
      requested: true,
      passed: false,
      status: "no_matched_reference",
      detail: "Reference files were scanned, but none overlapped concrete memory ids in Runtime SQLite scopes.",
    };
  }
  const passed = report.failed_matches === 0;
  return {
    requested: true,
    passed,
    status: passed ? "passed" : "failed",
    detail: passed
      ? `${report.passed_matches}/${report.matched_references} matched Runtime references passed parity.`
      : `${report.failed_matches}/${report.matched_references} matched Runtime references failed parity.`,
  };
}

function requestedStages(options: RuntimeSidecarCheckOptions): Array<"snapshot_parity" | "reference_corpus"> {
  const stages: Array<"snapshot_parity" | "reference_corpus"> = [];
  if (options.snapshot) stages.push("snapshot_parity");
  if (options.referenceCorpus) stages.push("reference_corpus");
  return stages;
}

export async function runRuntimeSidecarCheck(options: RuntimeSidecarCheckOptions): Promise<RuntimeSidecarCheckReport> {
  const stages = requestedStages(options);
  if (stages.length === 0) throw new Error("at least one sidecar check stage is required");

  const snapshot = options.snapshot
    ? await runRuntimeSnapshotParity(options.snapshot)
    : null;
  const referenceCorpus = options.referenceCorpus
    ? await runRuntimeReferenceCorpus(options.referenceCorpus)
    : null;
  const snapshotSummary = summarizeSnapshot(snapshot);
  const referenceSummary = summarizeReferenceCorpus(referenceCorpus);
  const requestedSummaries = [snapshotSummary, referenceSummary].filter((summary) => summary.requested);
  const report: RuntimeSidecarCheckReport = {
    contract_version: "aionis_runtime_sidecar_check_report_v1",
    generated_at: new Date().toISOString(),
    stages_requested: stages,
    summary: {
      passed: requestedSummaries.every((summary) => summary.passed === true),
      snapshot_parity: snapshotSummary,
      reference_corpus: referenceSummary,
    },
    snapshot_parity: snapshot,
    reference_corpus: referenceCorpus,
    notes: [
      "Snapshot parity opens Runtime Lite SQLite read-only and writes only to an isolated Substrate target.",
      "Reference corpus parity counts only Runtime references with concrete memory-id overlap in the same source corpus.",
      "This sidecar check does not mutate Aionis Runtime source code or replace Runtime storage.",
      "Real Runtime dual-write remains a separate explicit check because it starts a focused Runtime process.",
    ],
  };

  if (options.outputPath) {
    const outputPath = resolve(options.outputPath);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  return report;
}
