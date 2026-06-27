import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

type PackageJson = {
  name: string;
  version: string;
};

type Args = {
  sourcePath: string;
  scope?: string;
  limit: number;
  packageSpec: string;
  keepTemp: boolean;
};

type RuntimeImportReport = {
  contract_version: string;
  sourcePath?: string;
  nodesRead?: number;
  nodesImported?: number;
  nodesSkipped?: number;
  relationsRead?: number;
  relationsImported?: number;
  relationsSkipped?: number;
  feedbackRead?: number;
  feedbackImported?: number;
  feedbackSkipped?: number;
  decisionsRead?: number;
  decisionsImported?: number;
  decisionsSkipped?: number;
  scopes?: string[];
};

type RuntimeLiveSidecarReport = {
  contract_version: string;
  import_summary?: RuntimeImportReport;
};

type InspectReport = {
  contract_version: string;
  info: {
    adapter: string;
    schemaVersion: number;
    lastSequence: number;
    eventCount: number;
  };
};

function registryPackageSpec(): string {
  const override = process.env.AIONIS_SUBSTRATE_REGISTRY_PACKAGE?.trim();
  if (override) return override;
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;
  return `${pkg.name}@${pkg.version}`;
}

function usage(): never {
  throw new Error([
    "Usage:",
    "  node scripts/published-runtime-bridge.ts --source /path/runtime.sqlite [--scope <scope>] [--limit 1000] [--package @aionis/substrate@0.1.5] [--keep-temp]",
    "",
    "Environment:",
    "  AIONIS_RUNTIME_SQLITE_SOURCE=/path/runtime.sqlite",
    "  AIONIS_SUBSTRATE_REGISTRY_PACKAGE=@aionis/substrate@0.1.5",
    "",
    "This installs the published npm package into a fresh temp project, imports a real Runtime Lite SQLite source into a separate Substrate store,",
    "runs checkpointed live-sidecar twice, and verifies source immutability plus snapshot/live parity.",
  ].join("\n"));
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let sourcePath = process.env.AIONIS_RUNTIME_SQLITE_SOURCE?.trim() ?? "";
  let scope: string | undefined;
  let limit = Number(process.env.AIONIS_RUNTIME_BRIDGE_LIMIT ?? "1000");
  let packageSpec = registryPackageSpec();
  let keepTemp = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--source") {
      sourcePath = args[++index] ?? "";
    } else if (arg === "--scope") {
      scope = args[++index] ?? "";
    } else if (arg === "--limit") {
      limit = Number(args[++index] ?? "");
    } else if (arg === "--package") {
      packageSpec = args[++index] ?? "";
    } else if (arg === "--keep-temp") {
      keepTemp = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!sourcePath) usage();
  if (!Number.isInteger(limit) || limit <= 0) throw new Error(`invalid --limit: ${limit}`);
  if (!packageSpec) throw new Error("empty package spec");

  return {
    sourcePath: resolve(sourcePath),
    scope: scope || undefined,
    limit,
    packageSpec,
    keepTemp,
  };
}

function runCli(workspace: string, args: string[]): string {
  return execFileSync(join(workspace, "node_modules", ".bin", "aionis-substrate"), args, {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`${label} did not return valid JSON: ${(error as Error).message}\n${raw}`);
  }
}

function importedEvents(report: RuntimeImportReport): number {
  return (report.nodesImported ?? 0)
    + (report.relationsImported ?? 0)
    + (report.feedbackImported ?? 0)
    + (report.decisionsImported ?? 0);
}

function importSummaryFromLive(report: RuntimeLiveSidecarReport): RuntimeImportReport {
  if (!report.import_summary) throw new Error("live-sidecar report did not include import_summary");
  return report.import_summary;
}

async function assertSourceUnchanged(path: string, before: { size: number; mtimeMs: number }): Promise<void> {
  const after = await stat(path);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new Error(`Runtime source changed during bridge check: ${path}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  const beforeSourceStat = await stat(args.sourcePath);
  const workspace = await mkdtemp(join(tmpdir(), "aionis-substrate-published-bridge-"));

  try {
    await writeFile(join(workspace, "package.json"), "{\"type\":\"module\"}\n", "utf8");
    execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund", args.packageSpec], {
      cwd: workspace,
      stdio: "pipe",
    });

    const snapshotPath = join(workspace, "substrate-snapshot.sqlite");
    const livePath = join(workspace, "substrate-live.sqlite");
    const checkpointPath = join(workspace, "runtime-live-checkpoint.json");
    const scopeArgs = args.scope ? ["--scope", args.scope] : [];
    const limitArgs = ["--limit", String(args.limit)];

    const importReport = parseJson<RuntimeImportReport>(runCli(workspace, [
      "import-runtime-snapshot",
      "--source", args.sourcePath,
      "--target", snapshotPath,
      "--adapter", "sqlite",
      ...scopeArgs,
      ...limitArgs,
    ]), "import-runtime-snapshot");

    const inspectSnapshot = parseJson<InspectReport>(runCli(workspace, [
      "inspect",
      "--adapter", "sqlite",
      "--path", snapshotPath,
      ...scopeArgs,
    ]), "inspect snapshot");

    const liveFirst = parseJson<RuntimeLiveSidecarReport>(runCli(workspace, [
      "live-sidecar",
      "--source", args.sourcePath,
      "--target", livePath,
      "--adapter", "sqlite",
      "--checkpoint", checkpointPath,
      ...scopeArgs,
      ...limitArgs,
    ]), "live-sidecar first");

    const inspectLiveAfterFirst = parseJson<InspectReport>(runCli(workspace, [
      "inspect",
      "--adapter", "sqlite",
      "--path", livePath,
      ...scopeArgs,
    ]), "inspect live after first pass");

    const liveSecond = parseJson<RuntimeLiveSidecarReport>(runCli(workspace, [
      "live-sidecar",
      "--source", args.sourcePath,
      "--target", livePath,
      "--adapter", "sqlite",
      "--checkpoint", checkpointPath,
      ...scopeArgs,
      ...limitArgs,
    ]), "live-sidecar second");

    const inspectLive = parseJson<InspectReport>(runCli(workspace, [
      "inspect",
      "--adapter", "sqlite",
      "--path", livePath,
      ...scopeArgs,
    ]), "inspect live");

    await assertSourceUnchanged(args.sourcePath, beforeSourceStat);

    const liveFirstSummary = importSummaryFromLive(liveFirst);
    const liveSecondSummary = importSummaryFromLive(liveSecond);
    const firstEvents = importedEvents(liveFirstSummary);
    const secondEvents = importedEvents(liveSecondSummary);
    const secondChangedEvents = inspectLive.info.eventCount - inspectLiveAfterFirst.info.eventCount;
    const secondChangedSequence = inspectLive.info.lastSequence - inspectLiveAfterFirst.info.lastSequence;

    if ((importReport.nodesImported ?? 0) <= 0) throw new Error("snapshot import imported zero Runtime nodes");
    if (importedEvents(importReport) <= 0) throw new Error("snapshot import applied zero Substrate events");
    if (firstEvents <= 0) throw new Error("first live-sidecar pass applied zero Substrate events");
    if (secondChangedEvents !== 0 || secondChangedSequence !== 0) {
      throw new Error([
        "second live-sidecar pass was not idempotent",
        `event delta: ${secondChangedEvents}`,
        `sequence delta: ${secondChangedSequence}`,
      ].join("; "));
    }
    if (inspectSnapshot.info.eventCount !== inspectLive.info.eventCount) {
      throw new Error(`snapshot/live event count mismatch: ${inspectSnapshot.info.eventCount} vs ${inspectLive.info.eventCount}`);
    }
    if (inspectSnapshot.info.lastSequence !== inspectLive.info.lastSequence) {
      throw new Error(`snapshot/live sequence mismatch: ${inspectSnapshot.info.lastSequence} vs ${inspectLive.info.lastSequence}`);
    }

    console.log(JSON.stringify({
      ok: true,
      package: args.packageSpec,
      source: args.sourcePath,
      scope: args.scope ?? null,
      limit: args.limit,
      temp_dir: args.keepTemp ? workspace : null,
      snapshot: {
        nodes_read: importReport.nodesRead ?? 0,
        nodes_imported: importReport.nodesImported ?? 0,
        nodes_skipped: importReport.nodesSkipped ?? 0,
        relations_read: importReport.relationsRead ?? 0,
        relations_imported: importReport.relationsImported ?? 0,
        relations_skipped: importReport.relationsSkipped ?? 0,
        feedback_imported: importReport.feedbackImported ?? 0,
        decisions_imported: importReport.decisionsImported ?? 0,
        scopes: importReport.scopes?.length ?? 0,
        event_count: inspectSnapshot.info.eventCount,
      },
      live_sidecar: {
        first_reported_imported_events: firstEvents,
        second_reported_imported_events: secondEvents,
        second_changed_events: secondChangedEvents,
        second_changed_sequence: secondChangedSequence,
        event_count: inspectLive.info.eventCount,
      },
      source_immutable: true,
    }, null, 2));
  } finally {
    if (!args.keepTemp) await rm(workspace, { recursive: true, force: true });
  }
}

await main();
