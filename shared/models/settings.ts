import type { QuestionType } from './types.js';

export interface SystemSettings {
  id: 'system';
  updatedAt: string;
  maxDraftsPerPaper: number;
  maxQuickDrafts: number;
  maxPaperDrafts: number;
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
  autosaveDebounceMs: number;
  maxDocumentMiB: number;
  maxImageMiB: number;
}

export const DEFAULT_SETTINGS: SystemSettings = {
  id: 'system', updatedAt: '1970-01-01T00:00:00.000Z',
  maxDraftsPerPaper: 3, maxQuickDrafts: 3,
  maxPaperDrafts: 3, examDurationMinutes: 120,
  maxHistoryPerPaper: 0, maxQuickHistory: 0, maxQuestionHistory: 10,
  randomQuestionCount: 20, scoringEnabledByDefault: false,
  randomTotalPoints: 100, objectivePercent: 60,
  pointsByType: { short_answer: 3, true_false: 1, single_choice: 2, multiple_choice: 2, fill_blank: 2, essay: 10, group: 6 },
  reviewIntervalsDays: [1, 2, 7, 21], autosaveDebounceMs: 1000,
  maxDocumentMiB: 20, maxImageMiB: 5,
};

export interface RetentionPreview { drafts: number; history: number; total: number; authoring?: number; questionHistory?: number }
