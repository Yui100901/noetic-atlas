import type { Question, StudyState, VocabularyDirection } from '../models/types.js';

export type LearningSource = 'paper' | 'quick';
export interface LearningContext { source: LearningSource; paperId?: string }
export interface ContextLearningSummary extends LearningContext {
  title: string; deleted: boolean; archived: boolean;
  counts: { drafts: number; submitted: number; wrong: number; due: number; favorite: number };
  /** Transparent local rules. No model request is performed by these reads. */
  suggestions: string[];
}
export interface AttemptHistoryItem {
  vocabularyDirection?: VocabularyDirection;
  id: string; source: LearningSource; paperId: string; paperTitle: string; paperVersion: number;
  status: 'in_progress' | 'submitted'; practiceMode: 'practice' | 'exam';
  startedAt: string; updatedAt: string; submittedAt: string | null;
  referenceViewedAt: string | null; elapsedSeconds: number; durationMinutes: number | null; deadlineAt: string | null; autoSubmitted: boolean;
  questionCount: number; answeredCount: number;
  scoringEnabled: boolean; totalPoints: number;
  objectiveScore: number; objectiveMax: number; subjectiveScore: number; subjectiveMax: number;
  totalScore: number | null; pendingSubjectiveCount: number;
  gradingStatus: 'not_applicable' | 'pending' | 'partial' | 'complete';
}
/** Frozen leaf content, including the material needed by grouped questions. */
export interface LearningQuestionSnapshot extends Question {
  sourceQuestionId?: string; groupId?: string; groupTitle?: string; groupStemMarkdown?: string; partId?: string; partIndex?: number;
}
export interface ContextLearningQuestion {
  question: LearningQuestionSnapshot;
  answerState?: 'incorrect' | 'unanswered';
  attemptId?: string; historyAvailable?: boolean; wrongCount: number; lastPracticedAt?: string; study?: StudyState;
}
