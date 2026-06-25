# Backup and Restore

Aionis Substrate backup is event-log based.

It exports the append-only evidence events plus a checksum. Restore rebuilds the read model from those events. It does not copy only the derived snapshot.

## Backup Format

The backup object contains:

- backup format and version;
- substrate schema version;
- source adapter metadata from `getStoreInfo`;
- event count and last sequence;
- SHA-256 checksum over the canonical event list;
- every append-only event in sequence order.

The checksum covers the event list. If an event payload is changed after export, verification fails and restore is rejected.

## Export

```ts
import {
  exportAionisSubstrateBackup,
  openSqliteAionisSubstrate,
  writeAionisSubstrateBackupFile,
} from "@aionis/substrate";

const store = await openSqliteAionisSubstrate({
  path: "/data/aionis-substrate.sqlite",
});

const backup = await exportAionisSubstrateBackup(store);
await writeAionisSubstrateBackupFile("/backups/aionis-substrate-backup.json", backup);

await store.close();
```

## Verify

```ts
import {
  readAionisSubstrateBackupFile,
  verifyAionisSubstrateBackup,
} from "@aionis/substrate";

const backup = await readAionisSubstrateBackupFile("/backups/aionis-substrate-backup.json");
const report = verifyAionisSubstrateBackup(backup);

if (!report.ok) {
  throw new Error(report.errors.join("; "));
}
```

Verification checks:

- backup format and version;
- supported schema version;
- event sequence continuity;
- duplicate event ids;
- relation / feedback / lifecycle references;
- event count and last sequence headers;
- SHA-256 checksum.

## Restore to File Store

```ts
import {
  readAionisSubstrateBackupFile,
  restoreAionisSubstrateBackupToFile,
} from "@aionis/substrate";

const backup = await readAionisSubstrateBackupFile("/backups/aionis-substrate-backup.json");
await restoreAionisSubstrateBackupToFile(backup, "/data/aionis-substrate-file-store");
```

Restore writes:

- `events.jsonl`
- `snapshot.json`

The target must be empty unless `overwrite: true` is passed.

## Restore to SQLite

```ts
import {
  readAionisSubstrateBackupFile,
  restoreAionisSubstrateBackupToSqlite,
} from "@aionis/substrate";

const backup = await readAionisSubstrateBackupFile("/backups/aionis-substrate-backup.json");
await restoreAionisSubstrateBackupToSqlite(backup, "/data/aionis-substrate-restored.sqlite");
```

Restore writes the original event ids and sequence numbers, rebuilds structured read-model tables, and preserves the next event sequence for future writes.

The SQLite target must not exist unless `overwrite: true` is passed.

## Boundary

Backup and restore operate on the Substrate store only.

They do not back up an Aionis Runtime database, an external vector index, or payload files referenced by `payloadRef`. Payload files remain external artifacts and need their own storage policy.
