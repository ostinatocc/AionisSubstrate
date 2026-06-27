# Post-Release Evidence

This document records public-package verification runs for released `@aionis/substrate` versions.

The purpose is narrow: prove that the published npm package can be installed from the registry and can bridge real Aionis Runtime Lite SQLite sources into isolated Substrate stores without mutating Runtime source data.

## 0.1.7

Release date: 2026-06-27

Package checked from npm registry:

```bash
npm view @aionis/substrate version
```

Result:

```text
0.1.7
```

Registry install smoke:

```bash
npm run check:registry-install
npm run check:published-runtime-smoke
```

Result:

```json
{"ok":true,"package":"@aionis/substrate@0.1.7"}
{"ok":true,"package":"@aionis/substrate@0.1.7"}
```

Real Runtime bridge corpus soak:

```bash
npm run -s check:published-runtime-bridge-corpus -- \
  --root /Volumes/ziel/AionisRuntime-focused/.tmp \
  --max-files 10 \
  --live-passes 10
```

Result:

```json
{
  "package": "@aionis/substrate@0.1.7",
  "discovered_sqlite_files": 30,
  "runtime_sqlite_files": 14,
  "attempted_files": 10,
  "passed_files": 10,
  "failed_files": 0,
  "total_nodes_read": 5922,
  "total_nodes_imported": 5807,
  "total_relations_imported": 33,
  "total_events": 5840
}
```

Report artifact:

```text
reports/published-runtime-bridge-corpus-2026-06-27T08-24-22-228Z/summary.json
```

What this run proves:

- the published npm package installs in a fresh temporary project;
- real focused Runtime Lite SQLite files can be opened read-only;
- snapshot import and live-sidecar import produce matching event totals;
- every live-sidecar pass after the first is idempotent for unchanged Runtime evidence;
- Runtime source SQLite files remain immutable during the bridge check;
- the bridge behavior is not tied to a single Runtime SQLite file.

What this run does not claim:

- it does not make Substrate the full Runtime policy engine;
- it does not mutate Runtime storage or Runtime source code;
- it does not prove downstream Agent task success;
- it does not replace Runtime guide/admission behavior.
