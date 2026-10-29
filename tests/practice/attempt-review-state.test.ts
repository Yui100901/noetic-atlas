import test from 'node:test';
import assert from 'node:assert/strict';
import type { Attempt } from '../../shared/models/types.js';
import { reviewStateFromAttempt, reviewStateKey } from '../../web/features/practice/attempt-review-state.js';

test('manual review baselines retain zero, ungraded blanks and independent mastery without treating key order as edits', () => {
  const attempt = { questions: [{ id: 'subject', type: 'short_answer' }, { id: 'blank', type: 'essay' }, { id: 'choice', type: 'true_false' }],
    answers: { subject: { value: '回答', selfScore: 0, verdict: 'incorrect', mastery: 0 }, choice: { value: 'true', mastery: 3 } } } as unknown as Attempt;
  const initial = reviewStateFromAttempt(attempt);
  assert.deepEqual(initial, { scores: { subject: 0, blank: '' }, verdicts: { subject: 'incorrect', blank: '' }, mastery: { subject: 0, choice: 3 } });
  assert.equal(reviewStateKey(initial), reviewStateKey({ scores: { blank: '', subject: 0 }, verdicts: { blank: '', subject: 'incorrect' }, mastery: { choice: 3, subject: 0 } }));
  assert.notEqual(reviewStateKey(initial), reviewStateKey({ ...initial, scores: { ...initial.scores, subject: '' } }));
  assert.notEqual(reviewStateKey(initial), reviewStateKey({ ...initial, verdicts: { ...initial.verdicts, subject: '' } }));
  assert.notEqual(reviewStateKey(initial), reviewStateKey({ ...initial, mastery: { ...initial.mastery, subject: 1 } }));
  assert.equal(attempt.answers.subject.selfScore, 0);
});
