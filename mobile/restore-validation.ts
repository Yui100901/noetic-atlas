import { validateSQLitePrivateRecords } from '../server/modules/transfer/sqlite-validation';
import type { SqlJsStatic } from 'sql.js';
import { buildApp } from '../server/index';
import { Store } from '../server/core/store';
import { exportData, importData } from '../server/modules/transfer/migration';
import { databaseForPath } from './shims/sqlite';
import { setVirtualFile, rmSync } from './shims/fs';
import { inspectSQLite, databaseCounts, activeExamCount, redactRestoreAiSettings } from './database/restore-database';

/** All validation and upgrades happen on virtual independent copies. No JSON
 * transport/body limit applies, and neither invalid files nor empty SQLite files
 * can be mistaken for a new installation. The returned bytes own no credentials.
 */
export async function prepareSQLiteRestore(sql: SqlJsStatic, input: Uint8Array) {
  const path = `/native/restore-${crypto.randomUUID()}.sqlite`, checkPath = `${path}.check`;
  let source: Store | undefined, checker: Store | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    setVirtualFile(path, inspectSQLite(sql, input));
    source = new Store(path);
    const empty = new sql.Database();
    try { setVirtualFile(checkPath, empty.export()); } finally { empty.close(); }
    checker = new Store(checkPath);
    // Import into a genuinely empty Store: no same-ID skipping can mask invalid
    // questions, snapshots, scoring, configuration, learning data or references.
    importData(checker, exportData(source));
    validateSQLitePrivateRecords(source);
    const sourceHadAiKey = source.database.records<any>('ai_settings').some(value => Boolean(value.key));
    setVirtualFile(path, databaseForPath(path).export());
    source.db.close(); source = undefined;
    checker.db.close(); checker = undefined;
    app = await buildApp({ databasePath: path, staticRoot: '/not-a-web-server', native: true });
    const database = databaseForPath(path);
    redactRestoreAiSettings(database);
    return { bytes: database.export(), counts: databaseCounts(database), sourceHadAiKey, activeExamCount: activeExamCount(database) };
  } finally {
    source?.db.close(); checker?.db.close(); if (app) await app.close();
    rmSync(path); rmSync(checkPath);
  }
}

/** Recovery copies stay private with local credentials. Sharing one deliberately
 * uses the same validated, credential-free form as a normal SQLite export. */
export async function shareableRecoveryBytes(sql: SqlJsStatic, bytes: Uint8Array) { return (await prepareSQLiteRestore(sql, bytes)).bytes; }
