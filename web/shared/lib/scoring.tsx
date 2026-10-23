import { isSubjectiveType } from '../../../shared/questions/question-utils';
import type { Attempt, ExamQuestion, PaperScoring, QuestionType } from '../../../shared/models/types';

export const defaultPoints: Record<QuestionType, number> = { single_choice: 2, multiple_choice: 2, true_false: 1, short_answer: 3, fill_blank: 2, essay: 10, group: 6 };
export const legacyPoints: Record<QuestionType, number> = { single_choice: 1, multiple_choice: 2, true_false: 1, short_answer: 3, fill_blank: 2, essay: 10, group: 6 };
export const pointNumber = (value: number) => Number.isFinite(value) ? Number(value.toFixed(2)) : 0;
export const pointText = (value: number) => Number.isFinite(value) ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value) : '—';
export const validPoints = (value: number, maximum = 1000) => Number.isFinite(value) && value >= 0.01 && value <= maximum && Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;

// Old exports have no scoring field. Their original 1/2/3 scheme stays visible.
export function paperScoring(value: { scoring?: PaperScoring; questions: ExamQuestion[] }): PaperScoring {
  if (value.scoring) return value.scoring;
  const questionPoints = Object.fromEntries(value.questions.map(question => [question.id, question.points ?? legacyPoints[question.type]]));
  const objectivePoints = pointNumber(value.questions.filter(question => !isSubjectiveType(question.type)).reduce((sum, question) => sum + questionPoints[question.id], 0));
  const subjectivePoints = pointNumber(value.questions.filter(question => isSubjectiveType(question.type)).reduce((sum, question) => sum + questionPoints[question.id], 0));
  const totalPoints = pointNumber(objectivePoints + subjectivePoints);
  return { enabled: true, scheme: 'legacy', totalPoints, questionPoints, objectivePoints, subjectivePoints, objectivePercent: totalPoints ? objectivePoints / totalPoints * 100 : 0, actualObjectivePercent: totalPoints ? objectivePoints / totalPoints * 100 : 0, pointsByType: legacyPoints };
}
export function attemptGrading(attempt: Attempt) {
  const scoring = paperScoring(attempt);
  const subjective = attempt.questions.filter(question => isSubjectiveType(question.type));
  const graded = attempt.gradedSubjectiveCount ?? subjective.filter(question => attempt.answers[question.id]?.selfScore !== null && attempt.answers[question.id]?.selfScore !== undefined).length;
  const pending = attempt.pendingSubjectiveCount ?? Math.max(0, subjective.length - graded);
  const total = scoring.enabled && attempt.status === 'submitted' && pending === 0 ? attempt.totalScore ?? pointNumber(attempt.objectiveScore + attempt.subjectiveScore) : null;
  return { scoring, graded, pending, total };
}
export function ScoringBreakdown({ scoring, questionCount, compact = false }: { scoring: PaperScoring; questionCount: number; compact?: boolean }) {
  if (!scoring.enabled) return <div className="score-mode-note"><span className="badge">无分练习</span><span>{questionCount} 道题 · 客观题核对正误，所有题型可自测掌握度。</span></div>;
  return <div className={`scoring-breakdown ${compact ? 'scoring-compact' : ''}`}>
    <div className="scoring-total"><span>{scoring.scheme === 'legacy' ? '旧版计分' : '试卷总分'}</span><strong>{pointText(scoring.totalPoints)}<small> 分</small></strong><span>{questionCount} 道题</span></div>
    <div className="scoring-proportions"><div className="score-ratio-bar" aria-hidden="true"><span style={{ width: `${Math.max(0, Math.min(100, scoring.actualObjectivePercent))}%` }} /></div><div className="score-ratio-labels"><span>客观 {pointText(scoring.objectivePoints)} 分 · {pointText(scoring.actualObjectivePercent)}%</span><span>主观 {pointText(scoring.subjectivePoints)} 分 · {pointText(100 - scoring.actualObjectivePercent)}%</span></div></div>
  </div>;
}
