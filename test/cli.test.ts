import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

test("published CLI entrypoints expose root and sidecar help", () => {
  const rootHelp = execFileSync("node", ["src/cli.ts", "--help"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.match(rootHelp, /Aionis Substrate CLI/);
  assert.match(rootHelp, /aionis-substrate sidecar/);

  const sidecarHelp = execFileSync("node", ["src/cli.ts", "sidecar", "--help"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.match(sidecarHelp, /Aionis Substrate sidecar check/);
  assert.match(sidecarHelp, /--source-root/);
});
