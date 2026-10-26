import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../server/core/store.js';
import { questionSchema } from '../../server/core/validation.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';
import type { ReviewEvent } from '../../shared/models/adaptive-review.js';
import { buildPaper, createAttempt, reviewAttempt, type StoredAttempt } from '../../server/modules/practice/service.js';
import { preserveLearningResults } from '../../server/modules/practice/learning-results.js';
import { changeReviewCard, recordManualReview, reviewQueue, syncAttemptReviewEvents } from '../../server/modules/review-scheduler/service.js';
import { learningAnalytics, weeklyReport } from '../../server/modules/analytics/service.js';
import { learningResetPreview, resetLearningProgress } from '../../server/modules/study/reset.js';
import { analyticsReportOutputSchema, weeklyReportOutputSchema } from '../../server/http/analytics-schemas.js';
import { weeklyReportMarkdown } from '../../web/features/analytics/report-export.js';

const zone = 'Asia/Shanghai';
const date = (value: string) => new Date(value);
const fixedNow = date('2026-10-25T04:00:00.000Z');
const range = { from: '2026-10-19', to: '2026-10-25', timeZone: zone };
function fixture(t: test.TestContext) {
  const store = new Store(':memory:'); t.after(() => store.db.close());
  store.put('settings', 'system', structuredClone(DEFAULT_SETTINGS));
  for (const question of [
    questionSchema.parse({ id: 'TF', title: '判断', type: 'true_false', stemMarkdown: 'QUESTION_PRIVATE_CANARY', answerMarkdown: 'REFERENCE_PRIVATE_CANARY', correctAnswers: ['true'], status: 'published' }),
    questionSchema.parse({ id: 'SA', title: '简答', type: 'short_answer', stemMarkdown: 'QUESTION_PRIVATE_CANARY', answerMarkdown: 'REFERENCE_PRIVATE_CANARY', status: 'published' }),
    questionSchema.parse({ id: 'GROUP', title: '组合', type: 'group', stemMarkdown: 'MATERIAL_PRIVATE_CANARY', status: 'published', parts: [{ id: 'a', title: '小题', type: 'true_false', stemMarkdown: 'QUESTION_PRIVATE_CANARY', correctAnswers: ['true'] }, { id: 'b', title: '解释', type: 'short_answer', stemMarkdown: 'QUESTION_PRIVATE_CANARY' }] }),
    questionSchema.parse({ id: 'WORD', title: 'abandon', type: 'short_answer', stemMarkdown: 'QUESTION_PRIVATE_CANARY', status: 'published', vocabulary: { language: 'en', headword: 'abandon', meaningPrompt: '放弃', acceptedAnswers: ['abandon'], pronunciations: [{ label: '英式', ipa: 'əˈbændən', sourceLabel: '测试', sourceUrl: 'https://example.test/word', license: '测试', method: 'manual' }] } }),
  ]) store.put('questions', question.id, question);
  const paper = buildPaper(store, { id: 'PAPER', title: '统计', description: '', mode: 'manual', questionIds: ['TF', 'SA'], scoring: { enabled: true, totalPoints: 4, questionPoints: { TF: 2, SA: 2 } } });
  store.put('papers', paper.id, paper);
  const attempt = (id: string, stamp: string, answers: StoredAttempt['answers']) => {
    const draft = createAttempt(store, paper); store.remove('attempts', draft.id);
    Object.assign(draft, { id, status: 'submitted', startedAt: stamp, submittedAt: stamp, updatedAt: stamp, answers });
    store.put('attempts', id, draft); preserveLearningResults(store, draft); syncAttemptReviewEvents(store, draft); return draft;
  };
  const stats = () => learningAnalytics(store, range, fixedNow);
  return { store, attempt, stats };
}

test('FSRS feedback corrections retain original attribution and survive sheet pruning; reset clears feedback and cards', t => {
  const { store, attempt, stats } = fixture(t);
  const submitted = attempt('FIRST', '2026-10-21T03:00:00.000Z', { TF: { value: ['true'] }, SA: { value: 'STUDENT_PRIVATE_CANARY' } });
  assert.equal(stats().adaptive!.feedbackEvents, 1); assert.equal(stats().adaptive!.recallSuccessRate, 100);
  // A correct answer can still be explicitly rated Again; recall is a separate measure.
  reviewAttempt(store, submitted, { SA: 1 }, {}, {}, { TF: 'again', SA: 'again' });
  let result = stats();
  assert.equal(result.adaptive!.feedbackEvents, 2); assert.equal(result.adaptive!.uniqueCards, 2);
  assert.deepEqual(result.adaptive!.ratings, { again: 2, hard: 0, good: 0, easy: 0 });
  assert.equal(result.adaptive!.recallSuccessRate, 0); assert.equal(result.summary.accuracy, 50);
  reviewAttempt(store, submitted, { SA: 2 }, {}, {}, { TF: 'good', SA: 'hard' });
  result = stats(); assert.equal(result.adaptive!.feedbackEvents, 2); assert.equal(result.adaptive!.recallSuccessRate, 100);
  assert.ok(store.all<ReviewEvent>('review_events').every(event => event.occurredAt === '2026-10-21T03:00:00.000Z'));
  assert.equal(learningAnalytics(store, { from: '2026-10-22', to: '2026-10-25', timeZone: zone }, fixedNow).adaptive!.feedbackEvents, 0);
  store.remove('attempts', submitted.id); assert.equal(stats().adaptive!.feedbackEvents, 2);
  store.remove('questions', 'TF'); assert.equal(stats().adaptive!.feedbackEvents, 2);
  resetLearningProgress(store, learningResetPreview(store).fingerprint);
  result = stats(); assert.equal(result.adaptive!.feedbackEvents, 0); assert.equal(result.adaptive!.recallSuccessRate, null);
  assert.equal(store.all('review_cards').length, 0); assert.equal(store.all('review_events').length, 0);
});

test('actual FSRS before snapshots distinguish first, early, due and overdue outcomes without invented plan completion', t => {
  const { store } = fixture(t);
  const firstAt = date('2026-10-01T02:00:00.000Z');
  recordManualReview(store, { questionId: 'TF', rating: 'good', requestId: 'FIRST' }, firstAt);
  const second = recordManualReview(store, { questionId: 'TF', rating: 'hard', requestId: 'EARLY' }, new Date(firstAt.getTime() + 60000));
  const thirdAt = date(second.dueAt!);
  const third = recordManualReview(store, { questionId: 'TF', rating: 'easy', requestId: 'DUE' }, thirdAt);
  const fourthAt = new Date(Date.parse(third.dueAt!) + 86400000);
  recordManualReview(store, { questionId: 'TF', rating: 'again', requestId: 'OVERDUE' }, fourthAt);
  const now = new Date(fourthAt.getTime() + 3600000), day = new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(now);
  const report = learningAnalytics(store, { from: '2026-10-01', to: day, timeZone: zone }, now), adaptive = report.adaptive!;
  assert.equal(adaptive.feedbackEvents, 4); assert.equal(adaptive.uniqueCards, 1); assert.equal(adaptive.recallSuccessRate, 75);
  assert.deepEqual(adaptive.ratings, { again: 1, hard: 1, good: 1, easy: 1 });
  for (const key of ['new', 'early', 'due', 'overdue'] as const) assert.equal(adaptive.timing[key].feedbackEvents, 1);
  assert.equal(adaptive.timing.overdue.recallSuccessRate, 0); assert.equal(adaptive.timing.unknown.recallSuccessRate, null);
  assert.equal(report.summary.accuracy, null); assert.equal(adaptive.queue!.due, 1); assert.equal(adaptive.queue!.relearning, 1);
  assert.equal(adaptive.dueProcessing.completedDueCycles, 2); assert.equal(adaptive.dueProcessing.rate, 66.67);
  const historical = learningAnalytics(store, { from: '2026-10-01', to: '2026-10-01', timeZone: zone }, now).adaptive!;
  assert.equal(historical.queue, null); assert.equal(historical.dueProcessing.pendingDue, null); assert.equal(historical.dueProcessing.rate, null);
  assert.match(historical.dueProcessing.reason, /缺少.*快照/);
});

test('live queue matches available tasks with legacy de-duplication, independent directions, exact due times and pauses', t => {
  const { store, stats } = fixture(t);
  recordManualReview(store, { questionId: 'TF', rating: 'again', requestId: 'TF' }, date('2026-10-19T01:00:00.000Z'));
  recordManualReview(store, { questionId: 'SA', rating: 'good', requestId: 'SA' }, date('2026-10-19T01:00:00.000Z'));
  changeReviewCard(store, { questionId: 'SA', suspended: true }, fixedNow);
  recordManualReview(store, { questionId: 'WORD', direction: 'word_to_meaning', rating: 'again', requestId: 'FORWARD' }, date('2026-10-19T01:00:00.000Z'));
  recordManualReview(store, { questionId: 'WORD', direction: 'meaning_to_word', rating: 'again', requestId: 'REVERSE' }, date('2026-10-19T01:00:00.000Z'));
  store.putStudy({ ...store.study('GROUP', 'a'), nextReviewAt: '2026-10-25T03:00:00.000Z', notes: 'NOTES_PRIVATE_CANARY' });
  let adaptive = stats().adaptive!, expected = reviewQueue(store, { page: 1, pageSize: 20 }, fixedNow).summary;
  assert.deepEqual(adaptive.queue, { ...expected, asOf: fixedNow.toISOString() });
  assert.equal(adaptive.queue!.due, 4); assert.equal(adaptive.queue!.relearning, 3); assert.equal(adaptive.queue!.today, 1); assert.equal(adaptive.queue!.suspended, 1);
  assert.equal(adaptive.uniqueCards, 4);
  changeReviewCard(store, { questionId: 'TF', dueAt: '2026-10-25T04:00:01.000Z' }, fixedNow);
  adaptive = stats().adaptive!; assert.equal(adaptive.queue!.due, 3);
  store.remove('questions', 'WORD'); adaptive = stats().adaptive!;
  assert.equal(adaptive.queue!.due, 1); assert.equal(adaptive.feedbackEvents, 4, 'deleting a source does not erase retained feedback');
  assert.equal(adaptive.timing.new.feedbackEvents, 4, 'legacy fixed dates do not invent a prior FSRS cycle');
});

test('weekly feedback matches elapsed instants, timezone boundaries and exact asOf; future events cannot leak', t => {
  const { store } = fixture(t);
  recordManualReview(store, { questionId: 'TF', rating: 'hard', requestId: 'MONDAY' }, date('2026-10-18T16:00:00.000Z'));
  recordManualReview(store, { questionId: 'SA', rating: 'easy', requestId: 'SUNDAY' }, date('2026-10-18T23:59:59+08:00'));
  recordManualReview(store, { questionId: 'GROUP', partId: 'a', rating: 'good', requestId: 'PREVIOUS' }, date('2026-10-18T04:00:00.000Z'));
  recordManualReview(store, { questionId: 'GROUP', partId: 'a', rating: 'again', requestId: 'AFTER-CUTOFF' }, date('2026-10-18T04:00:00.001Z'));
  recordManualReview(store, { questionId: 'TF', rating: 'again', requestId: 'FUTURE' }, date('2026-10-25T04:00:00.001Z'));
  const report = weeklyReport(store, { week: '2026-10-25', timeZone: zone }, fixedNow);
  assert.equal(report.current.adaptive!.feedbackEvents, 1); assert.equal(report.current.adaptive!.ratings.hard, 1);
  assert.equal(report.current.adaptive!.queue, null, 'future card state cannot masquerade as a queue snapshot at asOf');
  assert.equal(report.comparison.adaptive!.feedbackEvents, 1); assert.equal(report.comparison.adaptive!.ratings.good, 1);
  assert.equal(report.comparison.adaptive!.queue, null); assert.equal(report.comparison.adaptive!.dueProcessing.rate, null);
  assert.equal(report.current.range.asOf, fixedNow.toISOString());
  const ended = weeklyReport(store, { week: '2026-10-18', timeZone: zone }, fixedNow);
  assert.equal(ended.current.range.asOf, '2026-10-18T15:59:59.999Z'); assert.equal(ended.current.adaptive!.queue, null);
  assert.equal(ended.current.adaptive!.feedbackEvents, 3);
  assert.equal(learningAnalytics(store, { from: '2026-10-19', to: '2026-10-19', timeZone: 'UTC' }, fixedNow).adaptive!.feedbackEvents, 0);
  analyticsReportOutputSchema.parse(report.current); weeklyReportOutputSchema.parse(report);
});

test('group parent legacy dates expand only to leaves without explicit plans or represented cards', t => {
  const { store, stats } = fixture(t);
  store.putStudy({ ...store.study('GROUP'), nextReviewAt: '2026-10-24T03:00:00.000Z' });
  assert.equal(stats().adaptive!.queue!.due, 2, 'both valid leaves inherit the old parent schedule');
  assert.deepEqual(stats().adaptive!.queue, { ...reviewQueue(store, { page: 1, pageSize: 20 }, fixedNow).summary, asOf: fixedNow.toISOString() });
  store.putStudy({ ...store.study('GROUP', 'a'), nextReviewAt: null });
  assert.equal(stats().adaptive!.queue!.due, 1, 'an explicit empty leaf plan blocks parent inheritance');
  recordManualReview(store, { questionId: 'GROUP', partId: 'b', rating: 'again', requestId: 'GROUP-B' }, date('2026-10-24T02:00:00.000Z'));
  changeReviewCard(store, { questionId: 'GROUP', partId: 'b', suspended: true }, fixedNow);
  assert.equal(stats().adaptive!.queue!.due, 0, 'a paused card cannot reappear through its parent legacy date');
  assert.equal(stats().adaptive!.queue!.suspended, 1);
  store.putStudy({ ...store.study('GROUP', 'a'), nextReviewAt: '2026-10-26T03:00:00.000Z' });
  assert.equal(stats().adaptive!.queue!.due, 0, 'a future explicit leaf plan also blocks parent inheritance');
  assert.deepEqual(stats().adaptive!.queue, { ...reviewQueue(store, { page: 1, pageSize: 20 }, fixedNow).summary, asOf: fixedNow.toISOString() });
});

test('FSRS analytics metadata queries stay read-only and Markdown exports distinguish recall from strict accuracy', t => {
  const { store } = fixture(t);
  recordManualReview(store, { questionId: 'TF', rating: 'again', requestId: 'META' }, date('2026-10-21T01:00:00.000Z'));
  store.putStudy({ ...store.study('TF'), notes: 'NOTES_PRIVATE_CANARY' });
  const read = store.database.all.bind(store.database), one = store.database.one.bind(store.database); let count = 0;
  const inspect = (result: unknown) => { assert.doesNotMatch(JSON.stringify(result) ?? '', /QUESTION_PRIVATE_CANARY|REFERENCE_PRIVATE_CANARY|MATERIAL_PRIVATE_CANARY|STUDENT_PRIVATE_CANARY|NOTES_PRIVATE_CANARY/); return result; };
  store.database.all = ((query: any) => { count++; assert.doesNotMatch(query.compile().sql, /select "data"/); return inspect(read(query)); }) as any;
  store.database.one = ((query: any) => inspect(one(query))) as any;
  const get = store.get.bind(store); store.get = ((table: any, id: string) => { assert.equal(table, 'settings'); return get(table, id); }) as any;
  store.all = () => { throw new Error('must not materialize a full table'); };
  store.database.run = () => { throw new Error('GET must never write'); };
  const report = weeklyReport(store, { week: '2026-10-25', timeZone: zone }, fixedNow), markdown = weeklyReportMarkdown(report);
  assert.ok(count < 20); assert.equal(report.current.adaptive!.feedbackEvents, 1);
  assert.match(markdown, /## FSRS 自适应复习/); assert.match(markdown, /回忆成功率＝（Hard＋Good＋Easy）/);
  assert.match(markdown, /严格正确率/); assert.match(markdown, /重学 Again/); assert.match(markdown, /本时段到期处理比例/);
  assert.match(markdown, /这不是历史计划完成率/); assert.doesNotMatch(markdown, /PRIVATE_CANARY/);
  assert.match(weeklyReportMarkdown(weeklyReport(store, { week: '2026-10-18', timeZone: zone }, fixedNow)), /缺少.*快照/);
});
