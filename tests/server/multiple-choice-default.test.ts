import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../server/core/store.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';
import { setMultipleChoiceDefault } from '../../scripts/maintenance/set-multiple-choice-default.js';
import { buildPaper } from '../../server/modules/practice/service.js';
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
