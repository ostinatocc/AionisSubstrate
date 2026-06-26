#!/usr/bin/env node
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  exportAionisSubstrateBackup,
  importRuntimeLiteSnapshot,
  openFileAionisSubstrate,
  openSqliteAionisSubstrate,
  readAionisSubstrateBackupFile,
  restoreAionisSubstrateBackupToFile,
  restoreAionisSubstrateBackupToSqlite,
  runRuntimeLiveSidecarOnce,
  runRuntimeLiveSidecarWatch,
  runRuntimeSidecarCheck,
  verifyAionisSubstrateBackup,
  writeAionisSubstrateBackupFile,
  type AionisSubstrate,
  type RuntimeSidecarCheckOptions,
} from "./index.ts";

type StoreAdapter = "sqlite" | "file";

type StoreArgs = {
  adapter?: StoreAdapter;
  path?: string;
};

type InspectArgs = StoreArgs & {
  scope?: string;
};

type ContextArgs = StoreArgs & {
  scope?: string;
  query?: string;
  maxPerBucket?: number;
};

type BackupArgs = StoreArgs & {
  output?: string;
};

type RestoreArgs = StoreArgs & {
  input?: string;
  overwrite?: boolean;
};

type CompactArgs = StoreArgs;

type RuntimeImportArgs = {
  source?: string;
  target?: string;
  adapter?: StoreAdapter;
  scope?: string;
  limit?: number;
};

type RuntimeLiveSidecarArgs = RuntimeImportArgs & {
  checkpoint?: string;
  dryRun?: boolean;
  output?: string;
  watch?: boolean;
  intervalMs?: number;
  iterations?: number;
  lock?: string | null;
};

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
    "  aionis-substrate import-runtime-snapshot --source <runtime.sqlite> --target <store> --adapter sqlite",
    "  aionis-substrate live-sidecar --source <runtime.sqlite> --target <store> --adapter sqlite --checkpoint <checkpoint.json> [--watch --iterations <n>]",
    "  aionis-substrate preview-context --adapter sqlite --path <store> --scope <scope>",
    "  aionis-substrate inspect --adapter sqlite --path <store> [--scope <scope>]",
    "  aionis-substrate backup --adapter sqlite --path <store> --output <backup.json>",
    "  aionis-substrate restore --adapter sqlite --path <store> --input <backup.json>",
    "  aionis-substrate compact --adapter sqlite --path <store>",
    "  aionis-substrate sidecar --source-root <runtime-root> --reference-root <reference-root>",
    "",
    "Commands:",
    "  sidecar                  Run read-only Runtime sidecar stabilization checks.",
    "  import-runtime-snapshot  Import a Runtime Lite SQLite snapshot into a separate Substrate store.",
    "  live-sidecar             Incrementally mirror Runtime Lite evidence into a Substrate store.",
    "  inspect                  Inspect store metadata and scoped audit counts.",
    "  preview-context          Compile governed buckets without writing a decision receipt.",
    "  backup                   Export and verify a checksum-covered event backup.",
    "  restore                  Restore a checksum-verified backup into an empty target.",
    "  compact                  Rewrite event history into a checkpoint without changing state.",
    "  help                     Show this help message.",
    "",
    "Substrate is an external durable evidence layer. It does not start Runtime,",
    "replace Runtime storage, or mutate Runtime source code.",
  ].join("\n");
}

function storeUsage(command: string): string {
  return [
    `Aionis Substrate ${command}`,
    "",
    "Store options:",
    "  --adapter <sqlite|file>",
    "  --path <path>",
    "",
    "Examples:",
    "  aionis-substrate inspect --adapter sqlite --path ./substrate.sqlite --scope repo-a",
    "  aionis-substrate preview-context --adapter file --path ./substrate-store --scope repo-a --query runtime",
    "  aionis-substrate backup --adapter sqlite --path ./substrate.sqlite --output ./backup.json",
    "  aionis-substrate restore --adapter sqlite --path ./restored.sqlite --input ./backup.json",
    "  aionis-substrate compact --adapter sqlite --path ./substrate.sqlite",
  ].join("\n");
}

function runtimeImportUsage(): string {
  return [
    "Aionis Substrate Runtime snapshot import",
    "",
    "Usage:",
    "  aionis-substrate import-runtime-snapshot --source <runtime.sqlite> --target <store> --adapter <sqlite|file> [--scope <scope>] [--limit <n>]",
    "",
    "The Runtime SQLite source is opened read-only. The target is a separate Substrate store.",
  ].join("\n");
}

function runtimeLiveSidecarUsage(): string {
  return [
    "Aionis Substrate Runtime live sidecar",
    "",
    "Usage:",
    "  aionis-substrate live-sidecar --source <runtime.sqlite> --target <store> --adapter <sqlite|file> --checkpoint <checkpoint.json> [--scope <scope>] [--limit <n>]",
    "",
    "The Runtime SQLite source is opened read-only. The sidecar writes only the separate Substrate target",
    "and an explicit checkpoint file. Run it repeatedly from a scheduler to sync new Runtime evidence.",
    "",
    "Options:",
    "  --dry-run                Report what would be applied without writing target or checkpoint.",
    "  --output <path>          Also write the JSON report to a file.",
    "  --watch                  Run a bounded watch loop instead of a single pass.",
    "  --iterations <n>         Required with --watch. Number of sync passes to run.",
    "  --interval-ms <n>        Delay between watch passes. Defaults to 5000.",
    "  --lock <path>            Watch lock path. Defaults to <checkpoint>.lock.",
    "  --no-lock                Disable the watch lock. Intended for tests only.",
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

function parseAdapter(raw: string | undefined): StoreAdapter {
  if (raw !== "sqlite" && raw !== "file") throw new Error("--adapter must be sqlite or file");
  return raw;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function openExistingStore(args: StoreArgs): Promise<AionisSubstrate> {
  if (!args.adapter) throw new Error("--adapter is required");
  if (!args.path) throw new Error("--path is required");
  const path = resolve(args.path);
  if (!(await pathExists(path))) throw new Error(`store path does not exist: ${path}`);
  return args.adapter === "file"
    ? await openFileAionisSubstrate({ dir: path })
    : await openSqliteAionisSubstrate({ path });
}

async function openTargetStore(args: StoreArgs): Promise<AionisSubstrate> {
  if (!args.adapter) throw new Error("--adapter is required");
  if (!args.path) throw new Error("--path is required");
  const path = resolve(args.path);
  if (args.adapter === "file") {
    await mkdir(path, { recursive: true });
    return await openFileAionisSubstrate({ dir: path });
  }
  await mkdir(dirname(path), { recursive: true });
  return await openSqliteAionisSubstrate({ path });
}

function parseInspectArgs(argv: string[]): InspectArgs {
  const args: InspectArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--adapter") {
      args.adapter = parseAdapter(value);
      i += 1;
    } else if (flag === "--path") {
      if (!value) throw new Error("--path requires a value");
      args.path = value;
      i += 1;
    } else if (flag === "--scope") {
      if (!value) throw new Error("--scope requires a value");
      args.scope = value;
      i += 1;
    } else if (flag === "--help" || flag === "-h") {
      console.log(storeUsage("inspect"));
      process.exit(0);
    } else {
      throw new Error(`unknown inspect argument: ${flag}`);
    }
  }
  return args;
}

function parseContextArgs(argv: string[]): ContextArgs {
  const args: ContextArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--adapter") {
      args.adapter = parseAdapter(value);
      i += 1;
    } else if (flag === "--path") {
      if (!value) throw new Error("--path requires a value");
      args.path = value;
      i += 1;
    } else if (flag === "--scope") {
      if (!value) throw new Error("--scope requires a value");
      args.scope = value;
      i += 1;
    } else if (flag === "--query") {
      if (!value) throw new Error("--query requires a value");
      args.query = value;
      i += 1;
    } else if (flag === "--max-per-bucket") {
      args.maxPerBucket = parseInteger(value, "--max-per-bucket");
      i += 1;
    } else if (flag === "--help" || flag === "-h") {
      console.log(storeUsage("preview-context"));
      process.exit(0);
    } else {
      throw new Error(`unknown preview-context argument: ${flag}`);
    }
  }
  return args;
}

function parseBackupArgs(argv: string[]): BackupArgs {
  const args: BackupArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--adapter") {
      args.adapter = parseAdapter(value);
      i += 1;
    } else if (flag === "--path") {
      if (!value) throw new Error("--path requires a value");
      args.path = value;
      i += 1;
    } else if (flag === "--output") {
      if (!value) throw new Error("--output requires a value");
      args.output = value;
      i += 1;
    } else if (flag === "--help" || flag === "-h") {
      console.log(storeUsage("backup"));
      process.exit(0);
    } else {
      throw new Error(`unknown backup argument: ${flag}`);
    }
  }
  return args;
}

function parseRestoreArgs(argv: string[]): RestoreArgs {
  const args: RestoreArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--adapter") {
      args.adapter = parseAdapter(value);
      i += 1;
    } else if (flag === "--path") {
      if (!value) throw new Error("--path requires a value");
      args.path = value;
      i += 1;
    } else if (flag === "--input") {
      if (!value) throw new Error("--input requires a value");
      args.input = value;
      i += 1;
    } else if (flag === "--overwrite") {
      args.overwrite = true;
    } else if (flag === "--help" || flag === "-h") {
      console.log(storeUsage("restore"));
      process.exit(0);
    } else {
      throw new Error(`unknown restore argument: ${flag}`);
    }
  }
  return args;
}

function parseCompactArgs(argv: string[]): CompactArgs {
  const args: CompactArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--adapter") {
      args.adapter = parseAdapter(value);
      i += 1;
    } else if (flag === "--path") {
      if (!value) throw new Error("--path requires a value");
      args.path = value;
      i += 1;
    } else if (flag === "--help" || flag === "-h") {
      console.log(storeUsage("compact"));
      process.exit(0);
    } else {
      throw new Error(`unknown compact argument: ${flag}`);
    }
  }
  return args;
}

function parseRuntimeImportArgs(argv: string[]): RuntimeImportArgs {
  const args: RuntimeImportArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--source") {
      if (!value) throw new Error("--source requires a value");
      args.source = value;
      i += 1;
    } else if (flag === "--target") {
      if (!value) throw new Error("--target requires a value");
      args.target = value;
      i += 1;
    } else if (flag === "--adapter") {
      args.adapter = parseAdapter(value);
      i += 1;
    } else if (flag === "--scope") {
      if (!value) throw new Error("--scope requires a value");
      args.scope = value;
      i += 1;
    } else if (flag === "--limit") {
      args.limit = parseInteger(value, "--limit");
      i += 1;
    } else if (flag === "--help" || flag === "-h") {
      console.log(runtimeImportUsage());
      process.exit(0);
    } else {
      throw new Error(`unknown import-runtime-snapshot argument: ${flag}`);
    }
  }
  return args;
}

function parseRuntimeLiveSidecarArgs(argv: string[]): RuntimeLiveSidecarArgs {
  const args: RuntimeLiveSidecarArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--source") {
      if (!value) throw new Error("--source requires a value");
      args.source = value;
      i += 1;
    } else if (flag === "--target") {
      if (!value) throw new Error("--target requires a value");
      args.target = value;
      i += 1;
    } else if (flag === "--adapter") {
      args.adapter = parseAdapter(value);
      i += 1;
    } else if (flag === "--checkpoint") {
      if (!value) throw new Error("--checkpoint requires a value");
      args.checkpoint = value;
      i += 1;
    } else if (flag === "--scope") {
      if (!value) throw new Error("--scope requires a value");
      args.scope = value;
      i += 1;
    } else if (flag === "--limit") {
      args.limit = parseInteger(value, "--limit");
      i += 1;
    } else if (flag === "--output") {
      if (!value) throw new Error("--output requires a value");
      args.output = value;
      i += 1;
    } else if (flag === "--dry-run") {
      args.dryRun = true;
    } else if (flag === "--watch") {
      args.watch = true;
    } else if (flag === "--iterations") {
      args.iterations = parseInteger(value, "--iterations");
      i += 1;
    } else if (flag === "--interval-ms") {
      args.intervalMs = parseInteger(value, "--interval-ms");
      i += 1;
    } else if (flag === "--lock") {
      if (!value) throw new Error("--lock requires a value");
      args.lock = value;
      i += 1;
    } else if (flag === "--no-lock") {
      args.lock = null;
    } else if (flag === "--help" || flag === "-h") {
      console.log(runtimeLiveSidecarUsage());
      process.exit(0);
    } else {
      throw new Error(`unknown live-sidecar argument: ${flag}`);
    }
  }
  return args;
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

async function runInspect(argv: string[]): Promise<void> {
  const args = parseInspectArgs(argv);
  const store = await openExistingStore(args);
  try {
    const info = await store.getStoreInfo();
    const report: Record<string, unknown> = {
      contract_version: "aionis_substrate_inspect_report_v1",
      store: {
        adapter: args.adapter,
        path: resolve(args.path ?? ""),
      },
      info,
    };
    if (args.scope) {
      const [nodes, relations, feedback, decisions] = await Promise.all([
        store.listNodes(args.scope),
        store.listRelations(args.scope),
        store.listFeedback({ scope: args.scope }),
        store.listDecisions(args.scope),
      ]);
      report.scope = args.scope;
      report.counts = {
        nodes: nodes.length,
        relations: relations.length,
        feedback: feedback.length,
        decisions: decisions.length,
      };
      report.nodes = nodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        lifecycle: node.lifecycle,
        authority: node.authority,
        confidence: node.confidence,
        targetFiles: node.targetFiles ?? [],
        payloadRef: node.payloadRef ?? null,
      }));
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await store.close();
  }
}

async function runPreviewContext(argv: string[]): Promise<void> {
  const args = parseContextArgs(argv);
  if (!args.scope) throw new Error("--scope is required");
  const store = await openExistingStore(args);
  try {
    const before = await store.getStoreInfo();
    const context = await store.previewContext({
      scope: args.scope,
      query: args.query,
      maxPerBucket: args.maxPerBucket,
    });
    const after = await store.getStoreInfo();
    console.log(JSON.stringify({
      contract_version: "aionis_substrate_preview_context_report_v1",
      read_only: before.lastSequence === after.lastSequence && before.eventCount === after.eventCount,
      context,
    }, null, 2));
  } finally {
    await store.close();
  }
}

async function runBackup(argv: string[]): Promise<void> {
  const args = parseBackupArgs(argv);
  if (!args.output) throw new Error("--output is required");
  const store = await openExistingStore(args);
  try {
    const backup = await exportAionisSubstrateBackup(store);
    const output = resolve(args.output);
    await writeAionisSubstrateBackupFile(output, backup);
    const verification = verifyAionisSubstrateBackup(backup);
    console.log(JSON.stringify({
      contract_version: "aionis_substrate_backup_export_report_v1",
      output,
      ok: verification.ok,
      eventCount: backup.eventCount,
      lastSequence: backup.lastSequence,
      eventsSha256: backup.checksum.eventsSha256,
      source: backup.source,
    }, null, 2));
    if (!verification.ok) process.exitCode = 1;
  } finally {
    await store.close();
  }
}

async function runRestore(argv: string[]): Promise<void> {
  const args = parseRestoreArgs(argv);
  if (!args.adapter) throw new Error("--adapter is required");
  if (!args.path) throw new Error("--path is required");
  if (!args.input) throw new Error("--input is required");
  const input = resolve(args.input);
  const target = resolve(args.path);
  const backup = await readAionisSubstrateBackupFile(input);
  const verification = verifyAionisSubstrateBackup(backup);
  if (!verification.ok) {
    console.log(JSON.stringify({
      contract_version: "aionis_substrate_restore_report_v1",
      input,
      target,
      adapter: args.adapter,
      restored: false,
      verification,
    }, null, 2));
    process.exitCode = 1;
    return;
  }
  const snapshot = args.adapter === "file"
    ? await restoreAionisSubstrateBackupToFile(backup, target, { overwrite: args.overwrite })
    : await restoreAionisSubstrateBackupToSqlite(backup, target, { overwrite: args.overwrite });
  console.log(JSON.stringify({
    contract_version: "aionis_substrate_restore_report_v1",
    input,
    target,
    adapter: args.adapter,
    restored: true,
    overwrite: args.overwrite === true,
    counts: {
      nodes: snapshot.nodes.length,
      relations: snapshot.relations.length,
      feedback: snapshot.feedback.length,
      decisions: snapshot.decisions.length,
      lastSequence: snapshot.lastSequence,
    },
  }, null, 2));
}

async function runCompact(argv: string[]): Promise<void> {
  const args = parseCompactArgs(argv);
  const store = await openExistingStore(args);
  try {
    const report = await store.compact();
    console.log(JSON.stringify({
      contract_version: "aionis_substrate_compaction_report_v1",
      store: {
        adapter: args.adapter,
        path: resolve(args.path ?? ""),
      },
      ...report,
    }, null, 2));
  } finally {
    await store.close();
  }
}

async function runRuntimeImport(argv: string[]): Promise<void> {
  const args = parseRuntimeImportArgs(argv);
  if (!args.source) throw new Error("--source is required");
  if (!args.target) throw new Error("--target is required");
  if (!args.adapter) throw new Error("--adapter is required");
  const store = await openTargetStore({
    adapter: args.adapter,
    path: args.target,
  });
  try {
    const summary = await importRuntimeLiteSnapshot({
      sourcePath: resolve(args.source),
      target: store,
      scope: args.scope,
      limit: args.limit,
    });
    console.log(JSON.stringify({
      contract_version: "aionis_runtime_lite_snapshot_import_summary_v1",
      target_adapter: args.adapter,
      target: resolve(args.target),
      ...summary,
    }, null, 2));
  } finally {
    await store.close();
  }
}

async function runRuntimeLiveSidecar(argv: string[]): Promise<void> {
  const args = parseRuntimeLiveSidecarArgs(argv);
  if (!args.source) throw new Error("--source is required");
  if (!args.target) throw new Error("--target is required");
  if (!args.adapter) throw new Error("--adapter is required");
  if (!args.checkpoint) throw new Error("--checkpoint is required");
  const store = await openTargetStore({
    adapter: args.adapter,
    path: args.target,
  });
  try {
    if (args.watch) {
      if (args.iterations === undefined) throw new Error("--iterations is required with --watch");
      const report = await runRuntimeLiveSidecarWatch({
        sourcePath: resolve(args.source),
        target: store,
        checkpointPath: resolve(args.checkpoint),
        scope: args.scope,
        limit: args.limit,
        dryRun: args.dryRun,
        intervalMs: args.intervalMs ?? 5000,
        iterations: args.iterations,
        lockPath: args.lock,
      });
      if (args.output) {
        const output = resolve(args.output);
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      }
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const report = await runRuntimeLiveSidecarOnce({
      sourcePath: resolve(args.source),
      target: store,
      checkpointPath: resolve(args.checkpoint),
      scope: args.scope,
      limit: args.limit,
      dryRun: args.dryRun,
    });
    if (args.output) {
      const output = resolve(args.output);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await store.close();
  }
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
  if (command === "import-runtime-snapshot") {
    await runRuntimeImport(argv.slice(1));
    return;
  }
  if (command === "live-sidecar") {
    await runRuntimeLiveSidecar(argv.slice(1));
    return;
  }
  if (command === "inspect") {
    await runInspect(argv.slice(1));
    return;
  }
  if (command === "preview-context") {
    await runPreviewContext(argv.slice(1));
    return;
  }
  if (command === "backup") {
    await runBackup(argv.slice(1));
    return;
  }
  if (command === "restore") {
    await runRestore(argv.slice(1));
    return;
  }
  if (command === "compact") {
    await runCompact(argv.slice(1));
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
