/** Verify approval scope and every business record against the pre-write backup. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseConnection } from '../../server/database/connection.js';
import { recordTables } from '../../server/database/schema.js';
import { loadCommonPacks } from '../content/common-2026-10/apply-common.js';

const root = resolve(import.meta.dirname, '../..');
const operation = JSON.parse(await readFile(resolve(root, process.argv[2] || 'test-results/common-content-applied.json'), 'utf8'));
assert.equal(operation.mode, 'apply'); assert.ok(operation.backup);
const canonical = (value: any): string => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}' : JSON.stringify(value);
const sha = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const before = new DatabaseConnection(operation.backup, false), after = new DatabaseConnection(operation.database, false);
const targets = new Set<string>(operation.targetIds), packs = await loadCommonPacks(operation.packs);
const expected = new Map(packs.flatMap(pack => pack.questions).map(question => [question.id!, question]));
const stripReview = ({ status: _status, updatedAt: _time, ...record }: any) => record;
const report: Record<string, any> = { status: 'passed', readOnly: true, changedPreviousQuestions: 0, addedQuestions: 0, statuses: {}, tables: {} };
try {
  for (const table of recordTables) {
    const oldIds = before.all(before.query.selectFrom(table).select('id')).map(row => row.id), oldSet = new Set(oldIds);
    const newIds = after.all(after.query.selectFrom(table).select('id')).map(row => row.id), newSet = new Set(newIds);
    assert.ok(oldIds.every(id => newSet.has(id)), 'Record removed from ' + table);
    let changed = 0;
    for (const id of oldIds) {
      const old = before.getRecord<any>(table, id), current = after.getRecord<any>(table, id);
      if (table === 'questions') report.statuses[current.status] = (report.statuses[current.status] || 0) + 1;
      if (sha(old) === sha(current)) continue;
      assert.equal(table, 'questions', 'Unexpected existing record change: ' + table + '/' + id);
      assert.ok(targets.has(id), 'Unapproved question changed: ' + id);
      assert.equal(sha(stripReview(old)), sha(stripReview(current)), 'Question body/answers/tags changed: ' + id);
      assert.equal(current.status, 'published'); assert.ok(Date.parse(current.updatedAt) > Date.parse(old.updatedAt));
      changed++; report.changedPreviousQuestions++;
    }
    const added = newIds.filter(id => !oldSet.has(id));
    if (table === 'questions') for (const id of added) {
      const current = after.getRecord<any>(table, id); assert.ok(expected.has(id), 'Unexpected new question');
      assert.equal(sha(stripReview(current)), sha(stripReview(expected.get(id))), 'New question differs from validated source: ' + id);
      assert.equal(current.status, 'published'); report.statuses[current.status] = (report.statuses[current.status] || 0) + 1; report.addedQuestions++;
    }
    else if (!['domains', 'categories', 'tags'].includes(table)) assert.equal(added.length, 0, 'Unexpected private additions: ' + table);
    report.tables[table] = { before: oldIds.length, after: newIds.length, changed, added: added.length };
  }
  assert.equal(report.addedQuestions, operation.counts.add);
  assert.equal(report.addedQuestions + report.changedPreviousQuestions, operation.approved);
  for (const id of targets) assert.equal(after.getRecord<any>('questions', id)?.status, 'published');
  await writeFile(resolve(root, 'test-results/common-content-independent-check.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { before.close(); after.close(); }
