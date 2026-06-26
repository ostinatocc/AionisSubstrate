import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

type PackageJson = {
  name: string;
  version: string;
};

function registryPackageSpec(): string {
  const override = process.env.AIONIS_SUBSTRATE_REGISTRY_PACKAGE?.trim();
  if (override) return override;
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;
  return `${pkg.name}@${pkg.version}`;
}

async function main(): Promise<void> {
  const packageSpec = registryPackageSpec();
  const workspace = await mkdtemp(join(tmpdir(), "aionis-substrate-published-runtime-"));

  try {
    await writeFile(join(workspace, "package.json"), "{\"type\":\"module\"}\n", "utf8");
    execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund", packageSpec], {
      cwd: workspace,
      stdio: "pipe",
    });

    await writeFile(join(workspace, "runtime-smoke.mjs"), `
      import assert from "node:assert/strict";
      import { mkdtemp, rm } from "node:fs/promises";
      import { join } from "node:path";
      import { tmpdir } from "node:os";
      import { DatabaseSync } from "node:sqlite";
      import {
        importRuntimeLiteSnapshot,
        openSqliteAionisSubstrate,
      } from "@aionis/substrate";

      function createRuntimeLiteFixture(path) {
        const db = new DatabaseSync(path);
        db.exec(\`
          CREATE TABLE lite_memory_nodes (
            id TEXT PRIMARY KEY,
            scope TEXT NOT NULL,
            client_id TEXT,
            type TEXT NOT NULL,
            tier TEXT NOT NULL,
            title TEXT,
            text_summary TEXT,
            slots_json TEXT NOT NULL,
            raw_ref TEXT,
            evidence_ref TEXT,
            embedding_vector_json TEXT,
            embedding_model TEXT,
            memory_lane TEXT NOT NULL,
            producer_agent_id TEXT,
            owner_agent_id TEXT,
            owner_team_id TEXT,
            embedding_status TEXT NOT NULL,
            embedding_last_error TEXT,
            salience REAL NOT NULL,
            importance REAL NOT NULL,
            confidence REAL NOT NULL,
            redaction_version INTEGER NOT NULL,
            commit_id TEXT NOT NULL,
            created_at TEXT NOT NULL
          );

          CREATE TABLE lite_memory_edges (
            id TEXT PRIMARY KEY,
            scope TEXT NOT NULL,
            type TEXT NOT NULL,
            src_id TEXT NOT NULL,
            dst_id TEXT NOT NULL,
            weight REAL NOT NULL,
            confidence REAL NOT NULL,
            decay_rate REAL NOT NULL,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            commit_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(scope, type, src_id, dst_id)
          );

          CREATE TABLE lite_memory_rule_feedback (
            id TEXT PRIMARY KEY,
            scope TEXT NOT NULL,
            rule_node_id TEXT NOT NULL,
            run_id TEXT,
            outcome TEXT NOT NULL,
            note TEXT,
            source TEXT NOT NULL,
            decision_id TEXT,
            commit_id TEXT,
            created_at TEXT NOT NULL
          );
        \`);

        const insertNode = db.prepare(\`
          INSERT INTO lite_memory_nodes (
            id, scope, client_id, type, tier, title, text_summary, slots_json, raw_ref, evidence_ref,
            embedding_vector_json, embedding_model, memory_lane, producer_agent_id, owner_agent_id,
            owner_team_id, embedding_status, embedding_last_error, salience, importance, confidence,
            redaction_version, commit_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        \`);

        insertNode.run(
          "runtime-current",
          "repo-a",
          "client-current",
          "procedure",
          "hot",
          "Current route",
          "Use src/runtime.ts as the validated current route.",
          JSON.stringify({
            summary_kind: "workflow_anchor",
            execution_native_v1: {
              summary_kind: "workflow_anchor",
              execution_kind: "workflow_anchor",
              contract_trust: "trusted",
              target_files: ["src/runtime.ts"],
            },
          }),
          null,
          null,
          null,
          "fixture-embedding",
          "shared",
          "agent-writer",
          "agent-owner",
          "team-a",
          "ready",
          null,
          0.9,
          0.8,
          0.92,
          1,
          "commit-1",
          "2026-06-01T00:00:00.000Z",
        );

        insertNode.run(
          "runtime-old",
          "repo-a",
          "client-old",
          "procedure",
          "hot",
          "Old route",
          "Use src/legacy.ts as the old route.",
          JSON.stringify({
            summary_kind: "workflow_anchor",
            execution_native_v1: {
              summary_kind: "workflow_anchor",
              execution_kind: "workflow_anchor",
              contract_trust: "trusted",
              target_files: ["src/legacy.ts"],
            },
          }),
          null,
          null,
          null,
          "fixture-embedding",
          "shared",
          "agent-writer",
          "agent-owner",
          "team-a",
          "ready",
          null,
          0.7,
          0.7,
          0.82,
          1,
          "commit-1",
          "2026-05-30T00:00:00.000Z",
        );

        insertNode.run(
          "runtime-trace",
          "repo-a",
          "client-trace",
          "event",
          "archive",
          "Raw trace",
          "Full terminal trace from the prior run.",
          JSON.stringify({ summary_kind: "raw_trace", target_files: ["src/runtime.ts"] }),
          "file://runtime/traces/run-1.log",
          null,
          null,
          "fixture-embedding",
          "shared",
          "agent-writer",
          "agent-owner",
          "team-a",
          "ready",
          null,
          0.4,
          0.4,
          0.8,
          1,
          "commit-1",
          "2026-06-02T01:00:00.000Z",
        );

        db.prepare(\`
          INSERT INTO lite_memory_edges (
            id, scope, type, src_id, dst_id, weight, confidence, decay_rate, metadata_json, commit_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        \`).run(
          "edge-current-supersedes-old",
          "repo-a",
          "supersedes",
          "runtime-current",
          "runtime-old",
          0.9,
          0.88,
          0,
          JSON.stringify({ reason: "newer verifier evidence" }),
          "commit-2",
          "2026-06-03T00:00:00.000Z",
        );

        db.prepare(\`
          INSERT INTO lite_memory_rule_feedback (
            id, scope, rule_node_id, run_id, outcome, note, source, decision_id, commit_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        \`).run(
          "feedback-current-pass",
          "repo-a",
          "runtime-current",
          "run-1",
          "passed",
          "verifier passed",
          "product_facade",
          "decision-1",
          "commit-3",
          "2026-06-03T01:00:00.000Z",
        );

        db.close();
      }

      const root = await mkdtemp(join(tmpdir(), "aionis-substrate-runtime-inner-"));
      try {
        const sourcePath = join(root, "runtime-lite.sqlite");
        const targetPath = join(root, "substrate.sqlite");
        createRuntimeLiteFixture(sourcePath);

        const store = await openSqliteAionisSubstrate({ path: targetPath });
        const summary = await importRuntimeLiteSnapshot({
          sourcePath,
          target: store,
          scope: "repo-a",
        });
        assert.equal(summary.nodesImported, 3);
        assert.equal(summary.relationsImported, 1);
        assert.equal(summary.feedbackImported, 1);

        const context = await store.compileContext({ scope: "repo-a" });
        assert.deepEqual(context.use_now.map((node) => node.id), ["runtime-current"]);
        assert.deepEqual(context.do_not_use.map((node) => node.id), ["runtime-old"]);
        assert.deepEqual(context.rehydrate.map((node) => node.id), ["runtime-trace"]);
        await store.close();

        console.log(JSON.stringify({
          ok: true,
          imported: {
            nodes: summary.nodesImported,
            relations: summary.relationsImported,
            feedback: summary.feedbackImported,
          },
          context: {
            use_now: context.use_now.map((node) => node.id),
            do_not_use: context.do_not_use.map((node) => node.id),
            rehydrate: context.rehydrate.map((node) => node.id),
          },
        }, null, 2));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    `, "utf8");

    execFileSync("node", ["runtime-smoke.mjs"], {
      cwd: workspace,
      stdio: "pipe",
    });

    console.log(JSON.stringify({
      ok: true,
      package: packageSpec,
    }, null, 2));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

await main();
