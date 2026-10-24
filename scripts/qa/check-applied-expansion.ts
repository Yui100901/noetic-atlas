/** Independent read-only comparison against the verified pre-enrichment backup. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseConnection } from '../../server/database/connection.js';
import { tables } from '../../server/core/store.js';
import type { Question } from '../../shared/models/types.js';
import { vocabularyPromptIsSafe } from '../../shared/questions/vocabulary.js';
import { validatePack } from '../content/manage.js';

const root = resolve(import.meta.dirname, '../..');
const report = JSON.parse(await readFile(resolve(root, process.argv[2] || 'test-results/content-expansion-applied.json'), 'utf8'));
assert.equal(report.mode, 'apply'); assert.ok(report.backup && report.database);
const canonical = (value: any): string => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}' : JSON.stringify(value);
const sha = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const before = new DatabaseConnection(report.backup, false), after = new DatabaseConnection(report.database, false);
const summary: Record<string, any> = { readOnly: true, originalQuestionsUnchangedExceptVocabularyAndAddedSources: 0, vocabulary: { en: 0, ja: 0 }, questionStatuses: {}, tables: {} };
try {
  const expected = new Map<string, Question>();
  for (const name of report.packs) {
    assert.match(name, /^[a-z0-9-]+$/);
    const pack = validatePack(JSON.parse(await readFile(resolve(root, 'data/content-packs', name + '.json'), 'utf8')));
    for (const question of pack.questions) expected.set(question.id!, question);
  }
  for (const table of tables) {
    const oldIds = before.all(before.query.selectFrom(table).select('id')).map(row => row.id);
    const newIds = after.all(after.query.selectFrom(table).select('id')).map(row => row.id);
    const newSet = new Set(newIds);
    assert.ok(oldIds.every(id => newSet.has(id)), 'Removed record in ' + table);
    const oldSet = new Set(oldIds), added = newIds.filter(id => !oldSet.has(id));
    for (const id of oldIds) {
      const old = before.getRecord<any>(table, id), current = after.getRecord<any>(table, id);
      if (table === 'questions') {
        summary.questionStatuses[current.status] = (summary.questionStatuses[current.status] || 0) + 1;
        const { vocabulary: _oldVocabulary, sourceRefs: oldSources, ...oldBody } = old;
        const { vocabulary: _currentVocabulary, sourceRefs: currentSources, ...currentBody } = current;
        assert.equal(sha(currentBody), sha(oldBody), 'Original question text/status/timestamp changed: ' + id);
        assert.deepEqual(currentSources.slice(0, oldSources.length), oldSources, 'Original sources changed: ' + id);
        if (/^(EN|JA)-V-/.test(id)) {
          assert.ok(current.vocabulary?.pronunciations.length, 'Missing pronunciation: ' + id);
          assert.ok(vocabularyPromptIsSafe(current.vocabulary), 'Unsafe hint: ' + id);
          summary.vocabulary[current.vocabulary.language]++;
        } else assert.equal(sha(current), sha(old), 'Non-vocabulary record changed: ' + id);
        summary.originalQuestionsUnchangedExceptVocabularyAndAddedSources++;
      } else assert.equal(sha(current), sha(old), 'Original record changed: ' + table + '/' + id);
    }
    if (table === 'questions') {
      assert.equal(added.length, expected.size);
      for (const id of added) {
        const current = after.getRecord<Question>(table, id)!;
        assert.equal(sha(current), sha(expected.get(id)), 'New question differs from validated pack: ' + id);
        summary.questionStatuses[current.status] = (summary.questionStatuses[current.status] || 0) + 1;
      }
    } else if (!['domains', 'categories', 'tags'].includes(table)) assert.equal(added.length, 0, 'Unexpected private record additions: ' + table);
    summary.tables[table] = { before: oldIds.length, after: newIds.length, added: added.length };
  }
  assert.deepEqual(summary.vocabulary, { en: 10000, ja: 10000 });
  assert.equal(summary.tables.questions.after, 30931);
  assert.deepEqual(summary.questionStatuses, { published: 30150, pending: 781 });
  summary.status = 'passed';
  await writeFile(resolve(root, 'test-results/content-expansion-independent-check.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
} finally { before.close(); after.close(); }
