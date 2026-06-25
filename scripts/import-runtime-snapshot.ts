import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  importRuntimeLiteSnapshot,
  openFileAionisSubstrate,
  openSqliteAionisSubstrate,
  type AionisSubstrate,
} from "../src/index.ts";

type Args = {
  source?: string;
  target?: string;
  adapter: "sqlite" | "file";
  scope?: string;
  limit?: number;
};

function usage(): string {
  return [
    "Usage:",
    "  node scripts/import-runtime-snapshot.ts --source /path/runtime.sqlite --target /tmp/substrate.sqlite --adapter sqlite [--scope repo-a] [--limit 100]",
    "  node scripts/import-runtime-snapshot.ts --source /path/runtime.sqlite --target /tmp/substrate-dir --adapter file [--scope repo-a]",
  ].join("\n");
}

function parseArgs(argv: string[]): Args {
  const args: Args = { adapter: "sqlite" };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--source") {
      args.source = value;
      i += 1;
    } else if (flag === "--target") {
      args.target = value;
      i += 1;
    } else if (flag === "--adapter") {
      if (value !== "sqlite" && value !== "file") throw new Error("--adapter must be sqlite or file");
      args.adapter = value;
      i += 1;
    } else if (flag === "--scope") {
      args.scope = value;
      i += 1;
    } else if (flag === "--limit") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) throw new Error("--limit must be a non-negative integer");
      args.limit = parsed;
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

async function openTarget(args: Args): Promise<AionisSubstrate> {
  if (!args.target) throw new Error("--target is required");
  const target = resolve(args.target);
  if (args.adapter === "file") {
    await mkdir(target, { recursive: true });
    return await openFileAionisSubstrate({ dir: target });
  }
  await mkdir(dirname(target), { recursive: true });
  return await openSqliteAionisSubstrate({ path: target });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.source) throw new Error("--source is required");
  const target = await openTarget(args);
  try {
    const summary = await importRuntimeLiteSnapshot({
      sourcePath: resolve(args.source),
      target,
      scope: args.scope,
      limit: args.limit,
    });
    console.log(JSON.stringify({
      contract_version: "aionis_runtime_lite_snapshot_import_summary_v1",
      target_adapter: args.adapter,
      target: resolve(args.target ?? ""),
      ...summary,
    }, null, 2));
  } finally {
    await target.close();
  }
}

main().catch((err) => {
  console.error((err as Error).stack ?? String(err));
  console.error(usage());
  process.exit(1);
});
