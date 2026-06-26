import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

type PackOutput = {
  filename: string;
};

async function main(): Promise<void> {
  const root = resolve(".");
  const workspace = await mkdtemp(join(tmpdir(), "aionis-substrate-install-smoke-"));
  const packDir = join(workspace, "pack");
  const appDir = join(workspace, "app");

  try {
    await mkdir(packDir, { recursive: true });
    const packRaw = execFileSync("npm", ["pack", "--json", "--pack-destination", packDir], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pack = JSON.parse(packRaw) as PackOutput[];
    const tarball = join(packDir, pack[0]?.filename ?? "");
    if (!pack[0]?.filename) throw new Error("npm pack did not return a tarball filename");

    await writeFile(join(workspace, "package.json"), "{\"type\":\"module\"}\n", "utf8");
    execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund", tarball], {
      cwd: workspace,
      stdio: "pipe",
    });

    const cliHelp = execFileSync(join(workspace, "node_modules", ".bin", "aionis-substrate"), ["--help"], {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!cliHelp.includes("Aionis Substrate CLI")) throw new Error("installed CLI help did not run");

    await writeFile(join(workspace, "smoke.mjs"), `
      import assert from "node:assert/strict";
      import {
        AIONIS_SUBSTRATE_SCHEMA_VERSION,
        exportAionisSubstrateBackup,
        openFileAionisSubstrate,
        openSqliteAionisSubstrate,
        verifyAionisSubstrateBackup
      } from "@aionis/substrate";

      assert.equal(AIONIS_SUBSTRATE_SCHEMA_VERSION, 1);

      const file = await openFileAionisSubstrate({ dir: ${JSON.stringify(join(appDir, "file-store"))} });
      await file.putNode({
        id: "current-route",
        scope: "repo-a",
        kind: "procedure",
        title: "Current route",
        summary: "Use src/runtime.ts after verifier passed.",
        lifecycle: "active",
        authority: "trusted",
        confidence: 0.95,
        targetFiles: ["src/runtime.ts"]
      });
      await file.putNode({
        id: "old-route",
        scope: "repo-a",
        kind: "procedure",
        title: "Old route",
        summary: "Old src/legacy.ts route retained as evidence.",
        lifecycle: "active",
        authority: "trusted",
        confidence: 0.7,
        targetFiles: ["src/legacy.ts"]
      });
      await file.putRelation({
        scope: "repo-a",
        kind: "supersedes",
        sourceId: "current-route",
        targetId: "old-route",
        confidence: 0.9,
        reasons: ["newer verifier evidence replaced old route"]
      });
      const fileContext = await file.compileContext({ scope: "repo-a" });
      assert.deepEqual(fileContext.use_now.map((node) => node.id), ["current-route"]);
      assert.deepEqual(fileContext.do_not_use.map((node) => node.id), ["old-route"]);
      const fileSearch = await file.searchNodes({ scope: "repo-a", query: "runtime verifier", limit: 5 });
      assert.deepEqual(fileSearch.map((result) => result.node.id), ["current-route"]);
      const backup = await exportAionisSubstrateBackup(file);
      assert.equal(verifyAionisSubstrateBackup(backup).ok, true);
      await file.close();

      const sqlite = await openSqliteAionisSubstrate({ path: ${JSON.stringify(join(appDir, "substrate.sqlite"))} });
      await sqlite.putNode({
        id: "raw-trace",
        scope: "repo-a",
        kind: "trace_pointer",
        summary: "Raw terminal trace is available on demand.",
        lifecycle: "archived",
        authority: "trusted",
        confidence: 0.88,
        payloadRef: "file://trace.log"
      });
      const sqliteContext = await sqlite.compileContext({ scope: "repo-a" });
      assert.deepEqual(sqliteContext.rehydrate.map((node) => node.id), ["raw-trace"]);
      await sqlite.close();

      console.log(JSON.stringify({ ok: true }));
    `, "utf8");

    execFileSync("node", ["smoke.mjs"], {
      cwd: workspace,
      stdio: "pipe",
    });

    console.log(JSON.stringify({
      ok: true,
      tarball,
    }, null, 2));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

await main();
