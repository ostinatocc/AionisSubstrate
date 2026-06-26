import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { openSqliteAionisSubstrate, type AionisSubstrate } from "../src/index.ts";

type ScaleOptions = {
  nodes: number;
  scopes: number;
  relations: number;
  feedback: number;
  output?: string;
  keepStore: boolean;
};

type Timings = Record<string, number>;

function readArg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1] ?? fallback;
  return fallback;
}

function readNumber(name: string, fallback: number): number {
  const raw = readArg(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
}

function parseOptions(): ScaleOptions {
  const nodes = readNumber("nodes", 10_000);
  const scopes = readNumber("scopes", 10);
  return {
    nodes,
    scopes,
    relations: readNumber("relations", Math.max(1, Math.floor(nodes / 5))),
    feedback: readNumber("feedback", Math.max(1, Math.floor(nodes / 10))),
    output: readArg("output"),
    keepStore: process.argv.includes("--keep-store"),
  };
}

async function time<T>(timings: Timings, name: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    timings[name] = Math.round(performance.now() - start);
  }
}

function memoryId(scopeIndex: number, localIndex: number): string {
  return `scope-${scopeIndex}-mem-${localIndex}`;
}

async function getFileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}

async function writeNodes(store: AionisSubstrate, options: ScaleOptions): Promise<void> {
  const perScope = Math.ceil(options.nodes / options.scopes);
  let written = 0;
  for (let scopeIndex = 0; scopeIndex < options.scopes && written < options.nodes; scopeIndex += 1) {
    for (let localIndex = 0; localIndex < perScope && written < options.nodes; localIndex += 1) {
      const globalIndex = written;
      const archived = globalIndex % 19 === 0;
      const candidate = !archived && globalIndex % 7 === 0;
      await store.putNode({
        id: memoryId(scopeIndex, localIndex),
        scope: `scope-${scopeIndex}`,
        kind: archived ? "trace_pointer" : candidate ? "claim" : globalIndex % 5 === 0 ? "fact" : "procedure",
        title: `Memory ${globalIndex}`,
        summary: `Runtime verifier memory ${globalIndex} for module-${globalIndex % 97} and target-${globalIndex % 31}.`,
        lifecycle: archived ? "archived" : candidate ? "candidate" : "active",
        authority: archived || !candidate ? "trusted" : "advisory",
        confidence: archived ? 0.88 : candidate ? 0.55 : 0.65 + ((globalIndex % 30) / 100),
        targetFiles: [`src/module-${globalIndex % 97}.ts`],
        payloadRef: archived ? `file://traces/${globalIndex}.log` : null,
        agentId: `agent-${globalIndex % 4}`,
        teamId: `team-${globalIndex % 3}`,
        metadata: {
          batch: "scale",
          module: `module-${globalIndex % 97}`,
        },
        createdAt: new Date(Date.UTC(2026, 5, 1, 0, 0, globalIndex % 60)).toISOString(),
        updatedAt: new Date(Date.UTC(2026, 5, 1, 0, Math.floor(globalIndex / 60), globalIndex % 60)).toISOString(),
      });
      written += 1;
    }
  }
}

async function writeRelations(store: AionisSubstrate, options: ScaleOptions): Promise<number> {
  const perScope = Math.ceil(options.nodes / options.scopes);
  let written = 0;
  for (let index = 0; index < options.relations; index += 1) {
    const scopeIndex = index % options.scopes;
    const sourceLocal = (index * 17) % perScope;
    const targetLocal = (sourceLocal + 1) % perScope;
    if ((scopeIndex * perScope) + Math.max(sourceLocal, targetLocal) >= options.nodes) continue;
    await store.putRelation({
      id: `rel-${index}`,
      scope: `scope-${scopeIndex}`,
      kind: index % 3 === 0 ? "supersedes" : index % 3 === 1 ? "supports" : "requires_payload",
      sourceId: memoryId(scopeIndex, sourceLocal),
      targetId: memoryId(scopeIndex, targetLocal),
      confidence: 0.72,
      reasons: ["scale relation probe"],
    });
    written += 1;
  }
  return written;
}

async function writeFeedback(store: AionisSubstrate, options: ScaleOptions): Promise<number> {
  const perScope = Math.ceil(options.nodes / options.scopes);
  let written = 0;
  for (let index = 0; index < options.feedback; index += 1) {
    const scopeIndex = index % options.scopes;
    const localIndex = (index * 23) % perScope;
    if ((scopeIndex * perScope) + localIndex >= options.nodes) continue;
    await store.recordFeedback({
      id: `feedback-${index}`,
      scope: `scope-${scopeIndex}`,
      memoryId: memoryId(scopeIndex, localIndex),
      outcome: index % 5 === 0 ? "negative" : "positive",
      strength: index % 5 === 0 ? "weak" : "strong",
      runId: `run-${index}`,
      evidenceRef: `trace://scale/${index}`,
    });
    written += 1;
  }
  return written;
}

async function main(): Promise<void> {
  const options = parseOptions();
  const timings: Timings = {};
  const tempDir = await mkdtemp(join(tmpdir(), "aionis-substrate-scale-"));
  const reportDir = options.output ?? join("reports", `scale-${new Date().toISOString().replaceAll(":", "-")}`);
  const sqlitePath = join(tempDir, "substrate.sqlite");
  let store: AionisSubstrate | null = null;

  try {
    await mkdir(reportDir, { recursive: true });
    store = await openSqliteAionisSubstrate({ path: sqlitePath });

    await time(timings, "write_nodes_ms", async () => writeNodes(store!, options));
    const relationCount = await time(timings, "write_relations_ms", async () => writeRelations(store!, options));
    const feedbackCount = await time(timings, "write_feedback_ms", async () => writeFeedback(store!, options));

    const eventInfoBefore = await time(timings, "list_events_before_compact_ms", async () => store!.listEvents());
    const eventSequenceContiguous = eventInfoBefore.every((event, index) => event.sequence === index + 1);

    const searchResults = await time(timings, "search_ms", async () => store!.searchNodes({
      scope: "scope-0",
      query: "runtime verifier module-7",
      targetFiles: ["src/module-7.ts"],
      limit: 20,
    }));

    const context = await time(timings, "compile_context_ms", async () => store!.compileContext({
      scope: "scope-0",
      query: "continue runtime verifier work",
      maxPerBucket: 50,
    }));

    const sqliteBytesBeforeCompact = await getFileSize(sqlitePath);
    const compaction = await time(timings, "compact_ms", async () => store!.compact());
    const sqliteBytesAfterCompact = await getFileSize(sqlitePath);
    await store.close();
    store = null;

    store = await time(timings, "reopen_ms", async () => openSqliteAionisSubstrate({ path: sqlitePath }));
    const reopenedContext = await time(timings, "reopened_compile_context_ms", async () => store!.compileContext({
      scope: "scope-0",
      query: "continue runtime verifier work",
      maxPerBucket: 50,
    }));
    const reopenedInfo = await store.getStoreInfo();

    const report = {
      benchmark: "aionis_substrate_scale",
      generated_at: new Date().toISOString(),
      adapter: "sqlite",
      requested: options,
      actual: {
        nodes: options.nodes,
        relations: relationCount,
        feedback: feedbackCount,
        events_before_compact: eventInfoBefore.length,
        event_sequence_contiguous: eventSequenceContiguous,
        search_result_count: searchResults.length,
        context_bucket_counts: {
          use_now: context.use_now.length,
          inspect_before_use: context.inspect_before_use.length,
          do_not_use: context.do_not_use.length,
          rehydrate: context.rehydrate.length,
        },
        reopened_context_bucket_counts: {
          use_now: reopenedContext.use_now.length,
          inspect_before_use: reopenedContext.inspect_before_use.length,
          do_not_use: reopenedContext.do_not_use.length,
          rehydrate: reopenedContext.rehydrate.length,
        },
        compaction,
        reopened_store_info: reopenedInfo,
        sqlite_bytes_before_compact: sqliteBytesBeforeCompact,
        sqlite_bytes_after_compact: sqliteBytesAfterCompact,
      },
      timings,
    };

    const reportPath = join(reportDir, "summary.json");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      report: reportPath,
      nodes: options.nodes,
      relations: relationCount,
      feedback: feedbackCount,
      events_before_compact: eventInfoBefore.length,
      event_sequence_contiguous: eventSequenceContiguous,
      search_result_count: searchResults.length,
      sqlite_bytes_before_compact: sqliteBytesBeforeCompact,
      sqlite_bytes_after_compact: sqliteBytesAfterCompact,
      timings,
    }, null, 2));
  } finally {
    if (store) await store.close().catch(() => undefined);
    if (!options.keepStore) await rm(tempDir, { recursive: true, force: true });
  }
}

await main();
