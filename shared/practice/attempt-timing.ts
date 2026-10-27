import type { Attempt, AttemptAnswer, AttemptQuestion } from '../models/types.js';
import { getObjectiveCorrect, isSubjectiveType } from '../questions/question-utils.js';

/** Practice reads show acknowledged active time only. A page owns its local
 * monotonic stopwatch; drafts must never keep growing while nobody is reading.
 * Exams retain their absolute deadline even across sleep and reload. */
export function attemptElapsedSeconds(attempt: Pick<Attempt, 'startedAt' | 'submittedAt' | 'deadlineAt' | 'practiceMode' | 'elapsedSeconds' | 'status' | 'practiceTiming'>, currentTime = Date.now()): number {
  if (attempt.status === 'submitted' && attempt.elapsedSeconds != null) return attempt.elapsedSeconds;
  if (attempt.practiceMode !== 'exam') {
    if (attempt.practiceTiming) return Math.floor(attempt.practiceTiming.elapsedMilliseconds / 1000);
    if (attempt.elapsedSeconds != null) return attempt.elapsedSeconds;
    if (attempt.status === 'in_progress') return 0;
  }
  const start = Date.parse(attempt.startedAt), end = attempt.submittedAt ? Date.parse(attempt.submittedAt) : currentTime;
  const limitedEnd = attempt.practiceMode === 'exam' && attempt.deadlineAt ? Math.min(end, Date.parse(attempt.deadlineAt)) : end;
  return Number.isFinite(start) && Number.isFinite(limitedEnd) ? Math.max(0, Math.floor((limitedEnd - start) / 1000)) : 0;
}
export function examRemainingSeconds(attempt: Pick<Attempt, 'deadlineAt'>, currentTime = Date.now()): number {
  return attempt.deadlineAt ? Math.max(0, Math.ceil((Date.parse(attempt.deadlineAt) - currentTime) / 1000)) : 0;
}
export function examExpired(attempt: Pick<Attempt, 'status' | 'practiceMode' | 'deadlineAt'>, currentTime = Date.now()): boolean {
  return attempt.status === 'in_progress' && attempt.practiceMode === 'exam' && !!attempt.deadlineAt && Date.parse(attempt.deadlineAt) <= currentTime;
}
export function durationText(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  return [Math.floor(value / 3600), Math.floor(value % 3600 / 60), value % 60].map(n => String(n).padStart(2, '0')).join(':');
}
export function isAnswerPresent(answer?: Pick<AttemptAnswer, 'value'>): boolean {
  return !!answer && (Array.isArray(answer.value) ? answer.value.some(value => value.trim().length > 0) : answer.value.trim().length > 0);
}
export type AnswerState = 'unanswered' | 'answered' | 'correct' | 'partial' | 'incorrect' | 'ungraded';
export const answerStateLabels: Record<AnswerState, string> = { unanswered: '未作答', answered: '已作答', correct: '回答正确', partial: '部分正确', incorrect: '回答错误', ungraded: '未判定' };
/** The same exact objective matcher handles ordinary questions and flattened group leaves. */
export function answerState(question: Pick<AttemptQuestion, 'type' | 'correctAnswers' | 'blanks'>, answer: AttemptAnswer | undefined, submitted: boolean, maximumPoints?: number): AnswerState {
  if (!isAnswerPresent(answer)) return 'unanswered';
  if (!submitted) return 'answered';
  if (!isSubjectiveType(question.type)) return getObjectiveCorrect(question, answer) ? 'correct' : 'incorrect';
  if (answer?.selfScore != null && maximumPoints != null) return answer.selfScore >= maximumPoints ? 'correct' : answer.selfScore > 0 ? 'partial' : 'incorrect';
  return answer?.verdict || 'ungraded';
}
