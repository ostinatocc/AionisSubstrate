import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

type Args = {
  outputDir: string;
  workdir: string | null;
  keepWorkdir: boolean;
  port: number | null;
  provider: "none" | "openai" | "minimax" | "dashscope";
  runtimePackage: string;
  claudeModel: string | null;
  claudeTimeoutMs: number;
};

type CommandResult = {
  command: string;
  cwd: string;
  exit_code: number;
  duration_ms: number;
  stdout_path: string;
  stderr_path: string;
};

type GuideResult = {
  guide_trace_id: string | null;
  use_now_memory_ids: string[];
  inspect_before_use_memory_ids: string[];
  do_not_use_memory_ids: string[];
  source_memory_id?: string;
  run_id?: string | null;
  prompt_char_count?: number | null;
  history_used?: boolean | null;
  actionable_history_used?: boolean | null;
};

type ClaudeSessionReport = {
  name: string;
  prompt_summary: string;
  command: CommandResult;
  test_after: CommandResult;
  result_summary: Record<string, unknown>;
};

type EvidencePackReport = {
  contract_version: "aionis_claude_code_real_flow_evidence_pack_v1";
  generated_at: string;
  run_root: string;
  project_dir: string;
  runtime_dir: string;
  base_url: string;
  scope: string;
  provider: string;
  runtime_package: string;
  claude_model: string | null;
  sessions: ClaudeSessionReport[];
  guide_before_second_session: GuideResult;
  feedback: {
    submitted: boolean;
    skipped_reason: string | null;
    used_memory_ids: string[];
    result: Record<string, unknown> | null;
  };
  measure: Record<string, unknown> | null;
  substrate_report: {
    output_dir: string;
    passed: boolean;
    total_nodes_imported: number;
    total_feedback_imported: number;
    total_feedback_slot_nodes_imported: number;
    total_relations_imported: number;
    total_decisions_imported: number;
  } | null;
  gates: {
    first_session_tests_passed: boolean;
    second_session_tests_passed: boolean;
    guide_exposed_memory: boolean;
    feedback_attributed: boolean;
    substrate_imported_runtime_nodes: boolean;
    substrate_imported_feedback: boolean;
  };
  caveats: string[];
};

function usage(): string {
  return [
    "Aionis Claude Code real-flow evidence pack",
    "",
    "Usage:",
    "  node scripts/claude-code-real-flow-evidence-pack.ts [options]",
    "",
    "Options:",
    "  --output-dir <path>       Report directory. Defaults to reports/claude-code-real-flow-*.",
    "  --workdir <path>          Isolated run directory. Defaults to a temporary directory.",
    "  --keep-workdir            Keep the temporary isolated run directory.",
    "  --port <n>                Runtime port. Defaults to a free local port.",
    "  --provider <name>         none | openai | minimax | dashscope. Default: none.",
    "  --runtime-package <spec>  npm package spec for the product CLI. Default: aionis@latest.",
    "  --claude-model <name>     Optional Claude Code --model value.",
    "  --claude-timeout-ms <n>   Per-session timeout. Default: 900000.",
  ].join("\n");
}

function parsePositiveInteger(raw: string | undefined, label: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function parseArgs(argv = process.argv.slice(2)): Args {
  const args: Args = {
    outputDir: resolve("reports", `claude-code-real-flow-${new Date().toISOString().replace(/[:.]/g, "-")}`),
    workdir: null,
    keepWorkdir: false,
    port: null,
    provider: "none",
    runtimePackage: "aionis@latest",
    claudeModel: process.env.CLAUDE_CODE_MODEL?.trim() || null,
    claudeTimeoutMs: 900_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--output-dir") {
      if (!value) throw new Error("--output-dir requires a value");
      args.outputDir = resolve(value);
      i += 1;
    } else if (flag === "--workdir") {
      if (!value) throw new Error("--workdir requires a value");
      args.workdir = resolve(value);
      i += 1;
    } else if (flag === "--keep-workdir") {
      args.keepWorkdir = true;
    } else if (flag === "--port") {
      args.port = parsePositiveInteger(value, "--port");
      i += 1;
    } else if (flag === "--provider") {
      if (value !== "none" && value !== "openai" && value !== "minimax" && value !== "dashscope") {
        throw new Error("--provider must be one of: none, openai, minimax, dashscope");
      }
      args.provider = value;
      i += 1;
    } else if (flag === "--runtime-package") {
      if (!value) throw new Error("--runtime-package requires a value");
      args.runtimePackage = value;
      i += 1;
    } else if (flag === "--claude-model") {
      if (!value) throw new Error("--claude-model requires a value");
      args.claudeModel = value;
      i += 1;
    } else if (flag === "--claude-timeout-ms") {
      args.claudeTimeoutMs = parsePositiveInteger(value, "--claude-timeout-ms");
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

async function freePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        server.close(() => reject(new Error("could not allocate a local port")));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

function commandText(command: string, args: string[]): string {
  return [command, ...args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))].join(" ");
}

async function runCommand(options: {
  command: string;
  args: string[];
  cwd: string;
  stdoutPath: string;
  stderrPath: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  allowFailure?: boolean;
}): Promise<CommandResult> {
  await mkdir(dirname(options.stdoutPath), { recursive: true });
  await mkdir(dirname(options.stderrPath), { recursive: true });
  const startedAt = Date.now();
  const stdout = createWriteStream(options.stdoutPath, { flags: "w" });
  const stderr = createWriteStream(options.stderrPath, { flags: "w" });
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);

  const exitCode = await new Promise<number>((resolveExit, reject) => {
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      }, options.timeoutMs)
      : null;
    child.once("error", reject);
    child.once("close", (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`command timed out after ${options.timeoutMs}ms: ${commandText(options.command, options.args)}`));
        return;
      }
      resolveExit(code ?? 1);
    });
  });
  await new Promise<void>((resolveDone) => stdout.end(resolveDone));
  await new Promise<void>((resolveDone) => stderr.end(resolveDone));

  const result: CommandResult = {
    command: commandText(options.command, options.args),
    cwd: options.cwd,
    exit_code: exitCode,
    duration_ms: Date.now() - startedAt,
    stdout_path: options.stdoutPath,
    stderr_path: options.stderrPath,
  };
  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(`command failed with exit code ${exitCode}: ${result.command}\nstdout: ${options.stdoutPath}\nstderr: ${options.stderrPath}`);
  }
  return result;
}

async function startRuntime(runtimeDir: string, logDir: string): Promise<ChildProcess> {
  await mkdir(logDir, { recursive: true });
  const stdout = createWriteStream(join(logDir, "runtime.stdout.log"), { flags: "w" });
  const stderr = createWriteStream(join(logDir, "runtime.stderr.log"), { flags: "w" });
  const child = spawn("npm", ["run", "-s", "lite:start"], {
    cwd: runtimeDir,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(stdout);
  child.stderr?.pipe(stderr);
  return child;
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
  }
  throw new Error(`Runtime did not become healthy at ${baseUrl}: ${String(lastError)}`);
}

async function postJson<T>(baseUrl: string, path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function summarizeGuide(guide: unknown): GuideResult {
  const guideRecord = asRecord(guide);
  const context = asRecord(guideRecord.agent_context);
  return {
    guide_trace_id: typeof guideRecord.guide_trace_id === "string" ? guideRecord.guide_trace_id : null,
    use_now_memory_ids: stringArray(context.use_now_memory_ids),
    inspect_before_use_memory_ids: stringArray(context.inspect_before_use_memory_ids),
    do_not_use_memory_ids: stringArray(context.do_not_use_memory_ids),
  };
}

async function installRuntime(args: Args, runRoot: string, projectDir: string, baseUrl: string, logDir: string): Promise<CommandResult> {
  const runtimeDir = join(runRoot, "runtime");
  const setupArgs = [
    "exec",
    "--yes",
    "--package",
    args.runtimePackage,
    "--",
    "aionis",
    "setup",
    "--dir",
    runtimeDir,
    "--provider",
    args.provider,
    "--yes",
    "--with-claude-code",
    "--claude-code-dir",
    projectDir,
    "--claude-code-base-url",
    baseUrl,
    "--claude-code-scope-from",
    "workspace",
    "--claude-code-mcp-name",
    "aionis-real-flow",
  ];
  return await runCommand({
    command: "npm",
    args: setupArgs,
    cwd: runRoot,
    stdoutPath: join(logDir, "setup.stdout.log"),
    stderrPath: join(logDir, "setup.stderr.log"),
    timeoutMs: 600_000,
  });
}

async function resolveClaudeScope(projectDir: string, baseUrl: string, logDir: string): Promise<string> {
  const result = await runCommand({
    command: "npm",
    args: [
      "exec",
      "--yes",
      "--package",
      "@aionis/claude-code@latest",
      "--",
      "aionis-claude-code",
      "doctor",
      "--base-url",
      baseUrl,
      "--scope-from",
      "workspace",
      "--workspace-id-store",
      "project",
      "--mcp-name",
      "aionis-real-flow",
    ],
    cwd: projectDir,
    stdoutPath: join(logDir, "doctor.stdout.json"),
    stderrPath: join(logDir, "doctor.stderr.log"),
    timeoutMs: 120_000,
    allowFailure: true,
  });
  if (result.exit_code !== 0) return "default";
  const raw = await readFile(result.stdout_path, "utf8");
  try {
    const parsed = JSON.parse(raw) as { scope?: unknown };
    return typeof parsed.scope === "string" && parsed.scope.length > 0 ? parsed.scope : "default";
  } catch {
    return "default";
  }
}

async function walkSqliteFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(path: string): Promise<void> {
    const info = await stat(path);
    if (info.isDirectory()) {
      const entries = await readdir(path);
      for (const entry of entries) await visit(join(path, entry));
      return;
    }
    if (info.isFile() && (path.endsWith(".sqlite") || path.endsWith(".db"))) out.push(path);
  }
  try {
    await visit(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return out.sort();
}

function sqliteTableExists(db: DatabaseSync, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { name?: string } | undefined;
  return row?.name === table;
}

async function resolveRuntimeEvidenceScope(runtimeDir: string, preferredScope: string): Promise<string> {
  const counts = new Map<string, number>();
  for (const path of await walkSqliteFiles(runtimeDir)) {
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      if (!sqliteTableExists(db, "lite_memory_nodes")) continue;
      const rows = db.prepare(`
        SELECT scope, COUNT(*) AS count
        FROM lite_memory_nodes
        GROUP BY scope
      `).all() as Array<{ scope: string; count: number }>;
      for (const row of rows) {
        counts.set(row.scope, (counts.get(row.scope) ?? 0) + row.count);
      }
    } catch {
      // Ignore non-Runtime SQLite files; this is a scope discovery helper.
    } finally {
      db?.close();
    }
  }
  if ((counts.get(preferredScope) ?? 0) > 0) return preferredScope;
  const ranked = Array.from(counts.entries()).sort((left, right) => {
    const byCount = right[1] - left[1];
    if (byCount !== 0) return byCount;
    return left[0].localeCompare(right[0]);
  });
  return ranked[0]?.[0] ?? preferredScope;
}

async function createTicketLedgerProject(projectDir: string): Promise<void> {
  await mkdir(join(projectDir, "src"), { recursive: true });
  await mkdir(join(projectDir, "test"), { recursive: true });
  await writeFile(join(projectDir, "package.json"), `${JSON.stringify({
    type: "module",
    scripts: {
      test: "node --test test/*.test.mjs",
    },
  }, null, 2)}\n`, "utf8");
  await writeFile(join(projectDir, "src", "ticket-ledger.mjs"), `export function createTicketLedger(initialTickets = []) {
  const tickets = new Map();
  for (const ticket of initialTickets) {
    tickets.set(ticket.id, {
      id: ticket.id,
      title: ticket.title,
      status: ticket.status ?? "open",
      assignee: ticket.assignee ?? "unassigned",
      history: Array.isArray(ticket.history) ? [...ticket.history] : [],
    });
  }

  function requireTicket(id) {
    const ticket = tickets.get(id);
    if (!ticket) throw new Error(\`unknown ticket: \${id}\`);
    return ticket;
  }

  return {
    openTicket(id, title, assignee = "unassigned") {
      if (tickets.has(id)) throw new Error(\`ticket already exists: \${id}\`);
      tickets.set(id, { id, title, assignee, status: "open", history: ["opened"] });
      return this.getTicket(id);
    },

    resolveTicket(id, note = "resolved") {
      const ticket = requireTicket(id);
      ticket.status = "resolved";
      ticket.history.push(note);
      return this.getTicket(id);
    },

    reopenTicket(id, note = "reopened") {
      const ticket = requireTicket(id);
      ticket.status = "open";
      ticket.history = [note];
      return this.getTicket(id);
    },

    listOpenTickets() {
      return Array.from(tickets.values()).filter((ticket) => ticket.status !== "closed");
    },

    getTicket(id) {
      const ticket = requireTicket(id);
      return { ...ticket, history: [...ticket.history] };
    },

    snapshot() {
      return Array.from(tickets.values());
    },
  };
}
`, "utf8");
  await writeFile(join(projectDir, "test", "ticket-ledger.test.mjs"), `import assert from "node:assert/strict";
import { test } from "node:test";
import { createTicketLedger } from "../src/ticket-ledger.mjs";

test("resolved tickets are not listed as open", () => {
  const ledger = createTicketLedger([{ id: "A-1", title: "Fix queue replay", assignee: "worker-1" }]);
  ledger.resolveTicket("A-1", "unit tests passed");
  assert.deepEqual(ledger.listOpenTickets(), []);
});

test("reopen keeps earlier history and appends the reopen note", () => {
  const ledger = createTicketLedger([{ id: "A-2", title: "Add audit explanation" }]);
  ledger.resolveTicket("A-2", "first fix passed");
  const reopened = ledger.reopenTicket("A-2", "regression found");
  assert.deepEqual(reopened.history, ["first fix passed", "regression found"]);
  assert.equal(reopened.status, "open");
});

test("snapshots do not leak mutable ticket references", () => {
  const ledger = createTicketLedger([{ id: "A-3", title: "Protect snapshots" }]);
  const snapshot = ledger.snapshot();
  snapshot[0].status = "resolved";
  assert.equal(ledger.getTicket("A-3").status, "open");
});
`, "utf8");
  await runCommand({
    command: "git",
    args: ["init"],
    cwd: projectDir,
    stdoutPath: join(projectDir, ".git-init.stdout.log"),
    stderrPath: join(projectDir, ".git-init.stderr.log"),
    timeoutMs: 60_000,
  });
  await runCommand({
    command: "git",
    args: ["config", "user.email", "aionis-real-flow@example.local"],
    cwd: projectDir,
    stdoutPath: join(projectDir, ".git-config-email.stdout.log"),
    stderrPath: join(projectDir, ".git-config-email.stderr.log"),
    timeoutMs: 60_000,
  });
  await runCommand({
    command: "git",
    args: ["config", "user.name", "Aionis Real Flow"],
    cwd: projectDir,
    stdoutPath: join(projectDir, ".git-config-name.stdout.log"),
    stderrPath: join(projectDir, ".git-config-name.stderr.log"),
    timeoutMs: 60_000,
  });
  await runCommand({
    command: "git",
    args: ["add", "."],
    cwd: projectDir,
    stdoutPath: join(projectDir, ".git-add.stdout.log"),
    stderrPath: join(projectDir, ".git-add.stderr.log"),
    timeoutMs: 60_000,
  });
  await runCommand({
    command: "git",
    args: ["commit", "-m", "Add ticket ledger acceptance tests"],
    cwd: projectDir,
    stdoutPath: join(projectDir, ".git-commit.stdout.log"),
    stderrPath: join(projectDir, ".git-commit.stderr.log"),
    timeoutMs: 60_000,
  });
}

async function addSecondSessionAcceptanceTest(projectDir: string): Promise<void> {
  await writeFile(join(projectDir, "test", "ticket-explain.test.mjs"), `import assert from "node:assert/strict";
import { test } from "node:test";
import { createTicketLedger, explainTicket } from "../src/ticket-ledger.mjs";

test("explainTicket returns an audit-safe summary for handoff", () => {
  const ledger = createTicketLedger([{ id: "A-9", title: "Document active route", assignee: "reviewer-1" }]);
  ledger.resolveTicket("A-9", "verified with node --test");
  const explanation = explainTicket(ledger.getTicket("A-9"));
  assert.equal(explanation.id, "A-9");
  assert.equal(explanation.status, "resolved");
  assert.equal(explanation.assignee, "reviewer-1");
  assert.match(explanation.summary, /Document active route/);
  assert.match(explanation.summary, /verified with node --test/);
  assert.deepEqual(explanation.history, ["verified with node --test"]);
});
`, "utf8");
}

async function runClaudeSession(args: Args, session: {
  name: string;
  prompt: string;
  promptSummary: string;
  projectDir: string;
  logDir: string;
}): Promise<ClaudeSessionReport> {
  const commandArgs = [
    "-p",
    session.prompt,
    "--permission-mode",
    "bypassPermissions",
    "--allowedTools",
    "Read,Edit,Write,Bash",
    "--include-hook-events",
    "--output-format",
    "stream-json",
    "--verbose",
    "--debug-file",
    join(session.logDir, `${session.name}.debug.log`),
  ];
  if (args.claudeModel) commandArgs.push("--model", args.claudeModel);
  const command = await runCommand({
    command: "claude",
    args: commandArgs,
    cwd: session.projectDir,
    stdoutPath: join(session.logDir, `${session.name}.jsonl`),
    stderrPath: join(session.logDir, `${session.name}.stderr.log`),
    timeoutMs: args.claudeTimeoutMs,
  });
  const testAfter = await runCommand({
    command: "npm",
    args: ["test"],
    cwd: session.projectDir,
    stdoutPath: join(session.logDir, `${session.name}.npm-test.stdout.log`),
    stderrPath: join(session.logDir, `${session.name}.npm-test.stderr.log`),
    timeoutMs: 120_000,
  });
  return {
    name: session.name,
    prompt_summary: session.promptSummary,
    command,
    test_after: testAfter,
    result_summary: await parseClaudeResultSummary(command.stdout_path),
  };
}

async function parseClaudeResultSummary(path: string): Promise<Record<string, unknown>> {
  const text = await readFile(path, "utf8");
  let eventCount = 0;
  let result: Record<string, unknown> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    eventCount += 1;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.type === "result") result = parsed;
    } catch {
      // Claude stream-json should be JSONL; keep the report robust if a tool prints text.
    }
  }
  return {
    event_count: eventCount,
    session_id: typeof result.session_id === "string" ? result.session_id : null,
    total_cost_usd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : null,
    num_turns: typeof result.num_turns === "number" ? result.num_turns : null,
    is_error: result.is_error === true,
  };
}

async function runSubstrateReport(runtimeDir: string, outputDir: string, logDir: string): Promise<EvidencePackReport["substrate_report"]> {
  const substrateOutputDir = join(outputDir, "substrate-runtime-report");
  const result = await runCommand({
    command: "node",
    args: [
      "scripts/runtime-real-project-flow-report.ts",
      "--root",
      runtimeDir,
      "--output-dir",
      substrateOutputDir,
      "--max-files",
      "4",
      "--max-scopes",
      "2",
      "--min-nodes",
      "1",
    ],
    cwd: resolve("."),
    stdoutPath: join(logDir, "substrate-report.stdout.json"),
    stderrPath: join(logDir, "substrate-report.stderr.log"),
    timeoutMs: 180_000,
  });
  const raw = await readFile(result.stdout_path, "utf8");
  const parsed = JSON.parse(raw) as {
    output_dir?: string;
    passed?: boolean;
    total_nodes_imported?: number;
    total_feedback_imported?: number;
    total_feedback_slot_nodes_imported?: number;
    total_relations_imported?: number;
    total_decisions_imported?: number;
  };
  return {
    output_dir: parsed.output_dir ?? substrateOutputDir,
    passed: parsed.passed === true,
    total_nodes_imported: Number(parsed.total_nodes_imported ?? 0),
    total_feedback_imported: Number(parsed.total_feedback_imported ?? 0),
    total_feedback_slot_nodes_imported: Number(parsed.total_feedback_slot_nodes_imported ?? 0),
    total_relations_imported: Number(parsed.total_relations_imported ?? 0),
    total_decisions_imported: Number(parsed.total_decisions_imported ?? 0),
  };
}

async function readLatestGuideExposure(runtimeDir: string, scope: string): Promise<GuideResult> {
  const exposures: GuideResult[] = [];
  for (const path of await walkSqliteFiles(runtimeDir)) {
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      if (!sqliteTableExists(db, "lite_memory_nodes")) continue;
      const rows = db.prepare(`
        SELECT id, slots_json, created_at
        FROM lite_memory_nodes
        WHERE scope = ? AND slots_json LIKE '%guide_exposure_v1%'
        ORDER BY created_at DESC
        LIMIT 50
      `).all(scope) as Array<{ id: string; slots_json: string; created_at: string }>;
      for (const row of rows) {
        const slots = JSON.parse(row.slots_json) as Record<string, unknown>;
        const exposure = asRecord(slots.guide_exposure_v1);
        if (Object.keys(exposure).length === 0) continue;
        exposures.push({
          source_memory_id: row.id,
          guide_trace_id: typeof exposure.guide_trace_id === "string" ? exposure.guide_trace_id : null,
          run_id: typeof exposure.run_id === "string" ? exposure.run_id : null,
          use_now_memory_ids: stringArray(exposure.use_now_memory_ids),
          inspect_before_use_memory_ids: stringArray(exposure.inspect_before_use_memory_ids),
          do_not_use_memory_ids: stringArray(exposure.do_not_use_memory_ids),
          prompt_char_count: typeof exposure.prompt_char_count === "number" ? exposure.prompt_char_count : null,
          history_used: typeof exposure.history_used === "boolean" ? exposure.history_used : null,
          actionable_history_used: typeof exposure.actionable_history_used === "boolean" ? exposure.actionable_history_used : null,
        });
      }
    } catch {
      // Ignore non-Runtime SQLite files.
    } finally {
      db?.close();
    }
  }
  return exposures.find((item) => item.guide_trace_id && item.use_now_memory_ids.length > 0)
    ?? exposures.find((item) => item.guide_trace_id)
    ?? {
      guide_trace_id: null,
      use_now_memory_ids: [],
      inspect_before_use_memory_ids: [],
      do_not_use_memory_ids: [],
    };
}

function reportMarkdown(report: EvidencePackReport): string {
  const sessionRows = report.sessions.map((session) => [
    `| ${session.name}`,
    session.command.exit_code === 0 ? "yes" : "no",
    session.test_after.exit_code === 0 ? "yes" : "no",
    String(session.result_summary.num_turns ?? "n/a"),
    String(session.result_summary.total_cost_usd ?? "n/a"),
  ].join(" | ") + " |");
  const gateRows = Object.entries(report.gates).map(([key, value]) => `- ${key}: ${value ? "yes" : "no"}`);
  return [
    "# Claude Code Real-Flow Evidence Pack",
    "",
    `Generated: ${report.generated_at}`,
    "",
    "## Summary",
    "",
    `- Runtime: ${report.base_url}`,
    `- Scope: ${report.scope}`,
    `- Provider: ${report.provider}`,
    `- Claude model: ${report.claude_model ?? "default"}`,
    `- Feedback attributed: ${report.feedback.submitted ? "yes" : `no (${report.feedback.skipped_reason ?? "unknown"})`}`,
    `- Substrate report: ${report.substrate_report?.passed ? "passed" : "not passed"}`,
    "",
    "## Sessions",
    "",
    "| Session | Claude exited | Tests passed | Turns | Cost USD |",
    "| --- | --- | --- | ---: | ---: |",
    ...sessionRows,
    "",
    "## Product Gates",
    "",
    ...gateRows,
    "",
    "## Feedback Attribution",
    "",
    `- Guide trace: ${report.guide_before_second_session.guide_trace_id ?? "none"}`,
    `- Used memory IDs: ${report.feedback.used_memory_ids.length}`,
    `- Inspect memory IDs in guide: ${report.guide_before_second_session.inspect_before_use_memory_ids.length}`,
    `- Blocked memory IDs in guide: ${report.guide_before_second_session.do_not_use_memory_ids.length}`,
    "",
    "## Substrate Evidence",
    "",
    `- Nodes imported: ${report.substrate_report?.total_nodes_imported ?? 0}`,
    `- Feedback imported: ${report.substrate_report?.total_feedback_imported ?? 0}`,
    `- Feedback-slot nodes imported: ${report.substrate_report?.total_feedback_slot_nodes_imported ?? 0}`,
    `- Relations imported: ${report.substrate_report?.total_relations_imported ?? 0}`,
    `- Decisions imported: ${report.substrate_report?.total_decisions_imported ?? 0}`,
    "",
    "## Caveats",
    "",
    ...report.caveats.map((item) => `- ${item}`),
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs();
  const runRoot = args.workdir ?? await mkdtemp(join(tmpdir(), "aionis-claude-real-flow-"));
  const outputDir = args.outputDir;
  const logDir = join(outputDir, "logs");
  const projectDir = join(runRoot, "project");
  const runtimeDir = join(runRoot, "runtime");
  const port = args.port ?? await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let runtime: ChildProcess | null = null;

  try {
    await mkdir(outputDir, { recursive: true });
    await mkdir(logDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await createTicketLedgerProject(projectDir);
    await installRuntime(args, runRoot, projectDir, baseUrl, logDir);

    runtime = await startRuntime(runtimeDir, logDir);
    await waitForHealth(baseUrl, 90_000);
    let scope = await resolveClaudeScope(projectDir, baseUrl, logDir);

    const firstSession = await runClaudeSession(args, {
      name: "session-1-fix-ledger",
      projectDir,
      logDir,
      promptSummary: "Fix the governed ticket ledger until the existing acceptance tests pass.",
      prompt: [
        "You are working in this repository.",
        "Run npm test, inspect the failing ticket ledger tests, and fix src/ticket-ledger.mjs.",
        "Preserve the tests. Do not delete or weaken assertions.",
        "When tests pass, briefly summarize the implementation boundary.",
      ].join("\n"),
    });
    scope = await resolveRuntimeEvidenceScope(runtimeDir, scope);

    await addSecondSessionAcceptanceTest(projectDir);
    const secondSession = await runClaudeSession(args, {
      name: "session-2-add-explanation",
      projectDir,
      logDir,
      promptSummary: "Continue in a fresh Claude Code session and implement the follow-up audit explanation helper.",
      prompt: [
        "This is a fresh continuation session.",
        "A new acceptance test was added for explainTicket.",
        "Use the current repository state and any Aionis memory context injected by Claude Code hooks.",
        "Run npm test and implement the smallest production change needed in src/ticket-ledger.mjs.",
        "Do not remove or weaken tests.",
      ].join("\n"),
    });
    const guideSummary = await readLatestGuideExposure(runtimeDir, scope);

    const usedMemoryIds = guideSummary.use_now_memory_ids.slice(0, 6);
    let feedbackResult: Record<string, unknown> | null = null;
    let feedbackSkippedReason: string | null = null;
    if (!guideSummary.guide_trace_id) {
      feedbackSkippedReason = "guide_missing_trace_id";
    } else if (usedMemoryIds.length === 0) {
      feedbackSkippedReason = "guide_exposed_no_use_now_memory_ids";
    } else {
      feedbackResult = await postJson<Record<string, unknown>>(baseUrl, "/v1/feedback", {
        tenant_id: "default",
        scope,
        actor: "claude-code",
        reason: "Claude Code used Aionis-governed continuation context and completed the follow-up acceptance test.",
        run_id: "claude-code-real-flow:feedback",
        outcome: "positive",
        used_surface: "use_now",
        guide_trace_id: guideSummary.guide_trace_id,
        used_memory_ids: usedMemoryIds,
        verifier_status: "passed",
        tool_status: "succeeded",
      });
    }

    const measureResult = null;

    const substrateReport = await runSubstrateReport(runtimeDir, outputDir, logDir);
    const report: EvidencePackReport = {
      contract_version: "aionis_claude_code_real_flow_evidence_pack_v1",
      generated_at: new Date().toISOString(),
      run_root: runRoot,
      project_dir: projectDir,
      runtime_dir: runtimeDir,
      base_url: baseUrl,
      scope,
      provider: args.provider,
      runtime_package: args.runtimePackage,
      claude_model: args.claudeModel,
      sessions: [firstSession, secondSession],
      guide_before_second_session: guideSummary,
      feedback: {
        submitted: feedbackResult !== null,
        skipped_reason: feedbackSkippedReason,
        used_memory_ids: usedMemoryIds,
        result: feedbackResult,
      },
      measure: measureResult,
      substrate_report: substrateReport,
      gates: {
        first_session_tests_passed: firstSession.test_after.exit_code === 0,
        second_session_tests_passed: secondSession.test_after.exit_code === 0,
        guide_exposed_memory: guideSummary.use_now_memory_ids.length > 0 || guideSummary.inspect_before_use_memory_ids.length > 0,
        feedback_attributed: feedbackResult !== null,
        substrate_imported_runtime_nodes: (substrateReport?.total_nodes_imported ?? 0) > 0,
        substrate_imported_feedback: (substrateReport?.total_feedback_imported ?? 0) > 0
          || (substrateReport?.total_feedback_slot_nodes_imported ?? 0) > 0,
      },
      caveats: [
        "This is a real Claude Code execution flow using the published install path, not a synthetic Runtime unit test.",
        "It validates cross-session evidence capture, guide exposure, feedback attribution, and Substrate mirroring. It is not a benchmark claim.",
        "The script attributes feedback to Claude Code's persisted guide exposure ledger; it does not call /v1/measure because that endpoint requires the full guide response, not the compact ledger projection.",
        "The isolated project is generated for this evidence pack; do not convert project-specific failures into Runtime core rules.",
      ],
    };

    await writeFile(join(outputDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await writeFile(join(outputDir, "summary.md"), reportMarkdown(report), "utf8");
    console.log(JSON.stringify({
      output_dir: outputDir,
      summary: join(outputDir, "summary.md"),
      passed: Object.values(report.gates).every(Boolean),
      feedback_attributed: report.feedback.submitted,
      substrate_feedback_imported: report.substrate_report?.total_feedback_imported ?? 0,
      substrate_feedback_slot_nodes_imported: report.substrate_report?.total_feedback_slot_nodes_imported ?? 0,
      run_root: args.keepWorkdir || args.workdir ? runRoot : null,
    }, null, 2));
    if (!Object.values(report.gates).every(Boolean)) process.exitCode = 1;
  } finally {
    if (runtime && !runtime.killed) {
      runtime.kill("SIGTERM");
      setTimeout(() => runtime?.kill("SIGKILL"), 5_000).unref();
    }
    if (!args.keepWorkdir && !args.workdir && existsSync(runRoot)) {
      await rm(runRoot, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error((err as Error).stack ?? String(err));
  console.error("");
  console.error(usage());
  process.exit(1);
});
