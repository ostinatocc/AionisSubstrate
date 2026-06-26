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
  const workspace = await mkdtemp(join(tmpdir(), "aionis-substrate-registry-smoke-"));

  try {
    await writeFile(join(workspace, "package.json"), "{\"type\":\"module\"}\n", "utf8");
    execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund", packageSpec], {
      cwd: workspace,
      stdio: "pipe",
    });

    const cliHelp = execFileSync(join(workspace, "node_modules", ".bin", "aionis-substrate"), ["--help"], {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!cliHelp.includes("Aionis Substrate CLI")) throw new Error("installed registry CLI help did not run");

    await writeFile(join(workspace, "smoke.mjs"), `
      import assert from "node:assert/strict";
      import { mkdtemp, rm } from "node:fs/promises";
      import { join } from "node:path";
      import { tmpdir } from "node:os";
      import {
        AIONIS_SUBSTRATE_SCHEMA_VERSION,
        exportAionisSubstrateBackup,
        openFileAionisSubstrate,
        openSqliteAionisSubstrate,
        verifyAionisSubstrateBackup,
      } from "@aionis/substrate";

      assert.equal(AIONIS_SUBSTRATE_SCHEMA_VERSION, 1);
      const root = await mkdtemp(join(tmpdir(), "aionis-substrate-registry-inner-"));
      try {
        const file = await openFileAionisSubstrate({ dir: join(root, "file") });
        await file.putNode({
          id: "current-route",
          scope: "repo-a",
          kind: "procedure",
          summary: "Use src/runtime.ts after verifier passed.",
          lifecycle: "active",
          authority: "trusted",
          confidence: 0.95,
          targetFiles: ["src/runtime.ts"],
        });
        await file.putNode({
          id: "old-route",
          scope: "repo-a",
          kind: "procedure",
          summary: "Old src/legacy.ts route retained as evidence.",
          lifecycle: "active",
          authority: "trusted",
          confidence: 0.7,
          targetFiles: ["src/legacy.ts"],
        });
        await file.putRelation({
          scope: "repo-a",
          kind: "supersedes",
          sourceId: "current-route",
          targetId: "old-route",
          confidence: 0.9,
          reasons: ["newer verifier evidence replaced old route"],
        });

        const beforePreview = await file.listEvents();
        const preview = await file.previewContext({ scope: "repo-a" });
        assert.deepEqual(preview.use_now.map((node) => node.id), ["current-route"]);
        assert.deepEqual(preview.do_not_use.map((node) => node.id), ["old-route"]);
        assert.equal((await file.listEvents()).length, beforePreview.length);

        const context = await file.compileContext({ scope: "repo-a" });
        assert.deepEqual(context.use_now.map((node) => node.id), ["current-route"]);
        assert.deepEqual(context.do_not_use.map((node) => node.id), ["old-route"]);
        assert.equal((await file.listEvents()).at(-1)?.type, "memory.decision.recorded");

        const search = await file.searchNodes({ scope: "repo-a", query: "runtime verifier", limit: 5 });
        assert.deepEqual(search.map((result) => result.node.id), ["current-route"]);

        const backup = await exportAionisSubstrateBackup(file);
        assert.equal(verifyAionisSubstrateBackup(backup).ok, true);
        await file.close();

        const sqlite = await openSqliteAionisSubstrate({ path: join(root, "substrate.sqlite") });
        await sqlite.putNode({
          id: "raw-trace",
          scope: "repo-a",
          kind: "trace_pointer",
          summary: "Raw terminal trace is available on demand.",
          lifecycle: "archived",
          authority: "trusted",
          confidence: 0.88,
          payloadRef: "file://trace.log",
        });
        const sqliteContext = await sqlite.compileContext({ scope: "repo-a" });
        assert.deepEqual(sqliteContext.rehydrate.map((node) => node.id), ["raw-trace"]);
        await sqlite.close();

        console.log(JSON.stringify({ ok: true }));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    `, "utf8");

    execFileSync("node", ["smoke.mjs"], {
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
