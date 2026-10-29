import type { AnswerVerdict, Attempt } from '../../../shared/models/types';
import { isSubjectiveType } from '../../../shared/questions/question-utils';

export interface AttemptReviewState {
  scores: Record<string, number | ''>;
  verdicts: Record<string, AnswerVerdict | ''>;
  mastery: Record<string, number>;
}
export function reviewStateFromAttempt(attempt: Attempt): AttemptReviewState {
  const subjects = attempt.questions.filter((question) => isSubjectiveType(question.type));
  return {
    scores: Object.fromEntries(
      subjects.map((question) => [question.id, attempt.answers[question.id]?.selfScore ?? '']),
    ),
    verdicts: Object.fromEntries(
      subjects.map((question) => [question.id, attempt.answers[question.id]?.verdict || '']),
    ),
    mastery: Object.fromEntries(
      Object.entries(attempt.answers)
        .filter(([, answer]) => answer.mastery !== undefined && answer.mastery !== null)
        .map(([id, answer]) => [id, answer.mastery as number]),
    ),
  };
}
/** Stable content baseline: clicking an already persisted value is not dirty;
 * clearing a score or verdict is a real change and must survive navigation. */
export function reviewStateKey(state: AttemptReviewState): string {
  const sorted = (values: Record<string, unknown>) =>
    Object.keys(values)
      .sort()
      .map((key) => [key, values[key]]);
  return JSON.stringify([sorted(state.scores), sorted(state.verdicts), sorted(state.mastery)]);
}
