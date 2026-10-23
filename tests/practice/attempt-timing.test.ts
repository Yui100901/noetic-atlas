import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../server/core/store.js';
import { attemptView, buildPaper, createAttempt, getActiveExam, saveAttempt, submitAttempt, syncAttempt, syncExams, validateAttemptTiming } from '../../server/modules/practice/service.js';
import { answerState, attemptElapsedSeconds, durationText, examRemainingSeconds } from '../../shared/practice/attempt-timing.js';
import type { AttemptQuestion, Question } from '../../shared/models/types.js';

const start = Date.parse('2026-10-22T01:00:00.000Z');
function fixture(t: test.TestContext) {
  const store = new Store(':memory:'); t.after(() => store.db.close());
  const question: Question = { id: 'T', title: '判断', type: 'true_false', stemMarkdown: 'TCP可靠传输', answerMarkdown: '对', explanationMarkdown: '', options: [], correctAnswers: ['true'], difficulty: 1, depth: 1, frequency: 1, frequencyScope: '', frequencyBasis: '', collection: 'general', status: 'published', categoryIds: [], tagIds: [], sourceRefs: [], sourceDocument: null, sourceAnchor: null };
  store.put('questions', question.id, question);
  const paper = buildPaper(store, { id: 'P', title: '计时测试', mode: 'manual', description: '', questionIds: ['T'], scoring: { enabled: true, questionPoints: { T: 2 } } }); store.put('papers', paper.id, paper);
  return { store, paper };
}

test('normal practice measures wall time across draft saves and freezes elapsed time after submission', t => {
  t.mock.timers.enable({ apis: ['Date'], now: start }); const { store, paper } = fixture(t);
  const attempt = createAttempt(store, paper); assert.equal(attempt.practiceMode, 'practice'); assert.equal(attempt.deadlineAt, null);
  t.mock.timers.tick(90000); saveAttempt(store, attempt, { T: { value: 'true' } }); assert.equal(attempt.elapsedSeconds, 90);
  t.mock.timers.tick(15000); submitAttempt(store, attempt); assert.equal(attempt.elapsedSeconds, 105); assert.equal(attempt.objectiveScore, 2);
  t.mock.timers.tick(60000); assert.equal(attemptView(attempt).elapsedSeconds, 105); assert.equal(attemptElapsedSeconds(attempt), 105); validateAttemptTiming(attempt);
});

test('exam deadline rejects late answer replacement, auto submits saved answers exactly once and records deadline duration', t => {
  t.mock.timers.enable({ apis: ['Date'], now: start }); const { store, paper } = fixture(t);
  const attempt = createAttempt(store, paper, { mode: 'exam', durationMinutes: 1 }); assert.equal(examRemainingSeconds(attempt), 60);
  assert.throws(() => createAttempt(store, paper, { mode: 'exam' }), /进行中的考试/);
  t.mock.timers.tick(59000); saveAttempt(store, attempt, { T: { value: 'true' } }); assert.equal(attempt.elapsedSeconds, 59);
  t.mock.timers.tick(1001); const result = saveAttempt(store, attempt, { T: { value: 'false' } });
  assert.equal(result.status, 'submitted'); assert.equal(result.autoSubmitted, true); assert.equal(result.answers.T!.value, 'true'); assert.equal(result.objectiveScore, 2); assert.equal(result.elapsedSeconds, 60); assert.equal(result.submittedAt, result.deadlineAt);
  assert.equal(attemptView(result).answerStates!.T, 'correct'); assert.equal(getActiveExam(store), undefined);
  const persisted = JSON.stringify(store.require('attempts', result.id)); submitAttempt(store, result, { T: { value: 'false' } }); syncAttempt(store, result); syncExams(store); assert.equal(JSON.stringify(store.require('attempts', result.id)), persisted); validateAttemptTiming(result);
});

test('early submission releases the active exam while invalid durations and forged timing are rejected', t => {
  t.mock.timers.enable({ apis: ['Date'], now: start }); const { store, paper } = fixture(t);
  for (const durationMinutes of [0, 1.5, 1441, NaN]) assert.throws(() => createAttempt(store, paper, { mode: 'exam', durationMinutes }), /考试时长/);
  const attempt = createAttempt(store, paper, { mode: 'exam' }); assert.equal(attempt.durationMinutes, 120);
  t.mock.timers.tick(30000); submitAttempt(store, attempt, { T: { value: 'false' } }); assert.equal(attempt.elapsedSeconds, 30); assert.equal(attempt.autoSubmitted, false); assert.equal(store.study('T').wrongCount, 1);
  const next = createAttempt(store, paper, { mode: 'exam', durationMinutes: 2 }); assert.equal(getActiveExam(store)?.id, next.id);
  assert.throws(() => validateAttemptTiming({ ...next, deadlineAt: new Date(start + 1000).toISOString() }), /期限/);
  assert.throws(() => validateAttemptTiming({ ...next, autoSubmitted: true }), /标记/);
  assert.throws(() => validateAttemptTiming({ ...next, elapsedSeconds: 121 }), /计时/);
});

test('refresh/offline resume synchronization finalizes an overdue unanswered exam and keeps original saved values', t => {
  t.mock.timers.enable({ apis: ['Date'], now: start }); const { store, paper } = fixture(t);
  const attempt = createAttempt(store, paper, { mode: 'exam', durationMinutes: 1 });
  t.mock.timers.tick(2 * 3600000); const restored = store.require<typeof attempt>('attempts', attempt.id); syncAttempt(store, restored);
  assert.equal(restored.status, 'submitted'); assert.equal(restored.elapsedSeconds, 60); assert.equal(store.study('T').wrongCount, 1); assert.equal(attemptView(restored).answerStates!.T, 'unanswered');
  syncExams(store); assert.equal(store.study('T').wrongCount, 1);
});

test('answer-card states distinguish unfilled, answered, exact objective correctness and subjective null/zero/full marks', () => {
  const judge: AttemptQuestion = { id: 'T', sourceQuestionId: 'T', title: '', type: 'true_false', stemMarkdown: '', options: [], difficulty: 1, depth: 1, frequency: 0, collection: 'general', correctAnswers: ['true'] };
  assert.equal(answerState(judge, undefined, false), 'unanswered'); assert.equal(answerState(judge, { value: 'false' }, false), 'answered');
  assert.equal(answerState(judge, { value: 'true' }, true), 'correct'); assert.equal(answerState(judge, { value: 'false' }, true), 'incorrect');
  const multi = { ...judge, type: 'multiple_choice' as const, correctAnswers: ['A', 'C'] }; assert.equal(answerState(multi, { value: ['A'] }, true), 'incorrect'); assert.equal(answerState(multi, { value: ['C', 'A'] }, true), 'correct');
  const blanks = { ...judge, type: 'fill_blank' as const, blanks: [{ id: 'one', label: '', caseSensitive: false, trim: true, answers: ['TCP'] }, { id: 'two', label: '', caseSensitive: true, trim: false, answers: ['Go'] }] };
  assert.equal(answerState(blanks, { value: ['', ''] }, false), 'unanswered'); assert.equal(answerState(blanks, { value: ['tcp', ''] }, false), 'answered'); assert.equal(answerState(blanks, { value: ['tcp', ''] }, true), 'incorrect'); assert.equal(answerState(blanks, { value: [' TCP ', 'Go'] }, true), 'correct');
  const essay = { ...judge, type: 'essay' as const }; assert.equal(answerState(essay, { value: '论证', selfScore: null }, true, 5), 'ungraded'); assert.equal(answerState(essay, { value: '论证', selfScore: 0 }, true, 5), 'incorrect'); assert.equal(answerState(essay, { value: '论证', selfScore: 3 }, true, 5), 'incorrect'); assert.equal(answerState(essay, { value: '论证', selfScore: 5 }, true, 5), 'correct'); assert.equal(answerState(essay, { value: '', selfScore: 0 }, true, 5), 'unanswered');
  assert.equal(durationText(7261), '02:01:01');
});
