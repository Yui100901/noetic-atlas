import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../server/core/store.js';
import { questionSchema } from '../../server/core/validation.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';
import { getSettings } from '../../server/modules/settings/service.js';
import { recordManualReview, changeReviewCard } from '../../server/modules/review-scheduler/service.js';
import { selectDailyQuestions } from '../../server/modules/daily-push/selection.js';
import { checkDailyPush } from '../../server/modules/daily-push/service.js';
import { dailyPushRecordSchema } from '../../server/modules/daily-push/schema.js';
import { exportData, importData } from '../../server/modules/transfer/migration.js';

const at = new Date('2026-10-26T04:00:00.000Z');
function fixture(t: test.TestContext) {
  const store = new Store(':memory:'); t.after(() => store.db.close());
  store.put('domains', 'adaptive-domain', { id: 'adaptive-domain', name: '统计范围', description: '', sortOrder: 0 });
  store.put('categories', 'adaptive-category', { id: 'adaptive-category', domainId: 'adaptive-domain', parentId: null, name: '基础', description: '', sortOrder: 0 });
  const settings = structuredClone(DEFAULT_SETTINGS); settings.pointsByType.true_false = 10;
  settings.dailyPush = { ...settings.dailyPush, enabled: true, domainId: 'adaptive-domain', categoryIds: ['adaptive-category'] }; store.put('settings', 'system', settings);
  const add = (id: string) => { const q = questionSchema.parse({ id, title: id, type: 'true_false', stemMarkdown: '判断命题', correctAnswers: ['true'], status: 'published', categoryIds: ['adaptive-category'] }); store.put('questions', id, q); return q; };
  const select = () => selectDailyQuestions(store, getSettings(store).dailyPush, getSettings(store).pointsByType, at);
  return { store, add, select };
}

test('adaptive daily pushing excludes future and suspended plans while transferring unused review budget to fresh items', t => {
  const { store, add, select } = fixture(t);
  for (let n = 0; n < 6; n++) add('fresh-' + n);
  add('future'); recordManualReview(store, { questionId: 'future', rating: 'good', requestId: 'future-initial' }, at);
  add('paused'); recordManualReview(store, { questionId: 'paused', rating: 'again', requestId: 'paused-initial' }, new Date(at.getTime() - 86400000));
  changeReviewCard(store, { questionId: 'paused', suspended: true }, at);
  const result = select(); assert.equal(result.reviewQuestionIds.length, 0); assert.equal(result.newPoints, 50); assert.equal(result.transferredPoints, 30);
  assert.ok(!result.questionIds.includes('future')); assert.ok(!result.questionIds.includes('paused'));
});

test('due backlog can use new-item budget, is optional, and portable snapshots explain the reallocation', t => {
  const { store, add, select } = fixture(t);
  for (let n = 0; n < 5; n++) { add('due-' + n); recordManualReview(store, { questionId: 'due-' + n, rating: 'again', requestId: 'due-event-' + n }, new Date(at.getTime() - 86400000)); }
  for (let n = 0; n < 6; n++) add('new-' + n);
  const result = select(); assert.equal(result.reviewPoints, 50); assert.equal(result.newPoints, 0); assert.equal(result.reallocatedPoints, 20); assert.equal(result.targetNewPoints, 0);
  const record = checkDailyPush(store, at).record!; dailyPushRecordSchema.parse(record); assert.equal(record.reallocatedPoints, 20);
  const target = new Store(':memory:'); t.after(() => target.db.close()); importData(target, exportData(store)); assert.equal(target.require<any>('daily_pushes', record.id).reallocatedPoints, 20); assert.equal(target.all('review_events').length, 5);
  const settings = getSettings(store); store.put('settings', 'system', { ...settings, reviewScheduling: { ...settings.reviewScheduling, reduceNewWhenOverdue: false } });
  const fixedBudget = select(); assert.equal(fixedBudget.reviewPoints, 30); assert.equal(fixedBudget.newPoints, 20); assert.equal(fixedBudget.reallocatedPoints, undefined);
});

test('minute relearning waits until due, while legacy dates retain their daily plan and never fabricate FSRS events', t => {
  const { store, add, select } = fixture(t);
  add('minute'); recordManualReview(store, { questionId: 'minute', rating: 'again', requestId: 'minute-event' }, at);
  add('legacy'); store.putStudy({ questionId: 'legacy', mastery: 2, favorite: false, notes: '', lastReviewedAt: '2026-10-01T00:00:00Z', nextReviewAt: '2026-10-26T10:00:00Z', wrongCount: 0 });
  for (let n = 0; n < 6; n++) add('fresh-' + n);
  const selected = select(); assert.ok(selected.reviewQuestionIds.includes('legacy')); assert.ok(!selected.reviewQuestionIds.includes('minute')); assert.equal(store.all('review_events').length, 1);
  const later = selectDailyQuestions(store, getSettings(store).dailyPush, getSettings(store).pointsByType, new Date(at.getTime() + 120000));
  assert.ok(later.reviewQuestionIds.includes('minute'));
});

test('a due group is chosen once and queue planning reads no source question bodies or notes', t => {
  const { store, add, select } = fixture(t);
  const group = questionSchema.parse({ id: 'GROUP', title: '公共材料', type: 'group', stemMarkdown: 'QUESTION_CANARY', categoryIds: ['adaptive-category'], status: 'published', parts: [
    { id: 'a', title: '小题A', type: 'true_false', stemMarkdown: '判断', correctAnswers: ['true'] },
    { id: 'b', title: '小题B', type: 'true_false', stemMarkdown: '判断', correctAnswers: ['true'] },
  ] }); store.put('questions', group.id, group);
  recordManualReview(store, { questionId: group.id, partId: 'a', rating: 'again', requestId: 'group-a' }, new Date(at.getTime() - 86400000));
  recordManualReview(store, { questionId: group.id, partId: 'b', rating: 'good', requestId: 'group-b' }, at);
  for (let n = 0; n < 6; n++) add('fresh-' + n);
  store.database.projections.refreshAll(); const all = store.database.all.bind(store.database);
  store.database.all = ((query: any) => { const rows = all(query); assert.doesNotMatch(JSON.stringify(rows), /QUESTION_CANARY/); return rows; }) as typeof store.database.all;
  store.database.run = () => { throw new Error('selection GET must not write'); };
  const result = select(); assert.equal(result.reviewQuestionIds.filter(id => id === 'GROUP').length, 1);
});
