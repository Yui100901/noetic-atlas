import type { PaperScoring, QuestionType, Option, SourceRef, BlankSpec } from './types.js';

export type ExportMode = 'blank' | 'answers' | 'completed';
export const exportModeLabels: Record<ExportMode, string> = { blank: '空白卷', answers: '附答案卷', completed: '完成卷' };
export interface ExportQuestion {
  id: string; number: number; title: string; type: QuestionType; stemMarkdown: string;
  options: Option[]; difficulty: number; depth: number; frequency: number; points: number | null;
  blanks?: Array<Omit<BlankSpec, 'answers'> & { answers?: string[] }>; sourceQuestionId?: string; groupId?: string; groupTitle?: string; groupStemMarkdown?: string; partId?: string; partIndex?: number;
  answerMarkdown?: string; explanationMarkdown?: string; correctAnswers?: string[]; sourceRefs?: SourceRef[];
  userAnswer?: string | string[]; correct?: boolean | null; earnedPoints?: number | null;
  grading?: 'correct' | 'incorrect' | 'pending' | 'graded' | 'unscored';
}
export interface ExportDocument {
  version: 1; mode: ExportMode; title: string; description: string; filename: string;
  paperId: string; paperVersion: number; attemptId?: string; generatedAt: string;
  snapshotCreatedAt: string; submittedAt?: string | null; scoring: PaperScoring;
  summary?: { objectiveScore: number; objectiveMax: number; subjectiveScore: number; subjectiveMax: number; pendingSubjectiveCount: number; totalScore: number | null; correctObjectiveCount: number; objectiveCount: number };
  questions: ExportQuestion[]; markdown: string;
}
