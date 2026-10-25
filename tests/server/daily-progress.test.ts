import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../server/core/store.js';
import { questionSchema } from '../../server/core/validation.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';
import type { Question } from '../../shared/models/types.js';
import type { DailyPushRecord } from '../../shared/models/daily-push.js';
import { checkDailyPush, dailyPushOverview } from '../../server/modules/daily-push/service.js';
import { dailyPushRecordSchema } from '../../server/modules/daily-push/schema.js';
import { createAttempt, reviewAttempt, saveAttempt, submitAttempt, type StoredPaper } from '../../server/modules/practice/service.js';
import { getSettings } from '../../server/modules/settings/service.js';
import { exportData, importData } from '../../server/modules/transfer/migration.js';

const at = new Date('2026-10-25T04:00:00Z');
function fixture(t: test.TestContext) {
  const store = new Store(':memory:'); t.after(() => store.db.close());
  store.put('domains', 'daily-domain', { id: 'daily-domain', name: '隔离领域', description: '', sortOrder: 0 });
  store.put('categories', 'daily-category', { id: 'daily-category', domainId: 'daily-domain', name: '隔离分类', description: '', parentId: null, sortOrder: 0 });
  store.put('settings', 'system', { ...structuredClone(DEFAULT_SETTINGS), pointsByType: { ...DEFAULT_SETTINGS.pointsByType, true_false: 10, short_answer: 10, group: 20 }, dailyPush: { ...DEFAULT_SETTINGS.dailyPush, enabled: true, domainId: 'daily-domain', categoryIds: ['daily-category'] } });
  for (const [id, type] of [['TF-1', 'true_false'], ['TF-2', 'true_false'], ['SHORT', 'short_answer'], ['GROUP', 'group']] as const) {
    const common = { id, title: id, type, stemMarkdown: 'PRIVATE_QUESTION_CANARY', answerMarkdown: 'REFERENCE_ANSWER_CANARY', explanationMarkdown: '解析', categoryIds: ['daily-category'], status: 'published' };
    const question = questionSchema.parse(type === 'group' ? { ...common, parts: [
      { id: 'tf', title: '小题一', type: 'true_false', stemMarkdown: 'PRIVATE_GROUP_CANARY', correctAnswers: ['true'], weight: 1 },
      { id: 'short', title: '小题二', type: 'short_answer', stemMarkdown: 'PRIVATE_GROUP_CANARY', answerMarkdown: 'REFERENCE_ANSWER_CANARY', weight: 1 },
    ] } : { ...common, ...(type === 'true_false' ? { correctAnswers: ['true'] } : {}) }) as Question;
    store.put('questions', id, question);
  }
  const record = checkDailyPush(store, at).record!, paper = store.require<StoredPaper>('papers', record.paperId!);
  const progress = () => dailyPushOverview(store, at).today!.progress;
  const fullAnswers = () => Object.fromEntries(createAttemptQuestions().map(item => [item.id, { value: item.type === 'true_false' ? ['true'] : 'PRIVATE_STUDENT_CANARY' }]));
  const createAttemptQuestions = () => record.answerItems!;
  return { store, record, paper, progress, fullAnswers };
}

test('saved answers show weighted coverage and zero scores still represent completed work', t => {
  const { store, record, paper, progress, fullAnswers } = fixture(t);
  assert.equal(record.answerItems!.length, 5); assert.equal(record.totalPoints, 50);
  assert.equal(progress().status, 'not_started'); assert.equal(progress().totalQuestions, 5);
  const attempt = createAttempt(store, paper);
  assert.equal(progress().status, 'in_progress'); assert.equal(progress().resumeAttemptId, attempt.id);
  saveAttempt(store, attempt, { 'TF-1': { value: ['false'] }, SHORT: { value: '\u3000\t\n' }, 'GROUP::short': { value: '  ' } });
  let current = progress(); assert.equal(current.answeredQuestions, 1); assert.equal(current.answeredPoints, 10); assert.equal(current.percent, 20);
  submitAttempt(store, attempt);
  current = progress(); assert.equal(current.status, 'submitted'); assert.equal(current.omittedQuestions, 4); assert.equal(current.pendingGradingCount, 0);
  const complete = submitAttempt(store, createAttempt(store, paper), fullAnswers());
  current = progress(); assert.equal(current.status, 'completed'); assert.equal(current.percent, 100); assert.equal(current.pendingGradingCount, 2); assert.equal(current.resultAttemptId, complete.id);
  reviewAttempt(store, complete, { SHORT: 0, 'GROUP::short': 0 });
  current = progress(); assert.equal(current.status, 'completed'); assert.equal(current.answeredPoints, 50); assert.equal(current.pendingGradingCount, 0);
});

test('retries never add coverage or replace a complete result with a new blank draft', t => {
  const { store, paper, progress, fullAnswers } = fixture(t);
  const complete = submitAttempt(store, createAttempt(store, paper), fullAnswers());
  const retry = createAttempt(store, paper); saveAttempt(store, retry, { 'TF-2': { value: ['true'] } });
  assert.equal(progress().status, 'completed'); assert.equal(progress().resumeAttemptId, retry.id); assert.equal(progress().resultAttemptId, complete.id); assert.equal(progress().percent, 100);
  submitAttempt(store, retry);
  assert.equal(progress().answeredQuestions, 5); assert.equal(progress().resultAttemptId, complete.id);
});

test('compact answered evidence preserves full progress and pending subjective work after history pruning and migration', t => {
  const { store, paper, record, progress, fullAnswers } = fixture(t);
  store.put('settings', 'system', { ...getSettings(store), maxHistoryPerPaper: 1 });
  const complete = submitAttempt(store, createAttempt(store, paper), fullAnswers());
  submitAttempt(store, createAttempt(store, paper), { 'TF-1': { value: ['true'] } });
  assert.equal(store.get('attempts', complete.id), undefined);
  const current = progress(); assert.equal(current.status, 'completed'); assert.equal(current.percent, 100); assert.equal(current.pendingGradingCount, 2);
  assert.equal(current.historyAvailable, false); assert.equal(current.resultAttemptId, null); assert.equal(current.detailsAvailable, true);
  const target = new Store(':memory:'); t.after(() => target.db.close()); importData(target, exportData(store));
  assert.deepEqual(dailyPushOverview(target, at).today!.progress, current); assert.deepEqual(target.require<DailyPushRecord>('daily_pushes', record.id).answerItems, record.answerItems);
});

test('original snapshots remain authoritative after paper changes or deletion and old daily records are never rewritten', t => {
  const { store, paper, record, progress, fullAnswers } = fixture(t);
  const complete = submitAttempt(store, createAttempt(store, paper), fullAnswers());
  store.put('papers', paper.id, { ...paper, title: '改过标题', version: 2 });
  assert.equal(dailyPushOverview(store, at).today!.paperAvailable, true); assert.equal(progress().status, 'completed');
  const old = { ...record }; delete old.answerItems; store.put('daily_pushes', old.id, old);
  const before = JSON.stringify(store.require('daily_pushes', old.id));
  // The v1 attempt remains an independent original basis after v2 edits.
  assert.equal(progress().answeredQuestions, 5); assert.equal(progress().resultAttemptId, complete.id);
  store.remove('papers', paper.id); assert.equal(dailyPushOverview(store, at).today!.paperAvailable, false); assert.equal(progress().status, 'completed');
  assert.equal(JSON.stringify(store.require('daily_pushes', old.id)), before);
  store.remove('attempts', complete.id); assert.equal(progress().status, 'unavailable'); assert.equal(progress().detailsAvailable, false);
});

test('old v1 papers supply group maxima through a read-only metadata projection, and reset markers do not fabricate answers', t => {
  const { store, record, paper, progress, fullAnswers } = fixture(t);
  const old = { ...record }; delete old.answerItems; store.put('daily_pushes', old.id, old);
  assert.equal(progress().totalQuestions, 5); assert.equal(progress().status, 'not_started');
  const attempt = submitAttempt(store, createAttempt(store, paper), fullAnswers());
  const evidence = store.require<any>('learning_results', attempt.id);
  store.put('learning_results', attempt.id, { ...evidence, reset: true, items: [], questions: [] });
  assert.equal(progress().status, 'completed', 'retained practice sheets still record their actual work after learning reset');
  store.remove('attempts', attempt.id);
  const current = progress(); assert.equal(current.status, 'submitted'); assert.equal(current.detailsAvailable, false); assert.equal(current.percent, 0); assert.equal(current.answeredQuestions, 0);
});

test('progress polls never load answers, question bodies or notes and never write dirty read models', t => {
  const { store, record, paper, progress, fullAnswers } = fixture(t);
  saveAttempt(store, createAttempt(store, paper), fullAnswers());
  // Force a legitimate old-record fallback and leave projections dirty.
  const old = { ...record }; delete old.answerItems; store.put('daily_pushes', old.id, old);
  const originalGet = store.get.bind(store), originalAll = store.all.bind(store);
  store.get = ((table: any, id: string) => { assert.ok(!['papers', 'attempts', 'questions', 'study', 'study_parts'].includes(table)); return originalGet(table, id); }) as typeof store.get;
  store.all = ((table: any) => { assert.ok(!['papers', 'attempts', 'questions', 'study', 'study_parts'].includes(table)); return originalAll(table); }) as typeof store.all;
  const reads = store.database.all.bind(store.database); let calls = 0;
  store.database.all = ((query: any) => { calls++; const rows = reads(query); assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_QUESTION_CANARY|PRIVATE_GROUP_CANARY|REFERENCE_ANSWER_CANARY|PRIVATE_STUDENT_CANARY/); return rows; }) as typeof store.database.all;
  store.database.run = () => { throw new Error('GET must never write'); };
  assert.equal(progress().answeredQuestions, 5); assert.ok(calls < 10);
});

test('frozen recommendation identities and maxima reject inconsistent migration fields', t => {
  const { record } = fixture(t);
  dailyPushRecordSchema.parse(record);
  assert.throws(() => dailyPushRecordSchema.parse({ ...record, answerItems: record.answerItems!.map((item, index) => index ? item : { ...item, points: item.points + 1 }) }));
  assert.throws(() => dailyPushRecordSchema.parse({ ...record, answerItems: record.answerItems!.map(item => ({ ...item, sourceQuestionId: 'another-root' })) }));
});
