import type { QuestionInput } from './types.js';

export type QuestionDraftForm = Omit<QuestionInput, 'id'>;
export interface QuestionDraftState {
  form: QuestionDraftForm;
  sources: string;
  reason: string;
}
export interface QuestionDraft {
  id: string;
  questionId: string | null;
  baseUpdatedAt: string | null;
  state: QuestionDraftState;
  createdAt: string;
  updatedAt: string;
}
export interface QuestionDraftSummary {
  id: string;
  questionId: string | null;
  baseUpdatedAt: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  conflict: boolean;
}
export interface QuestionDraftDetail extends QuestionDraft {
  conflict: boolean;
}
export type QuestionRevisionContent = Omit<QuestionInput, 'id' | 'status'>;
export type QuestionRevisionOrigin =
  'baseline' | 'manual' | 'restore' | 'pending_import' | 'ai_review';
export interface QuestionRevision {
  id: string;
  questionId: string;
  sequence: number;
  content: QuestionRevisionContent;
  origin: QuestionRevisionOrigin;
  reason: string;
  changedFields: string[];
  createdAt: string;
  sourceUpdatedAt: string;
  restoredFromId?: string;
}
export interface QuestionRevisionSummary extends Omit<QuestionRevision, 'content'> {
  title: string;
}
export interface QuestionFieldDifference {
  field: string;
  before: unknown;
  after: unknown;
}
export interface QuestionRevisionDetail extends QuestionRevision {
  title: string;
  diff: QuestionFieldDifference[];
}
export interface QuestionMaintenancePage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
