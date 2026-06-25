import { resolve } from "node:path";
import { runRuntimeSnapshotParity } from "../src/index.ts";

type Args = {
  source?: string;
  scope?: string;
  reference?: string;
  target?: string;
  output?: string;
  maxPerBucket?: number;
};

function usage(): string {
  return [
    "Usage:",
    "  node scripts/runtime-snapshot-parity.ts --source /path/runtime.sqlite --scope repo-a [--reference guide-or-measure.json] [--target /tmp/substrate.sqlite] [--output report.json]",
    "",
    "Without --reference, the command reports read-only import coverage and Substrate compileContext bucket counts.",
    "With --reference, it compares Substrate buckets to Runtime agent_context/memory_decision_trace surfaces.",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--source") {
      args.source = value;
      i += 1;
    } else if (flag === "--scope") {
      args.scope = value;
      i += 1;
    } else if (flag === "--reference") {
      args.reference = value;
      i += 1;
    } else if (flag === "--target") {
      args.target = value;
      i += 1;
    } else if (flag === "--output") {
      args.output = value;
      i += 1;
    } else if (flag === "--max-per-bucket") {
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
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.source) throw new Error("--source is required");
  if (!args.scope) throw new Error("--scope is required");
  const report = await runRuntimeSnapshotParity({
    sourcePath: resolve(args.source),
    scope: args.scope,
    referencePath: args.reference ? resolve(args.reference) : undefined,
    targetPath: args.target ? resolve(args.target) : undefined,
    outputPath: args.output ? resolve(args.output) : undefined,
    maxPerBucket: args.maxPerBucket,
  });
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error((err as Error).stack ?? String(err));
  console.error(usage());
  process.exit(1);
});
