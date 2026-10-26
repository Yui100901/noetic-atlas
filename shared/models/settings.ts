import type { QuestionType } from './types.js';
import { DEFAULT_DAILY_PUSH, type DailyPushSettings } from './daily-push.js';

export const THEMES = ['green', 'dark', 'pink', 'sky', 'mint'] as const;
export type Theme = typeof THEMES[number];
export const THEME_LABELS: Record<Theme, string> = { green: '森林绿', dark: '暗色', pink: '淡粉色', sky: '天蓝色', mint: '薄荷绿' };

export interface ReviewSchedulingSettings {
  strategy: 'fsrs' | 'fixed';
  desiredRetention: number;
  maximumIntervalDays: number;
  learningStepsMinutes: number[];
  relearningStepsMinutes: number[];
  enableFuzz: boolean;
  autoRateObjective: boolean;
  reduceNewWhenOverdue: boolean;
}
export const DEFAULT_REVIEW_SCHEDULING: ReviewSchedulingSettings = {
  strategy: 'fsrs', desiredRetention: 0.9, maximumIntervalDays: 36500,
  learningStepsMinutes: [1, 10], relearningStepsMinutes: [10], enableFuzz: false,
  autoRateObjective: true, reduceNewWhenOverdue: true,
};

export interface SystemSettings {
  id: 'system';
  updatedAt: string;
  theme: Theme;
  maxDraftsPerPaper: number;
  maxQuickDrafts: number;
  maxPaperDrafts: number;
  maxDocumentDrafts: number;
  examDurationMinutes: number;
  /** Zero preserves all submitted attempts. */
  maxHistoryPerPaper: number;
  maxQuickHistory: number;
  /** Independent recent answered-question details; zero disables this view. */
  maxQuestionHistory: number;
  randomQuestionCount: number;
  scoringEnabledByDefault: boolean;
  randomTotalPoints: number;
  objectivePercent: number;
  pointsByType: Record<QuestionType, number>;
  reviewIntervalsDays: [number, number, number, number];
  reviewScheduling: ReviewSchedulingSettings;
  autosaveDebounceMs: number;
  maxDocumentMiB: number;
  maxImageMiB: number;
  dailyPush: DailyPushSettings;
}

export const DEFAULT_SETTINGS: SystemSettings = {
  id: 'system', updatedAt: '1970-01-01T00:00:00.000Z', theme: 'green',
  maxDraftsPerPaper: 3, maxQuickDrafts: 3,
  maxPaperDrafts: 3, maxDocumentDrafts: 3, examDurationMinutes: 120,
  maxHistoryPerPaper: 0, maxQuickHistory: 0, maxQuestionHistory: 10,
  randomQuestionCount: 20, scoringEnabledByDefault: false,
  randomTotalPoints: 100, objectivePercent: 60,
  pointsByType: { short_answer: 3, true_false: 1, single_choice: 2, multiple_choice: 4, fill_blank: 2, essay: 10, group: 6 },
  reviewIntervalsDays: [1, 2, 7, 21], autosaveDebounceMs: 1000,
  reviewScheduling: structuredClone(DEFAULT_REVIEW_SCHEDULING),
  maxDocumentMiB: 20, maxImageMiB: 5,
  dailyPush: { ...DEFAULT_DAILY_PUSH, categoryIds: [] },
};

export interface RetentionPreview { drafts: number; history: number; total: number; authoring?: number; questionHistory?: number; documentDrafts?: number }
