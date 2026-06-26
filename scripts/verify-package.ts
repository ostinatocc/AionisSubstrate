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
  "src/index.ts",
  "src/types.ts",
  "src/file-substrate.ts",
  "src/sqlite-substrate.ts",
  "src/search.ts",
  "docs/API_USAGE.md",
  "docs/STORE_CONTRACT.md",
  "docs/ADAPTER_CONTRACT.md",
];

const allowedPrefixes = [
  "package.json",
  "README.md",
  "tsconfig.json",
  "src/",
  "scripts/",
  "docs/",
];

const forbiddenPrefixes = [
  ".git",
  ".github/",
  "node_modules/",
  "reports/",
  "test/",
  "coverage/",
  "dist/",
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
