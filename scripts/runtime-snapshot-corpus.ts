import { resolve } from "node:path";
import { runRuntimeSnapshotCorpus } from "../src/index.ts";

type Args = {
  roots: string[];
  output?: string;
  maxFiles?: number | null;
  maxScopes?: number | null;
  maxScopesPerFile?: number;
  minNodes?: number;
  maxPerBucket?: number;
};

function usage(): string {
  return [
    "Usage:",
    "  node scripts/runtime-snapshot-corpus.ts --root /path/runtime/.tmp [--output report.json]",
    "",
    "Scans Runtime Lite SQLite files read-only, imports selected scopes into temporary Substrate stores,",
    "and reports import coverage plus Substrate context bucket counts.",
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
  const args: Args = { roots: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--root") {
      if (!value) throw new Error("--root requires a value");
      args.roots.push(value);
      i += 1;
    } else if (flag === "--output") {
      if (!value) throw new Error("--output requires a value");
      args.output = value;
      i += 1;
    } else if (flag === "--max-files") {
      args.maxFiles = parseOptionalLimit(value, "--max-files");
      i += 1;
    } else if (flag === "--max-scopes") {
      args.maxScopes = parseOptionalLimit(value, "--max-scopes");
      i += 1;
    } else if (flag === "--max-scopes-per-file") {
      args.maxScopesPerFile = parseInteger(value, "--max-scopes-per-file");
      i += 1;
    } else if (flag === "--min-nodes") {
      args.minNodes = parseInteger(value, "--min-nodes");
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
  if (args.roots.length === 0) throw new Error("--root is required");
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const output = args.output
    ? resolve(args.output)
    : resolve("reports", `runtime-snapshot-corpus-${new Date().toISOString().replace(/[:.]/g, "-")}`, "summary.json");
  const report = await runRuntimeSnapshotCorpus({
    rootPaths: args.roots.map((root) => resolve(root)),
    outputPath: output,
    maxFiles: args.maxFiles,
    maxScopes: args.maxScopes,
    maxScopesPerFile: args.maxScopesPerFile,
    minNodes: args.minNodes,
    maxPerBucket: args.maxPerBucket,
  });
  console.log(JSON.stringify({
    output,
    discovered_sqlite_files: report.discovered_sqlite_files,
    runtime_sqlite_files: report.runtime_sqlite_files,
    candidate_scopes: report.candidate_scopes.length,
    attempted_scopes: report.attempted_scopes,
    passed_scopes: report.passed_scopes,
    failed_scopes: report.failed_scopes,
    total_nodes_imported: report.total_nodes_imported,
    total_warnings: report.total_warnings,
  }, null, 2));
}

main().catch((err) => {
  console.error((err as Error).stack ?? String(err));
  console.error(usage());
  process.exit(1);
});
