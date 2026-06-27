# Claude Code Real-Flow Evidence Pack

This evidence pack runs a real Claude Code workflow against an isolated Aionis
Runtime install, then verifies that the resulting Runtime evidence can be
mirrored into Aionis Substrate.

It is intentionally an external validation harness. It does not change Runtime
admission logic and it does not turn one generated project into product rules.

## What It Proves

The pack checks that a local user path can:

1. install Aionis Runtime through the product CLI;
2. attach Claude Code hooks to a generated project;
3. run a first Claude Code session that fixes a real failing test suite;
4. run a second fresh Claude Code session that continues the project;
5. call `/v1/guide` before the second session and `/v1/feedback` after it;
6. mirror the Runtime SQLite evidence into Substrate;
7. preserve nodes and feedback through the Substrate backup/restore report.

The report is not a benchmark claim. It is a repeatable product-evidence check
for cross-session execution memory, feedback attribution, and durable evidence
mirroring.

## Run

```bash
npm run -s check:claude-code-real-flow
```

Useful options:

```bash
node scripts/claude-code-real-flow-evidence-pack.ts \
  --provider none \
  --runtime-package aionis@latest \
  --keep-workdir
```

Use `--provider minimax`, `--provider openai`, or `--provider dashscope` when
you want stored-memory semantic recall in the isolated Runtime. The required
provider key must already be present in the shell environment.

## Outputs

The script writes:

- `summary.json`: machine-readable evidence pack report.
- `summary.md`: reader-facing report.
- `logs/`: setup, Runtime, Claude Code, test, guide, and Substrate report logs.
- `substrate-runtime-report/`: the underlying Substrate Runtime mirror report.

The main gates are:

- first Claude Code session tests pass;
- second Claude Code session tests pass;
- guide exposes memory before the second session;
- feedback is attributed to guide-exposed memory;
- Substrate imports Runtime nodes;
- Substrate imports Runtime feedback.

## Caveats

- The generated project is deliberately small so the pack can be run regularly.
- It validates the product path and evidence chain, not external task success.
- Project-specific observations should remain reports or candidate workflows;
  they should not be promoted into Runtime core behavior by themselves.
