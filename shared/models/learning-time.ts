import type { LeafQuestionType } from './types.js';

export interface LearningTimeBudget {
  enabled: boolean;
  weekdayMinutes: number;
  weekendMinutes: number;
  /** Zero derives the weekly target from the configured learning weekdays. */
  weeklyMinutes: number;
}
export const DEFAULT_LEARNING_TIME_BUDGET: LearningTimeBudget = {
  enabled: false,
  weekdayMinutes: 30,
  weekendMinutes: 60,
  weeklyMinutes: 0,
};
/** Fallback estimates are learning time assumptions, never score conversions. */
export const DEFAULT_TASK_SECONDS: Record<LeafQuestionType, number> = {
  true_false: 45,
  single_choice: 60,
  multiple_choice: 90,
  fill_blank: 75,
  short_answer: 180,
  essay: 600,
};
export interface LearningDayTime {
  targetSeconds: number;
  estimatedSeconds: number;
  measuredTasks: number;
  defaultTasks: number;
  limited: boolean;
}
export interface LearningWeekSummary {
  from: string;
  to: string;
  timeZone: string;
  targetMinutes: number;
  targetSource: 'explicit' | 'daily_budgets' | 'none';
  elapsedSeconds: number;
  remainingSeconds: number;
  percent: number;
  timedSessions: number;
  missingTimeSessions: number;
  inProgressSeconds: number;
  daily: Array<{ date: string; targetMinutes: number; elapsedSeconds: number }>;
  note: string;
}
