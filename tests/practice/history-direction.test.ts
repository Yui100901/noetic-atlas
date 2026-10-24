import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../server/core/store.js';
import { questionSchema } from '../../server/core/validation.js';
import type { Question, VocabularyDirection } from '../../shared/models/types.js';
import type { StoredAttempt } from '../../server/modules/practice/service.js';
import { reverseVocabularyQuestion } from '../../server/modules/practice/vocabulary-practice.js';
import { flattenQuestions } from '../../server/modules/questions/structure.js';
import { normalizeScoring } from '../../server/modules/practice/scoring.js';
import { learningMetadata, preserveLearningResults, resultFromAttempt, validateLearningResult } from '../../server/modules/practice/learning-results.js';
import { archiveAttemptQuestionHistory, validateQuestionHistory } from '../../server/modules/questions/history-store.js';
import { questionHistory, questionStatistics } from '../../server/modules/questions/history.js';
import { exportData, importData } from '../../server/modules/transfer/migration.js';

const stamp = '2026-10-24T00:00:00Z';
function fixture(t: test.TestContext) {
  const store = new Store(':memory:'); t.after(() => store.db.close());
  const question = questionSchema.parse({ id: 'word-history', title: 'abandon', type: 'short_answer', stemMarkdown: 'abandon', answerMarkdown: '放弃；遗弃', explanationMarkdown: '用于放弃计划或遗弃对象。', status: 'published', vocabulary: { language: 'en', headword: 'abandon', meaningPrompt: '放弃；遗弃', acceptedAnswers: ['abandon'], pronunciations: [{ label: '美式', ipa: '/əˈbændən/', sourceLabel: 'Test source', sourceUrl: 'https://example.org/readings', license: 'MIT', method: 'source' }] } }) as Question;
  store.put('questions', question.id, question);
  const attempt = (id: string, direction: VocabularyDirection): StoredAttempt => {
    const questions = flattenQuestions([direction === 'meaning_to_word' ? reverseVocabularyQuestion(question) : question]);
    const scoring = normalizeScoring(questions, { enabled: false });
    return { id, source: 'paper', paperId: 'word-set', paperTitle: '高频词汇', paperVersion: 1, vocabularyDirection: direction, status: 'submitted', questions, scoring, answers: { [question.id]: direction === 'meaning_to_word' ? { value: ['wrong'] } : { value: '放弃', verdict: 'correct' } }, objectiveScore: 0, objectiveMax: 0, subjectiveScore: 0, subjectiveMax: 0, startedAt: stamp, updatedAt: stamp, submittedAt: stamp };
  };
  return { store, question, attempt };
}

test('both vocabulary directions remain explicit in learning summaries and question details after whole attempts are pruned', t => {
  const { store, question, attempt } = fixture(t);
  const sessions = [attempt('forward-session', 'word_to_meaning'), attempt('reverse-session', 'meaning_to_word')];
  for (const session of sessions) { store.put('attempts', session.id, session); preserveLearningResults(store, session); }
  assert.deepEqual(learningMetadata(store).map(item => item.vocabularyDirection).sort(), ['meaning_to_word', 'word_to_meaning']);
  assert.equal(questionHistory(store, question.id, { page: 1, pageSize: 10 }).items.find(item => item.attemptId === 'reverse-session')?.vocabularyDirection, 'meaning_to_word');
  for (const session of sessions) { archiveAttemptQuestionHistory(store, session); store.remove('attempts', session.id); }
  assert.ok(learningMetadata(store).every(item => !item.historyAvailable));
  const details = questionHistory(store, question.id, { page: 1, pageSize: 10 }).items;
  assert.equal(details.find(item => item.attemptId === 'reverse-session')?.vocabularyDirection, 'meaning_to_word');
  assert.equal(details.find(item => item.attemptId === 'forward-session')?.vocabularyDirection, 'word_to_meaning');
  assert.equal(details.find(item => item.attemptId === 'reverse-session')?.question.type, 'fill_blank');
  assert.equal(details.find(item => item.attemptId === 'forward-session')?.question.type, 'short_answer');
  const stats = questionStatistics(store, question.id); assert.equal(stats.answered, 2); assert.equal(stats.correct, 1); assert.equal(stats.incorrect, 1);
  const receiver = new Store(':memory:'); t.after(() => receiver.db.close()); importData(receiver, exportData(store));
  assert.deepEqual(learningMetadata(receiver).map(item => item.vocabularyDirection).sort(), ['meaning_to_word', 'word_to_meaning']);
  assert.deepEqual(questionHistory(receiver, question.id, { page: 1, pageSize: 10 }).items.map(item => item.vocabularyDirection), details.map(item => item.vocabularyDirection));
});

test('directions are validated against retained attempts; old missing metadata is recovered only from those attempts', t => {
  const { store, attempt } = fixture(t), session = attempt('reverse-validation', 'meaning_to_word');
  store.put('attempts', session.id, session); preserveLearningResults(store, session);
  const record = store.all<any>('question_history')[0];
  assert.throws(() => validateQuestionHistory(store, { ...record, vocabularyDirection: 'word_to_meaning' }));
  const { vocabularyDirection: _direction, ...legacy } = record;
  assert.equal(validateQuestionHistory(store, legacy).vocabularyDirection, 'meaning_to_word');
  const result = resultFromAttempt(session);
  assert.throws(() => validateLearningResult(store, { ...result, vocabularyDirection: 'word_to_meaning' }, session));
  const { vocabularyDirection: _resultDirection, ...oldResult } = result;
  assert.equal(validateLearningResult(store, oldResult, session).vocabularyDirection, 'meaning_to_word');
  // A query of pre-upgrade compact evidence may use its actual retained session.
  store.put('learning_results', session.id, oldResult); store.put('question_history', record.id, legacy);
  assert.equal(learningMetadata(store)[0]?.vocabularyDirection, 'meaning_to_word');
  assert.equal(questionHistory(store, 'word-history', { page: 1, pageSize: 10 }).items[0]?.vocabularyDirection, 'meaning_to_word');
  archiveAttemptQuestionHistory(store, session); store.remove('attempts', session.id);
  const detached = store.all<any>('question_history')[0];
  assert.equal(detached.vocabularyDirection, 'meaning_to_word');
  assert.throws(() => validateQuestionHistory(store, { ...detached, vocabularyDirection: 'word_to_meaning' }));
});
