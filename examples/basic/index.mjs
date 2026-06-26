import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  exportAionisSubstrateBackup,
  openFileAionisSubstrate,
  openSqliteAionisSubstrate,
  verifyAionisSubstrateBackup,
} from "../../dist/index.js";

const workspace = await mkdtemp(join(tmpdir(), "aionis-substrate-basic-"));

try {
  const file = await openFileAionisSubstrate({ dir: join(workspace, "file-store") });

  await file.putNode({
    id: "current-route",
    scope: "repo-a",
    kind: "procedure",
    title: "Current route",
    summary: "Use src/runtime.ts after the verifier passed.",
    lifecycle: "active",
    authority: "trusted",
    confidence: 0.95,
    targetFiles: ["src/runtime.ts"],
  });

  await file.putNode({
    id: "old-route",
    scope: "repo-a",
    kind: "procedure",
    title: "Old route",
    summary: "Old src/legacy.ts route is retained as evidence but replaced by the current route.",
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
    reasons: ["newer verifier evidence replaced the old route"],
  });

  const eventsBeforePreview = await file.listEvents();
  const preview = await file.previewContext({ scope: "repo-a", query: "continue the runtime route" });
  assert.deepEqual(preview.use_now.map((node) => node.id), ["current-route"]);
  assert.deepEqual(preview.do_not_use.map((node) => node.id), ["old-route"]);
  assert.equal((await file.listEvents()).length, eventsBeforePreview.length);

  const compiled = await file.compileContext({ scope: "repo-a", query: "continue the runtime route" });
  assert.deepEqual(compiled.use_now.map((node) => node.id), ["current-route"]);
  assert.deepEqual(compiled.do_not_use.map((node) => node.id), ["old-route"]);
  assert.equal((await file.listEvents()).at(-1)?.type, "memory.decision.recorded");

  await file.recordFeedback({
    scope: "repo-a",
    memoryId: "current-route",
    outcome: "positive",
    strength: "strong",
    runId: "run-1",
    evidenceRef: "trace://run-1/verifier",
  });

  const search = await file.searchNodes({
    scope: "repo-a",
    query: "runtime verifier",
    lifecycle: ["active"],
    authority: ["trusted"],
    limit: 5,
  });
  assert.deepEqual(search.map((result) => result.node.id), ["current-route"]);

  const backup = await exportAionisSubstrateBackup(file);
  assert.equal(verifyAionisSubstrateBackup(backup).ok, true);
  await file.close();

  const sqlite = await openSqliteAionisSubstrate({ path: join(workspace, "substrate.sqlite") });
  await sqlite.putNode({
    id: "raw-trace",
    scope: "repo-a",
    kind: "trace_pointer",
    title: "Raw run trace",
    summary: "Raw terminal trace is available on demand.",
    lifecycle: "archived",
    authority: "trusted",
    confidence: 0.88,
    payloadRef: "file://trace.log",
  });

  const sqliteContext = await sqlite.compileContext({ scope: "repo-a" });
  assert.deepEqual(sqliteContext.rehydrate.map((node) => node.id), ["raw-trace"]);
  await sqlite.close();

  console.log(JSON.stringify({
    ok: true,
    file_context: {
      use_now: compiled.use_now.map((node) => node.id),
      do_not_use: compiled.do_not_use.map((node) => node.id),
    },
    sqlite_context: {
      rehydrate: sqliteContext.rehydrate.map((node) => node.id),
    },
  }, null, 2));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
