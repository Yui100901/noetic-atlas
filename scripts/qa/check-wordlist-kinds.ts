/** Read-only verification of the explicit generated-wordlist setting migration. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseConnection } from '../../server/database/connection.js';
import { recordTables } from '../../server/database/schema.js';

const root = resolve(import.meta.dirname, '../..');
const operation = JSON.parse(await readFile(resolve(root, process.argv[2] || 'test-results/wordlist-kinds-applied.json'), 'utf8'));
assert.equal(operation.mode, 'apply'); assert.ok(operation.backup);
const before = new DatabaseConnection(operation.backup, false), after = new DatabaseConnection(operation.database, false);
const report: Record<string, any> = { status: 'passed', readOnly: true, wordlistsChanged: 0, tables: {} };
try {
  for (const table of recordTables) {
    const oldIds = before.all(before.query.selectFrom(table).select('id')).map(row => row.id).sort();
    const newIds = after.all(after.query.selectFrom(table).select('id')).map(row => row.id).sort();
    assert.deepEqual(newIds, oldIds, 'Record IDs changed in ' + table);
    let changed = 0;
    for (const id of oldIds) {
      const old = before.getRecord<any>(table, id), current = after.getRecord<any>(table, id);
      if (JSON.stringify(old) === JSON.stringify(current)) continue;
      assert.equal(table, 'papers', 'Unexpected change in ' + table);
      assert.match(id, /^wordlist-(english|japanese)-\d{3}$/);
      assert.notEqual(old.practiceKind, 'vocabulary'); assert.equal(current.practiceKind, 'vocabulary');
      assert.equal(current.version, old.version + 1); assert.ok(Date.parse(current.updatedAt) > Date.parse(old.updatedAt));
      const strip = ({ practiceKind: _kind, version: _version, updatedAt: _updated, ...value }: any) => value;
      assert.deepEqual(strip(current), strip(old), 'Wordlist content/archive/snapshot changed: ' + id);
      changed++; report.wordlistsChanged++;
    }
    report.tables[table] = { records: oldIds.length, changed };
  }
  assert.equal(report.wordlistsChanged, operation.updated);
  await writeFile(resolve(root, 'test-results/wordlist-kinds-independent-check.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { before.close(); after.close(); }
