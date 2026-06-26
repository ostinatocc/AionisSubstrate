#!/usr/bin/env node
import { resolve } from "node:path";
import { runRuntimeSidecarCheck, type RuntimeSidecarCheckOptions } from "./index.ts";

type SidecarArgs = {
  source?: string;
  scope?: string;
  reference?: string;
  target?: string;
  output?: string;
  sourceRoots: string[];
  referenceRoots: string[];
  maxSourceFiles?: number | null;
  maxScopes?: number | null;
  maxScopesPerFile?: number;
  maxReferences?: number | null;
  minNodes?: number;
  minOverlap?: number;
  maxPerBucket?: number;
};

function rootUsage(): string {
  return [
    "Aionis Substrate CLI",
    "",
    "Usage:",
    "  aionis-substrate sidecar --source <runtime.sqlite> --scope <scope> [--reference <guide.json>]",
    "  aionis-substrate sidecar --source-root <runtime-root> --reference-root <reference-root>",
    "",
    "Commands:",
    "  sidecar   Run read-only Runtime sidecar stabilization checks.",
    "  help      Show this help message.",
    "",
    "Substrate is an external durable evidence layer. It does not start Runtime,",
    "replace Runtime storage, or mutate Runtime source code.",
  ].join("\n");
}

function sidecarUsage(): string {
  return [
    "Aionis Substrate sidecar check",
    "",
    "Usage:",
    "  aionis-substrate sidecar --source <runtime.sqlite> --scope <scope> [--reference <guide.json>]",
    "  aionis-substrate sidecar --source-root <runtime-root> --reference-root <reference-root>",
    "",
    "Snapshot options:",
    "  --source <path>          Runtime Lite SQLite snapshot opened read-only.",
    "  --scope <scope>          Runtime scope to import.",
    "  --reference <path>       Optional Runtime guide/measure JSON for bucket parity.",
    "  --target <path>          Optional isolated Substrate SQLite target.",
    "",
    "Reference corpus options:",
    "  --source-root <path>     Root containing Runtime Lite SQLite files. Repeatable.",
    "  --reference-root <path>  Root containing Runtime guide/measure JSON files. Repeatable.",
    "  --max-source-files <n|all>",
    "  --max-scopes <n|all>",
    "  --max-scopes-per-file <n>",
    "  --max-references <n|all>",
    "  --min-nodes <n>",
    "  --min-overlap <n>",
    "",
    "Output options:",
    "  --max-per-bucket <n>",
    "  --output <path>          Report path. Defaults to reports/runtime-sidecar-*/summary.json.",
  ].join("\n");
}

function parseOptionalLimit(raw: string | undefined, label: string): number | null {
  if (raw === undefined || raw === "all") return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer or 'all'`);
  }
  return parsed;
}

function parseInteger(raw: string | undefined, label: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function parseSidecarArgs(argv: string[]): SidecarArgs {
  const args: SidecarArgs = { sourceRoots: [], referenceRoots: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--source") {
      if (!value) throw new Error("--source requires a value");
      args.source = value;
      i += 1;
    } else if (flag === "--scope") {
      if (!value) throw new Error("--scope requires a value");
      args.scope = value;
      i += 1;
    } else if (flag === "--reference") {
      if (!value) throw new Error("--reference requires a value");
      args.reference = value;
      i += 1;
    } else if (flag === "--target") {
      if (!value) throw new Error("--target requires a value");
      args.target = value;
      i += 1;
    } else if (flag === "--output") {
      if (!value) throw new Error("--output requires a value");
      args.output = value;
      i += 1;
    } else if (flag === "--source-root") {
      if (!value) throw new Error("--source-root requires a value");
      args.sourceRoots.push(value);
      i += 1;
    } else if (flag === "--reference-root") {
      if (!value) throw new Error("--reference-root requires a value");
      args.referenceRoots.push(value);
      i += 1;
    } else if (flag === "--max-source-files") {
      args.maxSourceFiles = parseOptionalLimit(value, "--max-source-files");
      i += 1;
    } else if (flag === "--max-scopes") {
      args.maxScopes = parseOptionalLimit(value, "--max-scopes");
      i += 1;
    } else if (flag === "--max-scopes-per-file") {
      args.maxScopesPerFile = parseInteger(value, "--max-scopes-per-file");
      i += 1;
    } else if (flag === "--max-references") {
      args.maxReferences = parseOptionalLimit(value, "--max-references");
      i += 1;
    } else if (flag === "--min-nodes") {
      args.minNodes = parseInteger(value, "--min-nodes");
      i += 1;
    } else if (flag === "--min-overlap") {
      args.minOverlap = parseInteger(value, "--min-overlap");
      i += 1;
    } else if (flag === "--max-per-bucket") {
      args.maxPerBucket = parseInteger(value, "--max-per-bucket");
      i += 1;
    } else if (flag === "--help" || flag === "-h") {
      console.log(sidecarUsage());
      process.exit(0);
    } else {
      throw new Error(`unknown sidecar argument: ${flag}`);
    }
  }
  return args;
}

function sidecarOptions(args: SidecarArgs): RuntimeSidecarCheckOptions {
  const options: RuntimeSidecarCheckOptions = {
    outputPath: args.output
      ? resolve(args.output)
      : resolve("reports", `runtime-sidecar-${new Date().toISOString().replace(/[:.]/g, "-")}`, "summary.json"),
  };

  if (args.source || args.scope || args.reference || args.target) {
    if (!args.source) throw new Error("--source is required when running snapshot parity");
    if (!args.scope) throw new Error("--scope is required when running snapshot parity");
    options.snapshot = {
      sourcePath: resolve(args.source),
      scope: args.scope,
      referencePath: args.reference ? resolve(args.reference) : undefined,
      targetPath: args.target ? resolve(args.target) : undefined,
      maxPerBucket: args.maxPerBucket,
    };
  }

  if (args.sourceRoots.length > 0 || args.referenceRoots.length > 0) {
    if (args.sourceRoots.length === 0) {
      throw new Error("--source-root is required when running reference corpus parity");
    }
    if (args.referenceRoots.length === 0) {
      throw new Error("--reference-root is required when running reference corpus parity");
    }
    options.referenceCorpus = {
      sourceRootPaths: args.sourceRoots.map((root) => resolve(root)),
      referenceRootPaths: args.referenceRoots.map((root) => resolve(root)),
      maxSourceFiles: args.maxSourceFiles,
      maxScopes: args.maxScopes,
      maxScopesPerFile: args.maxScopesPerFile,
      maxReferences: args.maxReferences,
      minNodes: args.minNodes,
      minOverlap: args.minOverlap,
      maxPerBucket: args.maxPerBucket,
    };
  }

  if (!options.snapshot && !options.referenceCorpus) throw new Error("at least one sidecar check stage is required");
  return options;
}

async function runSidecar(argv: string[]): Promise<void> {
  const options = sidecarOptions(parseSidecarArgs(argv));
  const report = await runRuntimeSidecarCheck(options);
  console.log(JSON.stringify({
    output: options.outputPath,
    passed: report.summary.passed,
    stages_requested: report.stages_requested,
    snapshot_parity: report.summary.snapshot_parity,
    reference_corpus: report.summary.reference_corpus,
  }, null, 2));
  if (!report.summary.passed) process.exitCode = 1;
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(rootUsage());
    return;
  }
  if (command === "sidecar") {
    await runSidecar(argv.slice(1));
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

runCli().catch((err) => {
  console.error((err as Error).stack ?? String(err));
  console.error("");
  console.error(rootUsage());
  process.exit(1);
});
