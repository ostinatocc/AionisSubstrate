import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

type PackFile = {
  path: string;
  size: number;
  mode: number;
};

type PackDryRun = {
  files: PackFile[];
  entryCount: number;
};

const requiredFiles = [
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/types.js",
  "dist/types.d.ts",
  "dist/file-substrate.js",
  "dist/sqlite-substrate.js",
  "dist/search.js",
  "docs/API_USAGE.md",
  "docs/STORE_CONTRACT.md",
  "docs/ADAPTER_CONTRACT.md",
  "examples/basic/index.mjs",
  "examples/basic/README.md",
];

const allowedPrefixes = [
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "dist/",
  "docs/",
  "examples/",
];

const forbiddenPrefixes = [
  ".git",
  ".github/",
  "node_modules/",
  "reports/",
  "scripts/",
  "src/",
  "test/",
  "coverage/",
];

const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
const pack = JSON.parse(raw) as PackDryRun[];
assert.equal(pack.length, 1, "npm pack dry-run should return exactly one package");

const files = pack[0]?.files.map((file) => file.path).sort() ?? [];
const fileSet = new Set(files);

for (const required of requiredFiles) {
  assert.ok(fileSet.has(required), `package is missing required file: ${required}`);
}

for (const file of files) {
  assert.ok(
    allowedPrefixes.some((prefix) => file === prefix || file.startsWith(prefix)),
    `package contains unexpected file: ${file}`,
  );
  assert.ok(
    !forbiddenPrefixes.some((prefix) => file === prefix || file.startsWith(prefix)),
    `package contains forbidden file: ${file}`,
  );
}

console.log(JSON.stringify({
  ok: true,
  entry_count: pack[0]?.entryCount,
  files: files.length,
}, null, 2));
