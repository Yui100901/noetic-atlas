import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../server/core/store.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';
import { setMultipleChoiceDefault } from '../../scripts/maintenance/set-multiple-choice-default.js';
import { buildPaper, createAttempt, submitAttempt } from '../../server/modules/practice/service.js';
import { normalizeScoring, LEGACY_POINTS } from '../../server/modules/practice/scoring.js';
import { exportData } from '../../server/modules/transfer/migration.js';
import { buildApp } from '../../server/index.js';
import { questionSchema } from '../../server/core/validation.js';
import type { Question } from '../../shared/models/types.js';

test('changing the system multiple-choice default preserves customized settings and existing paper scores', t => {
  const store = new Store(':memory:'); t.after(() => store.db.close());
  const settings = { ...structuredClone(DEFAULT_SETTINGS), theme: 'mint', maxQuestionHistory: 17, updatedAt: '2026-10-01T00:00:00Z', pointsByType: { ...DEFAULT_SETTINGS.pointsByType, multiple_choice: 2, single_choice: 5 } };
  store.put('settings', 'system', settings);
  const question = questionSchema.parse({ id: 'DEFAULT-MC', title: '多选', type: 'multiple_choice', stemMarkdown: '选出两项', options: [{ key: 'A', text: '一' }, { key: 'B', text: '二' }, { key: 'C', text: '三' }], correctAnswers: ['A','B'], answerMarkdown: '一、二', status: 'published' }) as Question;
  store.put('questions', question.id!, question);
  const paper = buildPaper(store, { title: '已保存2分题集', description: '', mode: 'manual', questionIds: [question.id!], scoring: { enabled: true } }); store.put('papers', paper.id, paper);
  assert.equal(paper.scoring!.questionPoints[question.id!], 2);
  assert.equal(setMultipleChoiceDefault(store).changed, true);
  const saved = store.require<any>('settings', 'system');
  assert.equal(saved.pointsByType.multiple_choice, 4); assert.equal(saved.pointsByType.single_choice, 5);
  assert.equal(saved.theme, 'mint'); assert.equal(saved.maxQuestionHistory, 17); assert.deepEqual(saved.dailyPush, settings.dailyPush);
  assert.deepEqual(store.require('papers', paper.id), paper);
  const fresh = buildPaper(store, { title: '新4分题集', description: '', mode: 'manual', questionIds: [question.id!], scoring: { enabled: true } });
  assert.equal(fresh.scoring!.questionPoints[question.id!], 4);
  assert.equal(setMultipleChoiceDefault(store).changed, false);
});

test('unscored snapshots keep their original type defaults while all actual points remain zero', () => {
  const question = questionSchema.parse({ id: 'OLD-WORD', title: '旧无分题', type: 'short_answer', stemMarkdown: '解释概念', answerMarkdown: '概念', status: 'published' }) as Question;
  const oldDefaults = { ...DEFAULT_SETTINGS.pointsByType, multiple_choice: 2, single_choice: 7 };
  const scoring = normalizeScoring([question], { enabled: false, pointsByType: oldDefaults });
  assert.deepEqual(scoring.pointsByType, oldDefaults);
  assert.equal(scoring.scheme, 'none'); assert.equal(scoring.totalPoints, 0); assert.equal(scoring.questionPoints[question.id!], 0);
  assert.deepEqual(normalizeScoring([question], scoring), scoring);
  assert.throws(() => normalizeScoring([question], { ...scoring, totalPoints: 1 }));
  assert.throws(() => normalizeScoring([question], { ...scoring, questionPoints: { [question.id!]: 1 } }));
  assert.throws(() => normalizeScoring([question], { ...scoring, enabled: true }));
  const legacy = normalizeScoring([question]);
  assert.deepEqual(legacy.pointsByType, LEGACY_POINTS);
  assert.throws(() => normalizeScoring([question], { ...legacy, pointsByType: { ...LEGACY_POINTS, multiple_choice: 4 } }));
});

test('old unscored papers, drafts and submitted history survive HTTP reads and backup merge after default changes', async t => {
  const source = new Store(':memory:'); t.after(() => source.db.close());
  source.put('settings', 'system', { ...structuredClone(DEFAULT_SETTINGS), pointsByType: { ...DEFAULT_SETTINGS.pointsByType, multiple_choice: 2 } });
  const question = questionSchema.parse({ id: 'OLD-UNSCORED', title: '旧无分题集题目', type: 'true_false', stemMarkdown: '判断命题', correctAnswers: ['true'], answerMarkdown: '正确', status: 'published' }) as Question;
  source.put('questions', question.id!, question);
  const paper = buildPaper(source, { title: '旧无分题集', description: '', mode: 'manual', questionIds: [question.id!], scoring: { enabled: false } });
  source.put('papers', paper.id, paper);
  const submitted = submitAttempt(source, createAttempt(source, paper), { [question.id!]: { value: ['true'] } });
  const draft = createAttempt(source, paper), original = JSON.stringify(source.require('papers', paper.id));
  assert.equal(paper.scoring!.pointsByType.multiple_choice, 2);
  setMultipleChoiceDefault(source);
  const app = await buildApp({ databasePath: ':memory:', staticRoot: 'no-scoring-test-assets', dailyPushScheduler: false }); t.after(() => app.close());
  const api = async (url: string, method: any = 'GET', payload?: unknown, expected = 200): Promise<any> => {
    const response = await app.inject({ url, method, ...(payload === undefined ? {} : { payload }) });
    assert.equal(response.statusCode, expected, response.body); return response.json();
  };
  await api('/api/import', 'POST', { mode: 'merge', data: exportData(source) });
  assert.equal((await api('/api/settings')).pointsByType.multiple_choice, 4);
  assert.equal((await api('/api/papers')).length, 1);
  assert.equal((await api('/api/papers?pageSize=10')).items[0].scoring.pointsByType.multiple_choice, 2);
  for (const suffix of ['', '?summary=true']) {
    const detail = await api(`/api/papers/${paper.id}${suffix}`);
    assert.equal(detail.scoring.enabled, false); assert.equal(detail.scoring.totalPoints, 0); assert.equal(detail.scoring.pointsByType.multiple_choice, 2);
  }
  assert.equal((await api(`/api/papers/${paper.id}/drafts`))[0].id, draft.id);
  assert.equal((await api(`/api/attempts/${submitted.id}`)).scoring.pointsByType.multiple_choice, 2);
  assert.equal((await api(`/api/attempts?paperId=${paper.id}&status=submitted`)).length, 1);
  const started = await api(`/api/papers/${paper.id}/attempts`, 'POST', {}, 201);
  assert.equal(started.scoring.totalPoints, 0); assert.equal(started.scoring.pointsByType.multiple_choice, 2);
  const markdown = await app.inject(`/api/papers/${paper.id}/export`); assert.equal(markdown.statusCode, 200);
  const share = await api('/api/sharing/export', 'POST', { kind: 'paper', id: paper.id });
  assert.equal(share.papers[0].scoring.pointsByType.multiple_choice, 2);
  const exported = await api('/api/export'); assert.equal(exported.papers[0].scoring.pointsByType.multiple_choice, 2);
  const recipient = new Store(':memory:'); t.after(() => recipient.db.close());
  const { importData } = await import('../../server/modules/transfer/migration.js'); importData(recipient, exported);
  assert.equal(recipient.require<any>('papers', paper.id).scoring.pointsByType.multiple_choice, 2);
  assert.equal(JSON.stringify(source.require('papers', paper.id)), original);
});
