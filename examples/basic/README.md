# Basic Example

This example runs the smallest useful Substrate loop:

1. open a file-backed store;
2. write current and stale execution memories;
3. link the stale memory with a `supersedes` relation;
4. preview context without writing a receipt;
5. compile context with a `memory.decision.recorded` receipt;
6. record positive feedback;
7. search deterministic memory candidates;
8. export and verify a backup;
9. open a SQLite store and compile a rehydrate hook.

Run it from the repository root:

```bash
npm run example:basic
```
