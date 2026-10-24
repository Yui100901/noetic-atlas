/** Native-only transfer contract. File bytes never enter the JSON HTTP API. */
export interface SQLiteRecoveryBackup { id: string; createdAt: string; byteLength: number }
export interface SQLiteRestorePreview {
  token: string;
  filename: string;
  byteLength: number;
  sha256: string;
  schemaVersion: 1;
  counts: Record<string, number>;
  currentCounts: Record<string, number>;
  sourceHadAiKey: boolean;
  activeExamCount: number;
}
export interface SQLiteRestoreResult { recoveryBackup: SQLiteRecoveryBackup }
