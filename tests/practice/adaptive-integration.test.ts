import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Store } from '../../server/core/store.js';
import { ApiError, questionSchema } from '../../server/core/validation.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';
import type { ReviewCard, ReviewEvent } from '../../shared/models/adaptive-review.js';
import { buildPaper, createAttempt, submitAttempt, reviewAttempt } from '../../server/modules/practice/service.js';
import { registerStudyRoutes } from '../../server/modules/study/routes.js';
import { learningResetPreview, resetLearningProgress } from '../../server/modules/study/reset.js';

function fixture(t: test.TestContext) {
  const store = new Store(':memory:'); t.after(() => store.db.close());
  store.put('settings', 'system', structuredClone(DEFAULT_SETTINGS));
  const questions = [
    questionSchema.parse({ id: 'ADAPTIVE-TF', title: '判断', type: 'true_false', stemMarkdown: '是否成立', correctAnswers: ['true'], status: 'published' }),
    questionSchema.parse({ id: 'ADAPTIVE-SA', title: '说明', type: 'short_answer', stemMarkdown: '说明原理', answerMarkdown: '参考答案', status: 'published' }),
    questionSchema.parse({ id: 'ADAPTIVE-GROUP', title: '公共材料', type: 'group', stemMarkdown: '代码材料', status: 'published', parts: [
      { id: 'tf', title: '判断小题', type: 'true_false', stemMarkdown: '材料是否成立', correctAnswers: ['true'] },
      { id: 'sa', title: '解释小题', type: 'short_answer', stemMarkdown: '解释材料', answerMarkdown: '参考理由' },
    ] }),
  ];
  for (const question of questions) store.put('questions', question.id, question);
  const paper = buildPaper(store, { id: 'adaptive-paper', title: '自适应隔离测试', description: '', mode: 'manual', questionIds: questions.map(question => question.id), scoring: { enabled: true, totalPoints: 12, questionPoints: { 'ADAPTIVE-TF': 2, 'ADAPTIVE-SA': 4, 'ADAPTIVE-GROUP': 6 } } });
  store.put('papers', paper.id, paper);
  const cards = () => store.all<ReviewCard>('review_cards');
  const events = () => store.all<ReviewEvent>('review_events');
  const card = (questionId: string, partId?: string) => cards().find(item => item.questionId === questionId && item.partId === partId)!;
  return { store, paper, cards, events, card };
}

test('FSRS submission uses actual objective answers, keeps omissions out and does not duplicate repeat submits', t => {
  const { store, paper, events, card } = fixture(t);
  const attempt = submitAttempt(store, createAttempt(store, paper), { 'ADAPTIVE-TF': { value: ['true'] }, 'ADAPTIVE-GROUP::tf': { value: ['false'] } });
  assert.equal(events().length, 2); assert.equal(events().find(event => event.questionId === 'ADAPTIVE-TF')!.rating, 'good');
  assert.equal(events().find(event => event.partId === 'tf')!.rating, 'again'); assert.equal(card('ADAPTIVE-TF').memory.reps, 1);
  const originalDue = card('ADAPTIVE-TF').dueAt;
  submitAttempt(store, attempt); assert.equal(events().length, 2);
  submitAttempt(store, createAttempt(store, paper), {});
  assert.equal(events().length, 2); assert.equal(card('ADAPTIVE-TF').dueAt, originalDue);
  assert.equal(store.study('ADAPTIVE-TF').nextReviewAt, originalDue, 'omissions never replace an existing FSRS date');
});

test('subjective grading creates or corrects the original event and withdrawal restores the prior state', t => {
  const { store, paper, events, card } = fixture(t);
  const attempt = submitAttempt(store, createAttempt(store, paper), { 'ADAPTIVE-SA': { value: '真实说明' } });
  assert.equal(events().length, 0, 'ungraded subjective answers do not strengthen memory');
  reviewAttempt(store, attempt, { 'ADAPTIVE-SA': 4 });
  assert.equal(events().length, 1); assert.equal(events()[0]!.rating, 'good'); assert.equal(events()[0]!.occurredAt, attempt.submittedAt);
  reviewAttempt(store, attempt, { 'ADAPTIVE-SA': 4 }); assert.equal(events().length, 1); assert.equal(card('ADAPTIVE-SA').memory.reps, 1);
  reviewAttempt(store, attempt, { 'ADAPTIVE-SA': 1 }); assert.equal(events().length, 1); assert.equal(events()[0]!.rating, 'again'); assert.equal(card('ADAPTIVE-SA').memory.reps, 1);
  reviewAttempt(store, attempt, { 'ADAPTIVE-SA': null }); assert.equal(events().length, 0); assert.equal(card('ADAPTIVE-SA').memory.reps, 0);
});

test('disabling automatic objective ratings preserves existing memory dates and previewed answers are not recalled as Good', t => {
  const { store, paper, events, card } = fixture(t);
  submitAttempt(store, createAttempt(store, paper), { 'ADAPTIVE-TF': { value: ['true'] } });
  const due = card('ADAPTIVE-TF').dueAt;
  store.put('settings', 'system', { ...structuredClone(DEFAULT_SETTINGS), reviewScheduling: { ...structuredClone(DEFAULT_SETTINGS.reviewScheduling), autoRateObjective: false } });
  submitAttempt(store, createAttempt(store, paper), { 'ADAPTIVE-TF': { value: ['false'] } });
  assert.equal(events().length, 1); assert.equal(card('ADAPTIVE-TF').dueAt, due); assert.equal(store.study('ADAPTIVE-TF').nextReviewAt, due);
  store.put('settings', 'system', structuredClone(DEFAULT_SETTINGS));
  const peeked = createAttempt(store, paper); peeked.referenceViewedAt = new Date().toISOString();
  submitAttempt(store, peeked, { 'ADAPTIVE-TF': { value: ['true'] } });
  assert.equal(events().length, 2); assert.equal(events().find(event => event.attemptId === peeked.id)!.rating, 'again');
});

test('independent equal grades are separate reviews and correcting older work keeps the latest review time', t => {
  const { store, paper, events, card } = fixture(t);
  const old = submitAttempt(store, createAttempt(store, paper), { 'ADAPTIVE-SA': { value: '较早说明' } }); reviewAttempt(store, old, { 'ADAPTIVE-SA': 4 });
  const recent = submitAttempt(store, createAttempt(store, paper), { 'ADAPTIVE-SA': { value: '较新说明' } }); reviewAttempt(store, recent, { 'ADAPTIVE-SA': 4 });
  assert.equal(events().length, 2); assert.equal(card('ADAPTIVE-SA').memory.reps, 2);
  reviewAttempt(store, old, { 'ADAPTIVE-SA': 0 });
  assert.equal(events().length, 2); assert.equal(card('ADAPTIVE-SA').memory.reps, 2); assert.equal(card('ADAPTIVE-SA').lastReviewedAt, recent.submittedAt);
});

test('explicit post-submit recall feedback overrides one event and can return to its automatic rating', t => {
  const { store, paper, events, card } = fixture(t);
  const attempt = submitAttempt(store, createAttempt(store, paper), { 'ADAPTIVE-TF': { value: ['true'] }, 'ADAPTIVE-SA': { value: '未判说明' } });
  reviewAttempt(store, attempt, {}, {}, {}, { 'ADAPTIVE-TF': 'easy' });
  assert.equal(events().length, 1); assert.equal(events()[0]!.ratingSource, 'manual'); assert.equal(events()[0]!.rating, 'easy'); assert.equal(card('ADAPTIVE-TF').memory.reps, 1);
  reviewAttempt(store, attempt, {}, {}, {}, { 'ADAPTIVE-TF': null }); assert.equal(events()[0]!.rating, 'good'); assert.equal(events()[0]!.ratingSource, 'automatic');
  assert.throws(() => reviewAttempt(store, attempt, {}, {}, {}, { 'ADAPTIVE-SA': 'good' }), ApiError);
  assert.equal(events().length, 1);
});

test('manual FSRS review requires an idempotent rating request and retains the StudyState response', async t => {
  const { store, events, card } = fixture(t); const app = Fastify(); t.after(() => app.close());
  app.setErrorHandler((error, _request, reply) => error instanceof ApiError ? reply.code(error.status).send({ error: { code: error.code } }) : reply.code(500).send({ error: String(error) }));
  registerStudyRoutes(app, store);
  const payload = { rating: 'good', requestId: 'manual-request-one' };
  const first = await app.inject({ method: 'POST', url: '/api/study/ADAPTIVE-TF/review', payload }); assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().questionId, 'ADAPTIVE-TF'); assert.ok(first.json().nextReviewAt); assert.equal(events().length, 1);
  const second = await app.inject({ method: 'POST', url: '/api/study/ADAPTIVE-TF/review', payload }); assert.equal(second.statusCode, 200, second.body); assert.equal(events().length, 1);
  assert.equal((await app.inject({ method: 'POST', url: '/api/study/ADAPTIVE-TF/review', payload: { rating: 'good' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/study/ADAPTIVE-TF/review', payload: { ...payload, rating: 'again' } })).statusCode, 409);
  const legacy = await app.inject({ method: 'POST', url: '/api/study/ADAPTIVE-TF/review', payload: { mastery: 3 } }); assert.equal(legacy.statusCode, 200, legacy.body);
  assert.equal(legacy.json().mastery, 3, 'overall mastery remains distinct from the conservative Good memory rating');
  assert.equal(events().length, 2); assert.equal(events().filter(event => event.rating === 'easy').length, 0); assert.equal(card('ADAPTIVE-TF').memory.reps, 2);
});

test('fixed interval fallback and reset keep their distinct contracts', t => {
  const { store, paper, events, cards } = fixture(t);
  const attempt = submitAttempt(store, createAttempt(store, paper), { 'ADAPTIVE-SA': { value: '需要判定的回答' } }); reviewAttempt(store, attempt, { 'ADAPTIVE-SA': 4 });
  const stale = learningResetPreview(store); assert.equal(stale.counts.reviewEvents, 1); assert.equal(stale.counts.reviewCards, 1);
  reviewAttempt(store, attempt, { 'ADAPTIVE-SA': 0 }); assert.throws(() => resetLearningProgress(store, stale.fingerprint), ApiError);
  resetLearningProgress(store, learningResetPreview(store).fingerprint);
  assert.equal(events().length, 0); assert.equal(cards().length, 0);
  reviewAttempt(store, attempt, { 'ADAPTIVE-SA': 4 });
  assert.equal(events().length, 0); assert.equal(cards().length, 0); assert.equal(store.study('ADAPTIVE-SA').mastery, null); assert.equal(store.all('reviews').length, 0);
  store.put('settings', 'system', { ...structuredClone(DEFAULT_SETTINGS), reviewScheduling: { ...structuredClone(DEFAULT_SETTINGS.reviewScheduling), strategy: 'fixed' } });
  const fixed = submitAttempt(store, createAttempt(store, paper), { 'ADAPTIVE-SA': { value: '固定模式说明' } });
  reviewAttempt(store, fixed, {}, { 'ADAPTIVE-SA': 3 });
  const days = (Date.parse(store.study('ADAPTIVE-SA').nextReviewAt!) - Date.now()) / 86400000;
  assert.ok(days > 20.9 && days <= 21); assert.equal(events().length, 0);
});
