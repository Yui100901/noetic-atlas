import test from 'node:test';
import assert from 'node:assert/strict';
import type { Question } from '../../shared/models/types.js';
import { Store } from '../../server/core/store.js';
import { parse, questionSchema } from '../../server/core/validation.js';
import { buildApp } from '../../server/index.js';
import { exportData, importData } from '../../server/modules/transfer/migration.js';
import { exportShare, planShareImport } from '../../server/modules/sharing/service.js';
import { buildPaper } from '../../server/modules/practice/service.js';
import { normalizeScoring } from '../../server/modules/practice/scoring.js';
import { reviewedShareImport as importShare } from '../helpers/import-review.js';

const stamp = '2026-11-10T00:00:00.000Z';
const question = (id: string): Question => ({
  ...parse(questionSchema, {
    id,
    title: id,
    type: 'short_answer',
    stemMarkdown: '解释适用条件',
    answerMarkdown: '说明成立条件及不适用情形。',
    status: 'published',
  }),
  id,
  createdAt: stamp,
  updatedAt: stamp,
});
function fixture(t: test.TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  return store;
}

test('retired collection inputs are rejected atomically instead of silently converted or discarded', (t) => {
  const source = fixture(t),
    target = fixture(t),
    q = question('q');
  source.put('questions', q.id, q);
  const collection = { id: 'retired', name: '退役集合', description: '', questionIds: [q.id] };
  assert.throws(() => importData(target, { ...exportData(source), questionBanks: [collection] }));
  assert.throws(() =>
    planShareImport(target, {
      ...exportShare(source, { kind: 'questions', ids: [q.id] }),
      questionBanks: [collection],
    }),
  );
  assert.deepEqual(target.all('questions'), []);
  assert.deepEqual(target.all('papers'), []);
});

test('current set origin metadata round-trips while restore retains its frozen version and scoring', async (t) => {
  const source = fixture(t),
    q = question('frozen');
  source.put('questions', q.id, q);
  const paper = {
    ...buildPaper(source, {
      id: 'existing-set',
      title: '已有题集',
      description: '',
      mode: 'manual',
      questionIds: [q.id],
      scoring: { enabled: false },
    }),
    legacyBankId: 'origin-marker',
    archived: true,
  };
  source.put('papers', paper.id, paper);
  source.put('questions', q.id, { ...q, stemMarkdown: '源题后续已更新' });
  const app = await buildApp({
    databasePath: ':memory:',
    staticRoot: 'test-results/no-baseline-web',
  });
  t.after(() => app.close());
  const imported = await app.inject({
    method: 'POST',
    url: '/api/import',
    payload: {
      mode: 'merge',
      data: exportData(source),
    },
  });
  assert.equal(imported.statusCode, 200, imported.body);
  const restored = await app.inject({
    method: 'POST',
    url: `/api/papers/${paper.id}/restore`,
    payload: { confirmed: true },
  });
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal(restored.json().version, paper.version);
  assert.deepEqual(restored.json().scoring, paper.scoring);
  const detail = await app.inject(`/api/papers/${paper.id}/questions/${q.id}`);
  assert.equal(detail.json().stemMarkdown, q.stemMarkdown);
  const exported = (await app.inject('/api/export')).json();
  assert.equal(exported.papers[0].legacyBankId, 'origin-marker');
  assert.deepEqual(exported.questionBanks, []);
});

test('current large and empty archived sets retain ordered membership through sharing', (t) => {
  const source = fixture(t),
    target = fixture(t);
  const questions = Array.from({ length: 501 }, (_, index) => question(`q-${index}`));
  for (const q of questions) source.put('questions', q.id, q);
  for (const [id, snapshot] of [
    ['large', questions],
    ['empty', []],
  ] as const) {
    const ids = snapshot.map((q) => q.id);
    source.put('papers', id, {
      id,
      title: id,
      description: '',
      mode: 'manual',
      questionIds: ids,
      questionCount: ids.length,
      archived: true,
      filters: null,
      version: 1,
      snapshot,
      scoring: normalizeScoring([...snapshot], { enabled: false }),
      organization: 'other',
      domainId: null,
      createdAt: stamp,
      updatedAt: stamp,
    });
    importShare(target, exportShare(source, { kind: 'paper', id }));
    assert.deepEqual(target.require('papers', id).questionIds, ids);
    assert.equal(target.require('papers', id).scoring.enabled, false);
  }
});
