import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../server/core/store.js';
import { questionSchema } from '../../server/core/validation.js';
import { DEFAULT_SETTINGS, DEFAULT_REVIEW_SCHEDULING } from '../../shared/models/settings.js';
import type { Question } from '../../shared/models/types.js';
import type { ReviewCard, ReviewEvent, ReviewRating } from '../../shared/models/adaptive-review.js';
import { emptyMemory, reviewMemory } from '../../server/modules/review-scheduler/engine.js';
import { attemptReviewOverview, changeReviewCard, recordManualReview, replayReviewCard, reviewCardId, reviewCardView, reviewQueue, syncAttemptReviewEvents, validateReviewImport } from '../../server/modules/review-scheduler/service.js';
import { buildPaper, createAttempt, type StoredAttempt } from '../../server/modules/practice/service.js';
import { exportData, importData } from '../../server/modules/transfer/migration.js';

const day = (value: number) => new Date(`2026-10-${String(value).padStart(2, '0')}T04:00:00.000Z`);
function fixture(t: test.TestContext) {
  const store = new Store(':memory:'); t.after(() => store.db.close());
  store.put('settings', 'system', structuredClone(DEFAULT_SETTINGS));
  const questions = [
    questionSchema.parse({ id: 'TF', title: '判断', type: 'true_false', stemMarkdown: 'QUESTION_PRIVATE_CANARY', correctAnswers: ['true'], status: 'published' }),
    questionSchema.parse({ id: 'SA', title: '说明', type: 'short_answer', stemMarkdown: 'QUESTION_PRIVATE_CANARY', answerMarkdown: 'REFERENCE_PRIVATE_CANARY', status: 'published' }),
    questionSchema.parse({ id: 'GROUP', title: '组合', type: 'group', stemMarkdown: 'MATERIAL_PRIVATE_CANARY', status: 'published', parts: [
      { id: 'a', title: '判断小题', type: 'true_false', stemMarkdown: '判断', correctAnswers: ['true'] },
      { id: 'b', title: '解释小题', type: 'short_answer', stemMarkdown: '解释', answerMarkdown: 'REFERENCE_PRIVATE_CANARY' },
    ] }),
    questionSchema.parse({ id: 'WORD', title: 'abandon', type: 'short_answer', stemMarkdown: 'abandon', status: 'published', vocabulary: { language: 'en', headword: 'abandon', meaningPrompt: '放弃', acceptedAnswers: ['abandon'], pronunciations: [{ label: '英式', ipa: 'əˈbændən', sourceLabel: '隔离测试', sourceUrl: 'https://example.test/word', license: '测试', method: 'manual' }] } }),
  ] as Question[];
  for (const question of questions) store.put('questions', question.id, question);
  const paper = buildPaper(store, { id: 'REVIEW-PAPER', title: '复习', description: '', mode: 'manual', questionIds: ['TF', 'SA', 'GROUP'], scoring: { enabled: true, totalPoints: 12, questionPoints: { TF: 2, SA: 4, GROUP: 6 } } }); store.put('papers', paper.id, paper);
  const attempt = (id: string, at: Date, answers: StoredAttempt['answers']) => {
    const value = createAttempt(store, paper); store.remove('attempts', value.id);
    Object.assign(value, { id, status: 'submitted', startedAt: at.toISOString(), submittedAt: at.toISOString(), updatedAt: at.toISOString(), answers }); store.put('attempts', id, value); return value;
  };
  const manual = (questionId: string, rating: ReviewRating, at = day(1), requestId = `manual-${questionId}-${at.getTime()}`) => recordManualReview(store, { questionId, rating, requestId }, at);
  return { store, questions, paper, attempt, manual };
}

test('FSRS exposes real four-grade intervals and deterministic fuzzed replay', () => {
  const memory = emptyMemory(day(1)), parameters = { ...structuredClone(DEFAULT_REVIEW_SCHEDULING), enableFuzz: true };
  const values = ['again', 'hard', 'good', 'easy'].map(rating => reviewMemory(memory, rating as ReviewRating, day(1), parameters, 'stable-seed'));
  assert.ok(Date.parse(values[0]!.due) < Date.parse(values[2]!.due)); assert.ok(Date.parse(values[2]!.due) < Date.parse(values[3]!.due));
  assert.deepEqual(reviewMemory(values[3]!, 'good', day(8), parameters, 'repeatable'), reviewMemory(values[3]!, 'good', day(8), parameters, 'repeatable'));
  assert.ok(values.every(value => value.reps === 1 && value.stability > 0));
});

test('new reviews retain independent mastery, preserve legacy due until action and use request idempotency', t => {
  const { store, manual } = fixture(t);
  store.putStudy({ ...store.study('TF'), mastery: 1, notes: 'NOTES_PRIVATE_CANARY', nextReviewAt: day(5).toISOString(), lastReviewedAt: day(1).toISOString() });
  const before = reviewCardView(store, { questionId: 'TF' }, day(2)); assert.equal(before.card, null); assert.equal(before.dueAt, day(5).toISOString());
  assert.equal(store.all('review_cards').length, 0);
  const result = manual('TF', 'good', day(2), 'idempotent'); assert.equal(result.card!.memory.reps, 1); assert.equal(store.study('TF').mastery, 1); assert.equal(store.study('TF').notes, 'NOTES_PRIVATE_CANARY');
  manual('TF', 'good', day(3), 'idempotent'); assert.equal(store.all('review_events').length, 1); assert.equal(store.all('reviews').length, 1);
  assert.throws(() => manual('TF', 'easy', day(3), 'idempotent'));
  const target = new Store(':memory:'); t.after(() => target.db.close()); importData(target, exportData(store));
  assert.equal(target.all<ReviewCard>('review_cards')[0]!.memory.reps, 1);
});

test('submission scheduling excludes omissions and pending subjective work while repeated equal grades remain reviews', t => {
  const { store, attempt } = fixture(t);
  const first = attempt('ATT-1', day(1), { TF: { value: ['true'] }, SA: { value: 'UNJUDGED_PRIVATE_CANARY' }, 'GROUP::a': { value: ['false'] } });
  store.transaction(() => syncAttemptReviewEvents(store, first));
  assert.equal(store.all('review_events').length, 2);
  assert.equal(reviewCardView(store, { questionId: 'SA' }, day(1)).card, null);
  assert.equal(reviewCardView(store, { questionId: 'GROUP', partId: 'b' }, day(1)).card, null);
  const before = store.all<ReviewCard>('review_cards').find(card => card.questionId === 'TF')!;
  syncAttemptReviewEvents(store, first); assert.equal(store.all('review_events').length, 2);
  const second = attempt('ATT-2', day(3), { TF: { value: ['true'] } }); syncAttemptReviewEvents(store, second);
  const after = store.all<ReviewCard>('review_cards').find(card => card.questionId === 'TF')!; assert.equal(after.memory.reps, before.memory.reps + 1);
});

test('early reference exposure allows only Again for correct objective and graded subjective answers', t => {
  const { store, attempt } = fixture(t);
  const value = attempt('ASSISTED', day(2), { TF: { value: ['true'] }, SA: { value: 'correct answer', selfScore: 4 }, 'GROUP::b': { value: 'ungraded answer' } });
  value.referenceViewedAt = day(1).toISOString();
  syncAttemptReviewEvents(store, value);
  assert.equal(store.all('review_events').length, 2);
  assert.ok(store.all<ReviewEvent>('review_events').every(event => event.rating === 'again'));
  for (const leafId of ['TF', 'SA']) for (const rating of ['hard', 'good', 'easy'] as const) assert.throws(() => syncAttemptReviewEvents(store, value, { [leafId]: rating }, [leafId]), /提前查看解析/);
  syncAttemptReviewEvents(store, value, { SA: 'again' }, ['SA']);
  assert.equal(store.all('review_events').length, 2);
  assert.equal(value.answers.SA!.selfScore, 4); assert.deepEqual(value.answers.TF!.value, ['true']);
  assert.equal(reviewCardView(store, { questionId: 'GROUP', partId: 'b' }, day(2)).card, null);
});

test('changing an old grade replays its original event and preserves the latest exposure time', t => {
  const { store, attempt } = fixture(t);
  const first = attempt('OLD-ATT', day(1), { TF: { value: ['true'] } }); syncAttemptReviewEvents(store, first);
  const second = attempt('NEW-ATT', day(4), { TF: { value: ['true'] } }); syncAttemptReviewEvents(store, second);
  const original = store.all<ReviewCard>('review_cards')[0]!;
  syncAttemptReviewEvents(store, first, { TF: 'again' }, ['TF']);
  let card = store.all<ReviewCard>('review_cards')[0]!; assert.equal(card.memory.reps, 2); assert.equal(card.lastReviewedAt, day(4).toISOString()); assert.notDeepEqual(card.memory, original.memory);
  syncAttemptReviewEvents(store, first, { TF: null }, ['TF']); card = store.all<ReviewCard>('review_cards')[0]!; assert.deepEqual(card.memory, original.memory);
});

test('clearing an explicit grade restores no event when automatic objective scheduling was disabled', t => {
  const { store, attempt } = fixture(t);
  store.put('settings', 'system', { ...DEFAULT_SETTINGS, reviewScheduling: { ...DEFAULT_REVIEW_SCHEDULING, autoRateObjective: false } });
  const value = attempt('MANUAL-ONLY', day(1), { TF: { value: ['true'] } });
  syncAttemptReviewEvents(store, value); assert.equal(store.all('review_events').length, 0);
  syncAttemptReviewEvents(store, value, { TF: 'good' }, ['TF']); assert.equal(store.all('review_events').length, 1);
  syncAttemptReviewEvents(store, value, { TF: null }, ['TF']); assert.equal(store.all('review_events').length, 0); assert.equal(store.all<ReviewCard>('review_cards')[0]!.memory.reps, 0);
});

test('subjective partial and zero scores schedule Again, withdrawal removes its event, and ungraded feedback is rejected', t => {
  const { store, attempt } = fixture(t);
  const value = attempt('SUBJECTIVE', day(1), { SA: { value: 'answer', selfScore: 2 } }); syncAttemptReviewEvents(store, value);
  assert.equal(store.all<ReviewEvent>('review_events')[0]!.rating, 'again');
  value.answers.SA!.selfScore = 0; syncAttemptReviewEvents(store, value, {}, ['SA']); assert.equal(store.all('review_events').length, 1);
  value.answers.SA!.selfScore = null; value.answers.SA!.verdict = null; syncAttemptReviewEvents(store, value, {}, ['SA']); assert.equal(store.all('review_events').length, 0);
  assert.throws(() => syncAttemptReviewEvents(store, value, { SA: 'good' }, ['SA']));
});

test('word directions and group leaves are independent and paused directions cannot reappear through legacy state', t => {
  const { store } = fixture(t);
  recordManualReview(store, { questionId: 'WORD', direction: 'word_to_meaning', rating: 'good', requestId: 'forward' }, day(1));
  recordManualReview(store, { questionId: 'WORD', direction: 'meaning_to_word', rating: 'again', requestId: 'reverse' }, day(1));
  const forward = reviewCardView(store, { questionId: 'WORD', direction: 'word_to_meaning' }, day(2)), reverse = reviewCardView(store, { questionId: 'WORD', direction: 'meaning_to_word' }, day(2));
  assert.notEqual(forward.card!.id, reverse.card!.id); assert.equal(store.study('WORD').nextReviewAt, reverse.card!.dueAt);
  changeReviewCard(store, { questionId: 'WORD', direction: 'meaning_to_word', suspended: true }, day(2)); assert.equal(store.study('WORD').nextReviewAt, forward.card!.dueAt);
  changeReviewCard(store, { questionId: 'WORD', direction: 'word_to_meaning', suspended: true }, day(2)); assert.equal(store.study('WORD').nextReviewAt, null);
  assert.equal(reviewQueue(store, { page: 1, pageSize: 10 }, day(3)).total, 0);
  recordManualReview(store, { questionId: 'GROUP', partId: 'a', rating: 'again', requestId: 'part-a' }, day(1));
  assert.equal(reviewCardView(store, { questionId: 'GROUP', partId: 'b' }, day(1)).card, null);
});

test('live queue includes legacy due dates, filters exact time and ignores missing or changed source parts', t => {
  const { store } = fixture(t);
  store.putStudy({ ...store.study('TF'), nextReviewAt: day(1).toISOString() });
  store.putStudy({ ...store.study('SA'), nextReviewAt: day(4).toISOString() });
  store.putStudy({ ...store.study('WORD'), nextReviewAt: day(1).toISOString() });
  const queue = reviewQueue(store, { page: 1, pageSize: 10 }, day(2)); assert.equal(queue.total, 2); assert.equal(queue.items.find(item => item.questionId === 'WORD')!.direction, 'word_to_meaning'); assert.ok(queue.items.every(item => item.card === null));
  store.remove('questions', 'TF'); assert.equal(reviewQueue(store, { page: 1, pageSize: 10 }, day(2)).total, 1);
});

test('legacy group due dates expand into remaining leaves without recreating reviewed or suspended cards', t => {
  const { store, attempt } = fixture(t);
  store.putStudy({ ...store.study('GROUP'), nextReviewAt: day(1).toISOString(), lastReviewedAt: day(1).toISOString() });
  const queue = () => reviewQueue(store, { page: 1, pageSize: 10 }, day(2));
  assert.deepEqual(queue().items.map(item => item.partId), ['a', 'b']);
  assert.ok(queue().items.every(item => item.card === null && item.reason === 'legacy' && item.direction === 'standard'));
  assert.equal(store.all('review_events').length, 0);
  assert.equal(reviewCardView(store, { questionId: 'GROUP', partId: 'a' }, day(2)).dueAt, day(1).toISOString());
  const value = attempt('GROUP-INHERIT', day(2), { 'GROUP::a': { value: ['true'] } });
  syncAttemptReviewEvents(store, value, { 'GROUP::a': 'easy' });
  assert.deepEqual(queue().items.map(item => item.partId), ['b']);
  changeReviewCard(store, { questionId: 'GROUP', partId: 'a', suspended: true }, day(2));
  assert.deepEqual(queue().items.map(item => item.partId), ['b']);
  const subjective = attempt('GROUP-WITHDRAW', day(2), { 'GROUP::b': { value: 'answer', verdict: 'correct' } });
  syncAttemptReviewEvents(store, subjective, { 'GROUP::b': 'easy' });
  assert.equal(queue().total, 0);
  subjective.answers['GROUP::b']!.verdict = null; syncAttemptReviewEvents(store, subjective, {}, ['GROUP::b']);
  assert.equal(store.all('review_events').length, 1);
  assert.equal(reviewCardView(store, { questionId: 'GROUP', partId: 'b' }, day(2)).card!.legacyDueAt, day(1).toISOString());
  assert.deepEqual(queue().items.map(item => item.partId), ['b']);
  changeReviewCard(store, { questionId: 'GROUP', partId: 'b', suspended: true }, day(2));
  assert.equal(queue().total, 0);
});

test('explicit child dates including null override inherited group dates and invalid parts stay absent', t => {
  const { store } = fixture(t);
  store.putStudy({ ...store.study('GROUP'), nextReviewAt: day(1).toISOString() });
  store.putStudy({ ...store.study('GROUP', 'a'), nextReviewAt: day(4).toISOString() });
  store.putStudy({ ...store.study('GROUP', 'b'), nextReviewAt: null });
  store.putStudy({ ...store.study('GROUP', 'removed'), nextReviewAt: day(1).toISOString() });
  const queue = () => reviewQueue(store, { page: 1, pageSize: 10 }, day(2));
  assert.equal(queue().total, 0);
  assert.equal(reviewCardView(store, { questionId: 'GROUP', partId: 'a' }, day(2)).dueAt, day(4).toISOString());
  assert.equal(reviewCardView(store, { questionId: 'GROUP', partId: 'b' }, day(2)).dueAt, null);
  store.putStudy({ ...store.study('GROUP', 'a'), nextReviewAt: day(1).toISOString() });
  assert.deepEqual(queue().items.map(item => item.partId), ['a']);
  assert.equal(store.all('review_cards').length, 0); assert.equal(store.all('review_events').length, 0);
});

test('parameter snapshots apply prospectively and complete imported chains are verified', t => {
  const { store, manual } = fixture(t);
  manual('TF', 'easy', day(1)); const first = store.all<ReviewEvent>('review_events')[0]!;
  store.put('settings', 'system', { ...DEFAULT_SETTINGS, reviewScheduling: { ...DEFAULT_REVIEW_SCHEDULING, desiredRetention: 0.98 } });
  manual('TF', 'good', day(8)); const events = store.all<ReviewEvent>('review_events'); assert.equal(events.find(event => event.id === first.id)!.parameters.desiredRetention, 0.9); assert.ok(events.some(event => event.parameters.desiredRetention === 0.98));
  const cards = store.all<ReviewCard>('review_cards'); validateReviewImport(cards, events);
  assert.throws(() => validateReviewImport(cards.map(card => ({ ...card, memory: { ...card.memory, reps: 99 } })), events));
  assert.throws(() => validateReviewImport(cards, events.map((event, index) => index ? event : { ...event, after: { ...event.after, stability: 999 } })));
  assert.throws(() => validateReviewImport(cards, events.map((event, index) => index ? event : { ...event, id: 'not-json' })));
  assert.throws(() => validateReviewImport(cards.map(card => ({ ...card, baseline: { ...card.baseline, stability: 5 } })), events));
});

test('multi-card import validates independently shuffled event chains, empty cards and snapshot tampering', () => {
  const cards: ReviewCard[] = [], events: ReviewEvent[] = [], stamp = day(1).toISOString();
  for (let index = 0; index <= 64; index++) {
    const identity = { questionId: `BULK-${index}`, direction: 'standard' as const }, baseline = emptyMemory(day(1));
    const card: ReviewCard = { ...identity, id: reviewCardId(identity), algorithm: 'FSRS-6', libraryVersion: '5.4.2', baseline, memory: baseline,
      dueAt: null, lastReviewedAt: null, legacyDueAt: null, legacyLastReviewedAt: null, suspended: false, manualDueAt: null, createdAt: stamp, updatedAt: stamp };
    const chain: ReviewEvent[] = index === 64 ? [] : [1, 4, 8, 12].map((date, step) => ({
      ...identity, id: JSON.stringify(['manual', `bulk-${index}-${step}`]), cardId: card.id, source: 'manual', rating: (['easy', 'again', 'hard', 'good'] as const)[step]!, ratingSource: 'manual',
      occurredAt: day(date).toISOString(), recordedAt: stamp, updatedAt: stamp,
      parameters: { ...structuredClone(DEFAULT_REVIEW_SCHEDULING), desiredRetention: [0.85, 0.9, 0.95][step % 3]!, enableFuzz: index % 2 === 0 },
      algorithm: 'FSRS-6', libraryVersion: '5.4.2', before: baseline, after: baseline,
    }));
    cards.push(replayReviewCard(card, chain.reverse(), event => events.push(event)));
  }
  cards.reverse(); events.reverse();
  const validated = validateReviewImport(cards, events);
  assert.deepEqual(validated.cards, cards); assert.deepEqual(validated.events, events);
  assert.equal(validated.cards[0]!.memory.reps, 0); assert.ok(validated.cards.slice(1).every(card => card.memory.reps === 4));
  assert.throws(() => validateReviewImport(cards, events.map((event, index) => index === 137 ? { ...event, before: { ...event.before, scheduled_days: event.before.scheduled_days + 1 } } : event)), /记忆状态与算法重放不一致/);
  assert.throws(() => validateReviewImport(cards, [...events, events[0]!]), /身份重复/);
  assert.throws(() => validateReviewImport(cards.slice(0, -1), events), /身份或卡片引用不一致/);
});

test('reset markers cannot revive historical events and source deletion retains independent memory history', t => {
  const { store, attempt } = fixture(t); const value = attempt('RESET-ATT', day(1), { TF: { value: ['true'] } });
  store.put('learning_results', value.id, { id: value.id, reset: true }); syncAttemptReviewEvents(store, value); assert.equal(store.all('review_events').length, 0);
  store.remove('learning_results', value.id); syncAttemptReviewEvents(store, value); store.remove('attempts', value.id); store.remove('questions', 'TF');
  validateReviewImport(store.all('review_cards'), store.all('review_events')); assert.equal(reviewQueue(store, { page: 1, pageSize: 10 }, day(5)).total, 0);
});

test('card and batch overview reads return metadata without stems, reference answers, notes or writes', t => {
  const { store, attempt } = fixture(t); const value = attempt('META-ATT', day(1), { TF: { value: ['true'] } }); syncAttemptReviewEvents(store, value);
  store.putStudy({ ...store.study('TF'), notes: 'NOTES_PRIVATE_CANARY' });
  const read = store.database.all.bind(store.database), one = store.database.one.bind(store.database); let calls = 0;
  const check = (result: unknown) => { assert.doesNotMatch(JSON.stringify(result) || '', /QUESTION_PRIVATE_CANARY|REFERENCE_PRIVATE_CANARY|MATERIAL_PRIVATE_CANARY|NOTES_PRIVATE_CANARY/); return result; };
  store.database.all = ((query: any) => { calls++; return check(read(query)); }) as any;
  store.database.one = ((query: any) => { calls++; return check(one(query)); }) as any;
  store.database.run = () => { throw new Error('GET must not write'); };
  reviewCardView(store, { questionId: 'TF' }, day(2)); const before = calls; attemptReviewOverview(store, value); assert.ok(calls - before < 10); reviewQueue(store, { page: 1, pageSize: 10 }, day(2));
});
