/** Compare persisted business rows; derived search/PDF caches are rebuildable. */
import { createHash } from 'node:crypto';
import { DatabaseConnection } from '../../../server/database/connection.ts';
import { recordTables } from '../../../server/database/schema.ts';

export function businessSnapshot(path) {
  const db = new DatabaseConnection(path, false);
  try {
    const result = {};
    for (const table of recordTables.filter(
      (name) => !name.startsWith('pdf_') && name !== 'quality_fingerprints',
    )) {
      if (!db.hasTable(table)) continue;
      const rows = db.all(db.query.selectFrom(table).select(['id', 'data']).orderBy('id'));
      const hash = createHash('sha256');
      for (const row of rows) hash.update(JSON.stringify([row.id, row.data]) + '\n');
      result[table] = { count: rows.length, sha256: hash.digest('hex') };
    }
    return result;
  } finally {
    db.close();
  }
}
