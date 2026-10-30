import type { ReviewDirection } from './adaptive-review.js';
import type { LeafQuestionType } from './types.js';

export interface LearningGoal {
  id: string;
  name: string;
  enabled: boolean;
  domainId: string;
  categoryIds: string[];
  tagIds: string[];
  tagMode: 'all' | 'any';
  weekdays: number[];
  priority: number;
  weight: number;
  reviewPoints: number;
  newPoints: number;
  mode: 'focus' | 'practice';
  direction: 'default' | 'word_to_meaning' | 'meaning_to_word' | 'both';
}
export interface LearningTask {
  id: string;
  goalId: string;
  questionId: string;
  partId?: string;
  direction: ReviewDirection;
  type: LeafQuestionType;
  title: string;
  points: number;
  kind: 'review' | 'new';
}
export interface LearningGoalDay {
  goal: LearningGoal;
  paperId: string | null;
  targetReviewPoints: number;
  targetNewPoints: number;
  reviewPoints: number;
  newPoints: number;
  totalPoints: number;
  shortfall: number;
  reason: string;
}
export interface LearningDay {
  id: string;
  dateKey: string;
  generatedAt: string;
  timeZone: string;
  title: string;
  readAt: string | null;
  allocationMode: 'weights' | 'fixed';
  targetReviewPoints: number;
  targetNewPoints: number;
  totalPoints: number;
  shortfall: number;
  goals: LearningGoalDay[];
  tasks: LearningTask[];
}
export interface LearningTaskResult {
  id: string;
  dayId: string;
  taskId: string;
  answeredAt: string | null;
  reviewedAt: string | null;
  completedAt: string | null;
  attemptId: string | null;
  reviewId: string | null;
}
export interface LearningPlanProgress {
  total: number;
  completed: number;
  answered: number;
  reviewed: number;
  completedPoints: number;
  totalPoints: number;
  percent: number;
}
export interface LearningDayView extends LearningDay {
  progress: LearningPlanProgress;
  goalProgress: Record<string, LearningPlanProgress>;
  taskProgress: Record<string, LearningTaskResult>;
  focusDrafts: Array<{
    id: string;
    title: string;
    rated: number;
    total: number;
    updatedAt: string;
    goalId?: string;
  }>;
  paperAvailability: Record<string, boolean>;
  practiceDrafts: Array<{ id: string; title: string; updatedAt: string; goalId?: string }>;
}
export interface LearningPlanAnalytics {
  days: number;
  scheduledDays: number;
  restDays: number;
  completedDays: number;
  targetPoints: number;
  plannedPoints: number;
  completedPoints: number;
  goals: Array<{
    id: string;
    name: string;
    domainId: string;
    days: number;
    targetPoints: number;
    plannedPoints: number;
    completedPoints: number;
    completed: number;
    total: number;
  }>;
}

export type LearningDayOverview = Omit<LearningDayView, 'tasks' | 'taskProgress'>;
