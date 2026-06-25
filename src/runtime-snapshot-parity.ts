import { mkdtemp, readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  importRuntimeLiteSnapshot,
  type RuntimeSnapshotImportSummary,
} from "./runtime-snapshot-importer.ts";
import { openSqliteAionisSubstrate } from "./sqlite-substrate.ts";
import type {
  AionisAdmissionAction,
  AionisCompiledContext,
  AionisSubstrate,
} from "./types.ts";

export type RuntimeReferenceSurfaces = Record<AionisAdmissionAction, string[]>;

export type RuntimeSnapshotParityBucket = {
  bucket: AionisAdmissionAction;
  substrate: string[];
  runtimeReference: string[];
  matched: string[];
  missingFromSubstrate: string[];
  extraInSubstrate: string[];
  exact: boolean;
};

export type RuntimeSnapshotParityReport = {
  contract_version: "aionis_runtime_snapshot_parity_report_v1";
  source_path: string;
  scope: string;
  generated_at: string;
  import_summary: RuntimeSnapshotImportSummary;
  substrate_context: RuntimeReferenceSurfaces;
  reference_present: boolean;
  reference_source_path: string | null;
  runtime_reference: RuntimeReferenceSurfaces | null;
  parity: {
    exact: boolean | null;
    bucket_reports: RuntimeSnapshotParityBucket[];
  };
  notes: string[];
};

export type RuntimeSnapshotParityOptions = {
  sourcePath: string;
  scope: string;
  referencePath?: string;
  targetPath?: string;
  outputPath?: string;
  maxPerBucket?: number;
};

function emptySurfaces(): RuntimeReferenceSurfaces {
  return {
    use_now: [],
    inspect_before_use: [],
    do_not_use: [],
    rehydrate: [],
  };
}

function uniqueStrings(values: unknown[]): string[] {
  return Array.from(new Set(values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean)));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? uniqueStrings(value) : [];
}

function rehydrateIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      ids.push(item);
      continue;
    }
    const record = asRecord(item);
    const id = record?.memory_id ?? record?.memoryId ?? record?.id;
    if (typeof id === "string") ids.push(id);
  }
  return uniqueStrings(ids);
}

function mergeSurfaces(target: RuntimeReferenceSurfaces, source: Partial<RuntimeReferenceSurfaces>): void {
  for (const bucket of Object.keys(target) as AionisAdmissionAction[]) {
    target[bucket] = uniqueStrings([...(target[bucket] ?? []), ...((source[bucket] ?? []) as string[])]);
  }
}

function findNestedRecords(value: unknown, key: string, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  const record = asRecord(value);
  if (record) {
    const candidate = asRecord(record[key]);
    if (candidate) out.push(candidate);
    for (const nested of Object.values(record)) {
      findNestedRecords(nested, key, out);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) findNestedRecords(item, key, out);
  }
  return out;
}

function surfacesFromAgentContext(agentContext: Record<string, unknown>): RuntimeReferenceSurfaces {
  return {
    use_now: stringArray(agentContext.use_now_memory_ids),
    inspect_before_use: stringArray(agentContext.inspect_before_use_memory_ids),
    do_not_use: stringArray(agentContext.do_not_use_memory_ids),
    rehydrate: uniqueStrings([
      ...stringArray(agentContext.rehydrate_memory_ids),
      ...rehydrateIds(agentContext.rehydrate_hints),
    ]),
  };
}

function surfacesFromDecisionTrace(trace: Record<string, unknown>): RuntimeReferenceSurfaces {
  const surfaces = emptySurfaces();
  const decisions = Array.isArray(trace.memory_decisions) ? trace.memory_decisions : [];
  for (const item of decisions) {
    const decision = asRecord(item);
    if (!decision) continue;
    const memoryId = decision.memory_id ?? decision.memoryId;
    const surface = decision.agent_surface ?? decision.admission_action;
    if (typeof memoryId !== "string" || typeof surface !== "string") continue;
    if (surface === "use_now" || surface === "inspect_before_use" || surface === "do_not_use" || surface === "rehydrate") {
      surfaces[surface].push(memoryId);
    }
  }
  for (const bucket of Object.keys(surfaces) as AionisAdmissionAction[]) {
    surfaces[bucket] = uniqueStrings(surfaces[bucket]);
  }
  return surfaces;
}

export function extractRuntimeReferenceSurfaces(value: unknown): RuntimeReferenceSurfaces {
  const surfaces = emptySurfaces();
  const root = asRecord(value);
  if (root) {
    if (
      Array.isArray(root.use_now_memory_ids)
      || Array.isArray(root.inspect_before_use_memory_ids)
      || Array.isArray(root.do_not_use_memory_ids)
      || Array.isArray(root.rehydrate_hints)
    ) {
      mergeSurfaces(surfaces, surfacesFromAgentContext(root));
    }
    if (Array.isArray(root.memory_decisions)) {
      mergeSurfaces(surfaces, surfacesFromDecisionTrace(root));
    }
  }
  for (const agentContext of findNestedRecords(value, "agent_context")) {
    mergeSurfaces(surfaces, surfacesFromAgentContext(agentContext));
  }
  for (const trace of findNestedRecords(value, "memory_decision_trace")) {
    mergeSurfaces(surfaces, surfacesFromDecisionTrace(trace));
  }
  return surfaces;
}

function contextSurfaces(context: AionisCompiledContext): RuntimeReferenceSurfaces {
  return {
    use_now: context.use_now.map((node) => node.id),
    inspect_before_use: context.inspect_before_use.map((node) => node.id),
    do_not_use: context.do_not_use.map((node) => node.id),
    rehydrate: context.rehydrate.map((node) => node.id),
  };
}

function sorted(values: string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function bucketReport(bucket: AionisAdmissionAction, substrate: string[], runtimeReference: string[]): RuntimeSnapshotParityBucket {
  const substrateSet = new Set(substrate);
  const referenceSet = new Set(runtimeReference);
  const matched = sorted(runtimeReference.filter((id) => substrateSet.has(id)));
  const missingFromSubstrate = sorted(runtimeReference.filter((id) => !substrateSet.has(id)));
  const extraInSubstrate = sorted(substrate.filter((id) => !referenceSet.has(id)));
  return {
    bucket,
    substrate: sorted(substrate),
    runtimeReference: sorted(runtimeReference),
    matched,
    missingFromSubstrate,
    extraInSubstrate,
    exact: missingFromSubstrate.length === 0 && extraInSubstrate.length === 0,
  };
}

export function compareSurfaces(
  substrate: RuntimeReferenceSurfaces,
  runtimeReference: RuntimeReferenceSurfaces,
): RuntimeSnapshotParityBucket[] {
  return (Object.keys(substrate) as AionisAdmissionAction[]).map((bucket) =>
    bucketReport(bucket, substrate[bucket], runtimeReference[bucket]));
}

async function readReference(path: string): Promise<RuntimeReferenceSurfaces> {
  const parsed = JSON.parse(await readFile(path, "utf8"));
  return extractRuntimeReferenceSurfaces(parsed);
}

async function openTarget(options: RuntimeSnapshotParityOptions): Promise<{
  store: AionisSubstrate;
  targetPath: string;
  cleanup: () => Promise<void>;
}> {
  if (options.targetPath) {
    const targetPath = resolve(options.targetPath);
    await mkdir(dirname(targetPath), { recursive: true });
    return { store: await openSqliteAionisSubstrate({ path: targetPath }), targetPath, cleanup: async () => undefined };
  }
  const dir = await mkdtemp(join(tmpdir(), "aionis-substrate-parity-"));
  const targetPath = join(dir, "substrate.sqlite");
  return {
    store: await openSqliteAionisSubstrate({ path: targetPath }),
    targetPath,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function runRuntimeSnapshotParity(options: RuntimeSnapshotParityOptions): Promise<RuntimeSnapshotParityReport> {
  const sourcePath = resolve(options.sourcePath);
  const { store, targetPath, cleanup } = await openTarget(options);
  try {
    const importSummary = await importRuntimeLiteSnapshot({
      sourcePath,
      target: store,
      scope: options.scope,
    });
    const context = await store.compileContext({
      scope: options.scope,
      query: "runtime snapshot parity",
      maxPerBucket: options.maxPerBucket,
    });
    const substrateContext = contextSurfaces(context);
    const runtimeReference = options.referencePath ? await readReference(resolve(options.referencePath)) : null;
    const bucketReports = runtimeReference ? compareSurfaces(substrateContext, runtimeReference) : [];
    const exact = runtimeReference ? bucketReports.every((bucket) => bucket.exact) : null;
    const report: RuntimeSnapshotParityReport = {
      contract_version: "aionis_runtime_snapshot_parity_report_v1",
      source_path: sourcePath,
      scope: options.scope,
      generated_at: new Date().toISOString(),
      import_summary: importSummary,
      substrate_context: substrateContext,
      reference_present: runtimeReference !== null,
      reference_source_path: options.referencePath ? resolve(options.referencePath) : null,
      runtime_reference: runtimeReference,
      parity: {
        exact,
        bucket_reports: bucketReports,
      },
      notes: [
        `source Runtime SQLite was imported read-only into ${targetPath}`,
        runtimeReference
          ? "parity compares Substrate compileContext buckets with supplied Runtime agent_context/memory_decision_trace JSON"
          : "no Runtime reference JSON supplied; report is import coverage plus Substrate context smoke",
      ],
    };
    if (options.outputPath) {
      const outputPath = resolve(options.outputPath);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    return report;
  } finally {
    await store.close();
    await cleanup();
  }
}
