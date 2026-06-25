import { resolve } from "node:path";
import { runRuntimeReferenceCorpus } from "../src/index.ts";

type Args = {
  sourceRoots: string[];
  referenceRoots: string[];
  output?: string;
  maxSourceFiles?: number | null;
  maxScopes?: number | null;
  maxScopesPerFile?: number;
  maxReferences?: number | null;
  minNodes?: number;
  minOverlap?: number;
  maxPerBucket?: number;
};

function usage(): string {
  return [
    "Usage:",
    "  node scripts/runtime-reference-corpus.ts --source-root /path/runtime/.tmp --reference-root /path/runtime/docs/examples",
    "",
    "Scans Runtime Lite SQLite files and Runtime agent_context/memory_decision_trace JSON references.",
    "References are matched to Runtime scopes only by concrete memory id overlap.",
  ].join("\n");
}

function parseOptionalLimit(raw: string | undefined, label: string): number | null {
  if (raw === undefined || raw === "all") return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer or 'all'`);
  return parsed;
}

function parseInteger(raw: string | undefined, label: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { sourceRoots: [], referenceRoots: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--source-root") {
      if (!value) throw new Error("--source-root requires a value");
      args.sourceRoots.push(value);
      i += 1;
    } else if (flag === "--reference-root") {
      if (!value) throw new Error("--reference-root requires a value");
      args.referenceRoots.push(value);
      i += 1;
    } else if (flag === "--output") {
      if (!value) throw new Error("--output requires a value");
      args.output = value;
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
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (args.sourceRoots.length === 0) throw new Error("--source-root is required");
  if (args.referenceRoots.length === 0) throw new Error("--reference-root is required");
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const output = args.output
    ? resolve(args.output)
    : resolve("reports", `runtime-reference-corpus-${new Date().toISOString().replace(/[:.]/g, "-")}`, "summary.json");
  const report = await runRuntimeReferenceCorpus({
    sourceRootPaths: args.sourceRoots.map((root) => resolve(root)),
    referenceRootPaths: args.referenceRoots.map((root) => resolve(root)),
    outputPath: output,
    maxSourceFiles: args.maxSourceFiles,
    maxScopes: args.maxScopes,
    maxScopesPerFile: args.maxScopesPerFile,
    maxReferences: args.maxReferences,
    minNodes: args.minNodes,
    minOverlap: args.minOverlap,
    maxPerBucket: args.maxPerBucket,
  });
  console.log(JSON.stringify({
    output,
    discovered_sqlite_files: report.discovered_sqlite_files,
    runtime_sqlite_files: report.runtime_sqlite_files,
    candidate_scopes: report.candidate_scopes.length,
    discovered_reference_files: report.discovered_reference_files,
    reference_files_with_surfaces: report.reference_files_with_surfaces,
    matched_references: report.matched_references,
    unmatched_references: report.unmatched_references,
    passed_matches: report.passed_matches,
    failed_matches: report.failed_matches,
    exact_matches: report.exact_matches,
    partial_matches: report.partial_matches,
    scan_warnings: report.scan_warnings.length,
  }, null, 2));
}

main().catch((err) => {
  console.error((err as Error).stack ?? String(err));
  console.error(usage());
  process.exit(1);
});
