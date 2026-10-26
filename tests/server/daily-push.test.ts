import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../server/core/store.js';
import { questionSchema } from '../../server/core/validation.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';
import type { Question, QuestionType } from '../../shared/models/types.js';
import { getSettings, saveSettings, settingsSchema } from '../../server/modules/settings/service.js';
import { dailyPushRecordSchema, validateDailyPushConfiguration } from '../../server/modules/daily-push/schema.js';
import { checkDailyPush, dailyPushOverview, readDailyPush } from '../../server/modules/daily-push/service.js';
import { selectDailyQuestions } from '../../server/modules/daily-push/selection.js';
import { dailyCalendar, isDailyPushDue } from '../../server/modules/daily-push/calendar.js';
import { buildPaper, createAttempt, createQuickAttempt, submitAttempt } from '../../server/modules/practice/service.js';
import { exportData, importData } from '../../server/modules/transfer/migration.js';
import { exportConfiguration, previewConfiguration } from '../../server/modules/settings/configuration.js';
import { buildApp } from '../../server/index.js';

const at = new Date('2026-10-25T00:00:00+08:00');
function fixture(t: test.TestContext) {
  const store = new Store(':memory:'); t.after(() => store.db.close());
  // These legacy selection tests intentionally cover fixed-interval behavior.
  store.put('settings', 'system', { ...structuredClone(DEFAULT_SETTINGS), reviewScheduling: { ...structuredClone(DEFAULT_SETTINGS.reviewScheduling), strategy: 'fixed' } });
  store.put('domains', 'd', { id: 'd', name: '学习领域', description: '', sortOrder: 0 });
  store.put('domains', 'outside', { id: 'outside', name: '其他领域', description: '', sortOrder: 1 });
  for (const [id, parentId] of [['c', null], ['child', 'c'], ['elsewhere', null]] as const) store.put('categories', id, { id, parentId, domainId: 'd', name: id, description: '', sortOrder: 0 });
  const add = (id: string, type: QuestionType = 'single_choice', category = 'child', published = true, parts = 2) => {
    const leaf = { title: '小题', type: 'true_false', stemMarkdown: '判断', answerMarkdown: '正确', explanationMarkdown: '解释', correctAnswers: ['true'], options: [] };
    const q = questionSchema.parse({ id, title: id, type, stemMarkdown: id + '题干', answerMarkdown: '答案', explanationMarkdown: '解释', categoryIds: [category], status: published ? 'published' : 'pending', ...(type.includes('choice') ? { options: [{ key: 'A', text: '正确' }, { key: 'B', text: '另一个' }, { key: 'C', text: '错误' }], correctAnswers: type === 'multiple_choice' ? ['A', 'B'] : ['A'] } : type === 'true_false' ? { correctAnswers: ['true'] } : type === 'fill_blank' ? { blanks: [{ id: 'b', label: '填空', answers: ['值'], trim: true, caseSensitive: false }] } : type === 'group' ? { parts: Array.from({ length: parts }, (_, index) => ({ ...leaf, id: 'p' + index })) } : {}) }) as Question;
    store.put('questions', id, q); return q;
  };
  const enable = (reviewPoints = 30, newPoints = 20) => {
    const settings = getSettings(store); store.put('settings', 'system', { ...settings, dailyPush: { ...settings.dailyPush, enabled: true, domainId: 'd', categoryIds: ['c'], reviewPoints, newPoints } });
  };
  const learned = (id: string, partId?: string) => store.putStudy({ questionId: id, ...(partId ? { partId } : {}), favorite: false, notes: '', mastery: 1, lastReviewedAt: '2026-10-01T00:00:00Z', nextReviewAt: null, wrongCount: 0 });
  return { store, add, enable, learned };
}

test('daily push defaults off, four-point multi choice, validated scopes and pure reads', t => {
  const { store, enable } = fixture(t); assert.equal(getSettings(store).pointsByType.multiple_choice, 4);
  assert.equal(getSettings(store).dailyPush.enabled, false); assert.equal(checkDailyPush(store, at).generated, false); assert.equal(store.all('daily_pushes').length, 0);
  assert.equal(dailyPushOverview(store, at).today, null); assert.equal(store.all('papers').length, 0);
  assert.throws(() => settingsSchema.parse({ ...getSettings(store), dailyPush: { ...getSettings(store).dailyPush, enabled: true } }));
  assert.doesNotThrow(() => settingsSchema.parse({ ...getSettings(store), dailyPush: { ...getSettings(store).dailyPush, enabled: false, reviewPoints: 0, newPoints: 0 } }));
  enable(); assert.throws(() => saveSettings(store, { ...getSettings(store), dailyPush: { ...getSettings(store).dailyPush, categoryIds: ['missing'] } }));
  assert.throws(() => store.deleteTaxonomy('categories', 'c'), /每日推题/);
  const old = getSettings(store); store.put('settings', 'system', { ...old, dailyPush: undefined }); assert.deepEqual(getSettings(store).dailyPush, DEFAULT_SETTINGS.dailyPush);
});

test('insufficient review points transfer to fresh questions; overshoot is allowed without widening scope', t => {
  const { store, add, enable, learned } = fixture(t);
  for (let i = 0; i < 2; i++) { add('review-' + i, 'short_answer'); learned('review-' + i); }
  for (let i = 0; i < 20; i++) add('new-' + i, 'short_answer');
  add('outside', 'essay', 'elsewhere'); add('pending', 'essay', 'child', false); enable();
  const { record } = checkDailyPush(store, at); assert.ok(record); assert.equal(record!.reviewPoints, 6); assert.equal(record!.transferredPoints, 24); assert.equal(record!.targetNewPoints, 44); assert.equal(record!.newPoints, 45); assert.equal(record!.totalPoints, 51); assert.equal(record!.shortfall, 0);
  assert.equal(new Set(record!.questionIds).size, record!.questionIds.length); assert.ok(!record!.questionIds.includes('outside')); assert.ok(!record!.questionIds.includes('pending'));
  const paper = store.require<any>('papers', record!.paperId!); assert.equal(paper.scoring.enabled, true); assert.equal(paper.scoring.totalPoints, 51); assert.equal(paper.organization, 'domain');
  assert.equal(record!.title, '2026-10-25 每日推荐'); assert.equal(paper.title, record!.title);
  const first = JSON.stringify(record); assert.equal(checkDailyPush(store, at).generated, false); assert.equal(store.all('papers').length, 1);
  store.put('settings', 'system', { ...getSettings(store), pointsByType: { ...getSettings(store).pointsByType, short_answer: 9 } });
  assert.equal(JSON.stringify(checkDailyPush(store, at).record), first); assert.equal(store.require<any>('papers', record!.paperId!).scoring.totalPoints, 51);
});

test('fresh shortage can use remaining review; empty and limited pools report actual shortfall', t => {
  const { store, add, enable, learned } = fixture(t);
  for (let i = 0; i < 55; i++) { add('review-' + i, 'true_false'); learned('review-' + i); } enable();
  const record = checkDailyPush(store, at).record!; assert.equal(record.totalPoints, 50); assert.equal(record.reviewPoints, 50); assert.equal(record.newCount, 0);
  store.put('settings', 'system', { ...getSettings(store), dailyPush: { ...getSettings(store).dailyPush, categoryIds: ['elsewhere'] } });
  const empty = checkDailyPush(store, new Date('2026-10-26T00:00:00+08:00')).record!;
  assert.equal(empty.paperId, null); assert.equal(empty.shortfall, 50); assert.equal(empty.totalPoints, 0); assert.match(empty.reason, /没有/);
});

test('learning classification excludes notes, favorites and omissions; ungraded answers and learned parts count', t => {
  const { store, add, enable, learned } = fixture(t), note = add('note'), omitted = add('omitted'), subjective = add('ungraded', 'short_answer'), group = add('group', 'group');
  store.putStudy({ questionId: note.id, favorite: true, mastery: null, notes: '只写笔记', nextReviewAt: null, lastReviewedAt: null, wrongCount: 0 });
  const paper = buildPaper(store, { title: '练习', description: '', mode: 'manual', questionIds: [omitted.id, subjective.id], scoring: { enabled: false } });
  submitAttempt(store, createAttempt(store, paper), { [subjective.id]: { value: '尚未判分的真实回答' } });
  // Existing objective submission schedules omitted items for review. With no
  // such progress marker, omission evidence alone must not imply an answer.
  store.putStudy({ ...store.study(omitted.id), nextReviewAt: null });
  learned(group.id, 'p0'); enable(0, 50);
  const selected = selectDailyQuestions(store, getSettings(store).dailyPush, getSettings(store).pointsByType, at);
  assert.ok(selected.newQuestionIds.includes(note.id)); assert.ok(selected.newQuestionIds.includes(omitted.id)); assert.ok(selected.reviewQuestionIds.includes(subjective.id)); assert.ok(selected.reviewQuestionIds.includes(group.id));
  store.putStudy({ questionId: note.id, favorite: true, mastery: null, notes: '只安排下次日期', lastReviewedAt: null, nextReviewAt: '2026-10-25T04:00:00Z', wrongCount: 0 });
  assert.ok(selectDailyQuestions(store, getSettings(store).dailyPush, getSettings(store).pointsByType, at).reviewQuestionIds.includes(note.id));
});

test('latest corrected errors do not get permanent wrong priority from cumulative wrongCount', t => {
  const { store, add, enable, learned } = fixture(t); const corrected = add('corrected'), wrong = add('wrong'); learned(corrected.id); learned(wrong.id);
  submitAttempt(store, createQuickAttempt(store, { questionId: corrected.id }), { [corrected.id]: { value: ['B'] } });
  submitAttempt(store, createQuickAttempt(store, { questionId: corrected.id }), { [corrected.id]: { value: ['A'] } });
  submitAttempt(store, createQuickAttempt(store, { questionId: wrong.id }), { [wrong.id]: { value: ['B'] } });
  for (let i = 0; i < 30; i++) add('new-' + i); enable(2, 48);
  const selected = selectDailyQuestions(store, getSettings(store).dailyPush, getSettings(store).pointsByType, at); assert.deepEqual(selected.reviewQuestionIds, [wrong.id]);
});

test('decimal scores, maximum total and group answer-slot cap remain valid', t => {
  const { store, add, enable, learned } = fixture(t);
  for (let i = 0; i < 200; i++) add('decimal-' + i); enable(0, 50);
  store.put('settings', 'system', { ...getSettings(store), pointsByType: { ...getSettings(store).pointsByType, single_choice: 0.3 } });
  assert.equal(checkDailyPush(store, at).record!.totalPoints, 50.1);
  for (let i = 0; i < 20; i++) { add('high-' + i, 'multiple_choice'); learned('high-' + i); }
  enable(9500, 500); store.put('settings', 'system', { ...getSettings(store), pointsByType: { ...getSettings(store).pointsByType, multiple_choice: 1000 } });
  const high = checkDailyPush(store, new Date('2026-10-26T00:00:00+08:00')).record!; assert.equal(high.totalPoints, 10000); dailyPushRecordSchema.parse(high);
  const groups = fixture(t); for (let i = 0; i < 20; i++) groups.add('group-' + i, 'group', 'child', true, 30); groups.enable(0, 120);
  const result = checkDailyPush(groups.store, at).record!; assert.equal(result.questionIds.length, 16); assert.equal(result.totalPoints, 96); assert.equal(result.shortfall, 24);
});

test('calendar, persistence, unread state and deleted paper view are independent of current configuration', t => {
  const { store, add, enable } = fixture(t); for (let i = 0; i < 30; i++) add('q' + i); enable();
  assert.deepEqual(dailyCalendar(new Date('2026-10-24T16:00:00Z'), 'Asia/Shanghai'), { dateKey: '2026-10-25', time: '00:00' });
  assert.equal(isDailyPushDue({ ...getSettings(store).dailyPush, scheduleTime: '08:30' }, at), false);
  const record = checkDailyPush(store, at).record!; assert.equal(dailyPushOverview(store, at).unreadCount, 1);
  readDailyPush(store, record.id, at); assert.equal(dailyPushOverview(store, at).unreadCount, 0);
  const target = new Store(':memory:'); t.after(() => target.db.close()); importData(target, exportData(store)); assert.equal(checkDailyPush(target, at).generated, false); assert.deepEqual(target.require('daily_pushes', record.id), store.require('daily_pushes', record.id));
  store.remove('papers', record.paperId!); assert.equal(dailyPushOverview(store, at).today!.paperAvailable, false);
  assert.throws(() => dailyPushRecordSchema.parse({ ...record, id: 'daily-2026-99-99', dateKey: '2026-99-99' }));
});

test('portable configuration validates enabled scopes; complete backup imports taxonomy before enabling', t => {
  const { store, add, enable } = fixture(t); add('q'); enable();
  const configuration = exportConfiguration(store), recipient = new Store(':memory:'); t.after(() => recipient.db.close());
  assert.throws(() => previewConfiguration(recipient, configuration), /领域|分类/); assert.equal(recipient.all('settings').length, 0);
  importData(recipient, exportData(store)); validateDailyPushConfiguration(recipient, getSettings(recipient).dailyPush); assert.equal(getSettings(recipient).dailyPush.enabled, true);
});

test('metadata selection and notification reads never load paper snapshots, complete attempts or notes', t => {
  const { store, add, enable } = fixture(t); for (let i = 0; i < 40; i++) add('q' + i); enable(); checkDailyPush(store, at);
  store.questionMetadata({ status: 'published' });
  const originalGet = store.get.bind(store), originalAll = store.all.bind(store);
  store.get = ((table: any, id: string) => { assert.notEqual(table, 'papers', 'notification must query paper availability without body'); return originalGet(table, id); }) as typeof store.get;
  store.all = ((table: any) => { assert.ok(!['papers', 'attempts', 'questions', 'study', 'study_parts'].includes(table), 'metadata path must not load full records: ' + table); return originalAll(table); }) as typeof store.all;
  store.questions = () => { throw new Error('full question pool loaded'); };
  assert.equal(dailyPushOverview(store, at).today!.paperAvailable, true);
  assert.equal(selectDailyQuestions(store, getSettings(store).dailyPush, getSettings(store).pointsByType, at).shortfall, 0);
});

test('HTTP daily check/read endpoints are strict and OpenAPI declares them', async t => {
  const { store, add, enable } = fixture(t); for (let i = 0; i < 30; i++) add('q' + i); enable();
  const app = await buildApp({ databasePath: ':memory:', seedPath: 'no-daily-seed', dailyPushNow: () => at, dailyPushScheduler: false }); t.after(() => app.close());
  const data = exportData(store);
  assert.equal((await app.inject({ method: 'POST', url: '/api/import', payload: { data, mode: 'merge' } })).statusCode, 200);
  assert.equal((await app.inject('/api/daily-push')).json().today, null);
  const checked = (await app.inject({ method: 'POST', url: '/api/daily-push/check' })).json(); assert.equal(checked.generated, true); assert.equal(checked.overview.unreadCount, 1);
  const papers = (await app.inject('/api/papers')).json(); assert.equal(papers.length, 1); assert.equal(papers[0].id, checked.record.paperId); assert.equal(papers[0].title, '2026-10-25 每日推荐');
  assert.equal((await app.inject({ method: 'POST', url: '/api/daily-push/check', payload: { now: '2099-01-01' } })).statusCode, 400);
  const read = await app.inject({ method: 'POST', url: '/api/daily-push/' + checked.record.id + '/read' }); assert.equal(read.statusCode, 200); assert.ok(read.json().readAt);
  assert.equal((await app.inject('/api/daily-push')).json().unreadCount, 0);
  const paths = (await app.inject('/api/openapi.json')).json().paths; assert.ok(paths['/api/daily-push']); assert.ok(paths['/api/daily-push/check']); assert.ok(paths['/api/daily-push/{id}/read']);
});
