import type { DatabaseConnection } from '../../database/connection.js';
import { cleanLearningRecord, learningMetadataTables } from '../../../shared/questions/learning-records.js';

/** Explicit, atomic maintenance operation; callers back up persistent databases first.
 * Also used on the temporary copy supplied by the SQLite download endpoint.
 * It never deletes records or rewrites text/history, and performs no automatic startup migration.
 */
export function cleanStoredLearningMetadata(database: DatabaseConnection) {
  const counts = Object.fromEntries(learningMetadataTables.map(table => [table, 0])) as Record<typeof learningMetadataTables[number], number>;
  return database.transaction(() => {
    for (const table of learningMetadataTables) {
      if (!database.hasTable(table)) continue;
      const rows = database.all(database.query.selectFrom(table).select(['id','data']));
      for (const row of rows) {
        const original: unknown = JSON.parse(row.data), cleaned = cleanLearningRecord(table, original);
        if (cleaned !== original) { database.putRecord(table,row.id,cleaned);counts[table]++; }
      }
    }
    return counts;
  });
}
