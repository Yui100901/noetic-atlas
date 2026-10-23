import type { PaperFilters, QuestionType } from '../models/types.js';

/** An authoring draft is independent of an answer attempt or a saved paper. */
export interface PaperDraftState {
  title: string; description: string; mode: 'manual' | 'random';
  organization: 'domain' | 'other'; domainId: string;
  questionIds: string[]; filters: Record<string, unknown>; random: PaperFilters;
  count: number; enabled: boolean; total: number; objectivePercent: number;
  pointsByType: Record<QuestionType, number>; overrides: Record<string, number>; autoTotal: boolean;
}
export interface PaperDraft {
  id: string; context: string; createdAt: string; updatedAt: string; state: PaperDraftState;
}
