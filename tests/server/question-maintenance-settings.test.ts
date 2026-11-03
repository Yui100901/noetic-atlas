import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../../server/core/store.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';
import {
  getSettings,
  settingsRetentionPlan,
  saveSettings,
  settingsSchema,
} from '../../server/modules/settings/service.js';
import {
  exportConfiguration,
  previewConfiguration,
  importConfiguration,
} from '../../server/modules/settings/configuration.js';

const stamp = (day: number) => `2026-11-${String(day).padStart(2, '0')}T00:00:00.000Z`;
function fixture(t: test.TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.database.close());
  store.put('questions', 'Q', {
    id: 'Q',
    title: '源题',
    type: 'short_answer',
    stemMarkdown: '解释事务。',
  });
  for (let n = 1; n <= 3; n++) {
    store.put('question_drafts', 'D' + n, {
      id: 'D' + n,
      questionId: 'Q',
      createdAt: stamp(n),
      updatedAt: stamp(n),
      baseUpdatedAt: null,
      state: { form: { title: '未完成草稿' + n }, sources: '', reason: '' },
    });
    store.put('question_revisions', 'R' + n, {
      id: 'R' + n,
      questionId: 'Q',
      sequence: n,
      createdAt: stamp(n),
      sourceUpdatedAt: stamp(n),
      content: { title: '历史内容' + n },
      changedFields: ['title'],
      origin: 'manual',
      reason: '',
    });
  }
  store.put('question_drafts', 'NEW', {
    id: 'NEW',
    questionId: null,
    createdAt: stamp(1),
    updatedAt: stamp(1),
    baseUpdatedAt: null,
    state: { form: {}, sources: '', reason: '' },
  });
  return store;
}

test('question maintenance has bounded portable defaults and rejects invalid limits', (t) => {
  const store = fixture(t);
  assert.equal(getSettings(store).maxQuestionDrafts, 3);
  assert.equal(getSettings(store).maxQuestionRevisions, 20);
  assert.equal(exportConfiguration(store).system.maxQuestionDrafts, 3);
  for (const patch of [
    { maxQuestionDrafts: 0 },
    { maxQuestionDrafts: 101 },
    { maxQuestionRevisions: 0 },
    { maxQuestionRevisions: 101 },
  ])
    assert.equal(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...patch }).success, false);
});

test('lower limits preview and confirm per-question retention without touching source or learning data', (t) => {
  const store = fixture(t),
    before = store.all('questions');
  const settings = { ...getSettings(store), maxQuestionDrafts: 1, maxQuestionRevisions: 1 };
  const plan = settingsRetentionPlan(store, settings);
  assert.equal(plan.retention.questionDrafts, 2);
  assert.equal(plan.retention.questionRevisions, 2);
  assert.equal(plan.retention.total, 4);
  assert.throws(() => store.transaction(() => saveSettings(store, settings)), /确认/);
  assert.equal(store.all('question_drafts').length, 4);
  store.transaction(() =>
    saveSettings(store, settings, { confirmedRetention: true, expectedRetention: plan.retention }),
  );
  assert.deepEqual(
    store
      .all('question_drafts')
      .map((row) => row.id)
      .sort(),
    ['D3', 'NEW'],
  );
  assert.deepEqual(
    store.all('question_revisions').map((row) => row.id),
    ['R3'],
  );
  assert.deepEqual(store.all('questions'), before);
  assert.equal(store.all('attempts').length, 0);
});

test('a same-count maintenance edit invalidates a portable configuration cleanup preview', (t) => {
  const store = fixture(t),
    data = exportConfiguration(store);
  data.system.maxQuestionRevisions = 1;
  const plan = previewConfiguration(store, data);
  const previous = store.require<any>('question_revisions', 'R1');
  store.put('question_revisions', 'R1', { ...previous, reason: '预览后修改了同一条内容' });
  assert.throws(
    () =>
      importConfiguration(store, {
        data,
        fingerprint: plan.fingerprint,
        confirmed: true,
        confirmedRetention: true,
      }),
    /预览/,
  );
  assert.equal(store.all('question_revisions').length, 3);
  assert.equal(getSettings(store).maxQuestionRevisions, 20);
});
