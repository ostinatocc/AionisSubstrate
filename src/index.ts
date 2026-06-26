export * from "./types.ts";
export {
  createMemoryCandidateIndex,
  type AionisCandidateIndex,
  type AionisCandidateIndexHealthReport,
  type AionisCandidateIndexSearchResult,
} from "./candidate-index.ts";
export {
  createZvecCandidateIndex,
  ZvecCandidateIndex,
  type ZvecCandidateIndexOptions,
} from "./zvec-candidate-index.ts";
export { openFileAionisSubstrate, type FileAionisSubstrateOptions } from "./file-substrate.ts";
export { openSqliteAionisSubstrate, type SqliteAionisSubstrateOptions } from "./sqlite-substrate.ts";
export {
  AIONIS_SUBSTRATE_BACKUP_FORMAT,
  AIONIS_SUBSTRATE_BACKUP_VERSION,
  exportAionisSubstrateBackup,
  readAionisSubstrateBackupFile,
  restoreAionisSubstrateBackupToFile,
  restoreAionisSubstrateBackupToSqlite,
  verifyAionisSubstrateBackup,
  writeAionisSubstrateBackupFile,
  type AionisSubstrateBackup,
  type AionisSubstrateBackupIntegrityReport,
  type RestoreAionisSubstrateBackupOptions,
} from "./backup.ts";
export {
  importRuntimeLiteSnapshot,
  type RuntimeSnapshotImportOptions,
  type RuntimeSnapshotImportSummary,
} from "./runtime-snapshot-importer.ts";
export {
  compareSurfaces,
  extractRuntimeReferenceSurfaces,
  runRuntimeSnapshotParity,
  type RuntimeReferenceSurfaces,
  type RuntimeSnapshotParityBucket,
  type RuntimeSnapshotParityOptions,
  type RuntimeSnapshotParityReport,
} from "./runtime-snapshot-parity.ts";
export {
  runRuntimeSnapshotCorpus,
  type RuntimeSnapshotCorpusOptions,
  type RuntimeSnapshotCorpusReport,
  type RuntimeSnapshotCorpusScopeCandidate,
  type RuntimeSnapshotCorpusScopeReport,
} from "./runtime-snapshot-corpus.ts";
export {
  runRuntimeReferenceCorpus,
  type RuntimeReferenceCandidate,
  type RuntimeReferenceCorpusMatchedReport,
  type RuntimeReferenceCorpusOptions,
  type RuntimeReferenceCorpusReport,
  type RuntimeReferenceCorpusUnmatchedReport,
  type RuntimeReferenceScopeCandidate,
} from "./runtime-reference-corpus.ts";
export {
  runRuntimeSidecarCheck,
  type RuntimeSidecarCheckOptions,
  type RuntimeSidecarCheckReport,
  type RuntimeSidecarReferenceCorpusCheckOptions,
  type RuntimeSidecarSnapshotCheckOptions,
  type RuntimeSidecarStageSummary,
} from "./runtime-sidecar-check.ts";
export {
  runRuntimeLiveSidecarOnce,
  runRuntimeLiveSidecarWatch,
  type RuntimeLiveSidecarApplyStats,
  type RuntimeLiveSidecarCheckpoint,
  type RuntimeLiveSidecarOptions,
  type RuntimeLiveSidecarReport,
  type RuntimeLiveSidecarWatchOptions,
  type RuntimeLiveSidecarWatchReport,
} from "./runtime-live-sidecar.ts";
