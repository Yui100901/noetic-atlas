import type { AttemptAnswer, ExamQuestion, PracticeTiming, Question } from './types.js';
import type { ReviewDirection, ReviewRating } from './adaptive-review.js';

export interface FocusQuestion extends Question {
  sourceQuestionId?: string;
  partId?: string;
  groupId?: string;
  groupTitle?: string;
  groupStemMarkdown?: string;
  partIndex?: number;
}
export interface FocusItem {
  paperId?: string;
  paperTitle?: string;
  paperVersion?: number;
  key: string;
  questionId: string;
  partId?: string;
  direction: ReviewDirection;
  sourceUpdatedAt: string;
  sourceFingerprint: string;
  startedElapsedSeconds: number;
  question: FocusQuestion;
  phase: 'recall' | 'revealed' | 'rated' | 'skipped';
  mode: 'mental' | 'written';
  answer?: AttemptAnswer;
  attemptId?: string;
  rating?: ReviewRating;
  dueAt?: string | null;
  verdict?: 'correct' | 'partial' | 'incorrect' | null;
}
export interface FocusSession {
  learningDayId?: string;
  learningGoalId?: string;
  id: string;
  paperId: string | null;
  title: string;
  paperVersion: number;
  scope: 'due' | 'all';
  strategy: 'fsrs' | 'fixed';
  status: 'in_progress' | 'submitted';
  practiceMode: 'practice';
  revision: number;
  items: FocusItem[];
  index: number;
  startedAt: string;
  updatedAt: string;
  submittedAt: string | null;
  elapsedSeconds: number;
  practiceTiming: PracticeTiming;
  reset?: boolean;
  summary?: FocusSummary;
}
export interface FocusSummary {
  learningDayId?: string;
  learningGoalId?: string;
  id: string;
  paperId: string | null;
  title: string;
  status: FocusSession['status'];
  scope: FocusSession['scope'];
  total: number;
  rated: number;
  skipped: number;
  written: number;
  mental: number;
  ratings: Record<ReviewRating, number>;
  elapsedSeconds: number;
  startedAt: string;
  updatedAt: string;
  submittedAt: string | null;
}
export interface FocusView extends FocusSummary {
  revision: number;
  strategy: FocusSession['strategy'];
  practiceTiming: PracticeTiming;
  reset?: boolean;
  current: null | {
    index: number;
    key: string;
    direction: ReviewDirection;
    question: ExamQuestion;
    phase: FocusItem['phase'];
    mode: FocusItem['mode'];
    answer?: AttemptAnswer;
    reference?: FocusQuestion;
    correct?: boolean;
    attemptId?: string;
  };
  results: Array<{
    index: number;
    title: string;
    phase: FocusItem['phase'];
    rating?: ReviewRating;
    dueAt?: string | null;
    attemptId?: string;
  }>;
}
