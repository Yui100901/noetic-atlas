/** Compare user records against the online backup after the one-field update. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseConnection } from '../../server/database/connection.js';
import { recordTables, type RecordTable } from '../../server/database/schema.js';

const reportPath = resolve('test-results/daily-push-defaults-applied.json');
const applied = JSON.parse(await readFile(reportPath, 'utf8'));
assert.equal(applied.mode, 'apply'); assert.ok(applied.backup);
const before = new DatabaseConnection(applied.backup, false);
const after = new DatabaseConnection(applied.database, false);
try {
  const previous = before.getRecord<any>('settings', 'system');
  const current = after.getRecord<any>('settings', 'system');
  assert.equal(current.pointsByType.multiple_choice, 4);
  const expected = { ...previous, updatedAt: current.updatedAt, pointsByType: { ...previous.pointsByType, multiple_choice: 4 } };
  assert.deepEqual(current, expected, 'Only the system multiple-choice default and its timestamp may change');
  assert.equal(current.dailyPush?.enabled ?? false, false);
  function fingerprint(db: DatabaseConnection, table: RecordTable) {
    const hash = createHash('sha256'); let count = 0;
    if (db.hasTable(table)) {
      // QA reads rows incrementally, never loading the working question/paper
      // snapshots into a second full object graph. Runtime services use Kysely.
      const query = db.query.selectFrom(table).select(['id', 'data']).orderBy('id').compile();
      for (const row of db.prepare(query.sql).iterate(...query.parameters as any[]) as Iterable<{ id: string; data: string }>) {
        if (table === 'settings' && row.id === 'system') continue;
        hash.update(JSON.stringify([row.id, row.data])); count++;
      }
    }
    return { count, sha256: hash.digest('hex') };
  }
  const tables: Record<string, { count: number; sha256: string }> = {};
  for (const table of recordTables) {
    const original = fingerprint(before, table), updated = fingerprint(after, table);
    assert.deepEqual(updated, original, `Unexpected changed user records: ${table}`); tables[table] = updated;
  }
  const report = { checkedAt: new Date().toISOString(), changedFields: ['settings.system.pointsByType.multiple_choice', 'settings.system.updatedAt'], before: previous.pointsByType.multiple_choice, after: 4, dailyPushEnabled: false, unchangedTables: tables };
  await writeFile(resolve('test-results/daily-push-defaults-independent-check.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, before: report.before, after: report.after, dailyPushEnabled: false, unchangedCounts: Object.fromEntries(Object.entries(tables).map(([table, value]) => [table, value.count])) }));
} finally { before.close(); after.close(); }
