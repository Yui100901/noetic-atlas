import type { QuestionInput } from '../models/types.js';

export interface AiSettings {
  enabled: boolean; baseUrl: string; model: string; hasKey: boolean;
  supportsImages: boolean; sendImages: boolean; timeoutSeconds: number; maxTokens: number; updatedAt: string;
}
export interface AiSettingsInput extends Omit<AiSettings, 'hasKey' | 'updatedAt'> { updatedAt?: string; key?: string; clearKey?: boolean }
export type AiRunKind = 'explain' | 'grade' | 'import' | 'review' | 'paper_plan';
export const AI_PAPER_MAX_QUESTIONS = 500;
export interface AiPaperPlanItem { questionId: string; reason: string }
export interface AiPaperPlanRetrieval { availableCount: number; matchedCount: number; reviewedCount: number; batches: number; interpreted: boolean; summary: string }
export interface AiPaperPlanResult { title: string; description: string; items: AiPaperPlanItem[]; requestedCount: number; candidateCount: number; candidates: { id: string; title: string; type: string }[]; retrieval?: AiPaperPlanRetrieval }
export interface AiExplanation { explanationMarkdown: string; followUpsMarkdown: string; pitfallsMarkdown: string }
export interface AiGradeItem { questionId: string; score: number | null; maxPoints: number | null; comment: string; strengths: string[]; improvements: string[] }
export interface AiGradeResult { items: AiGradeItem[] }
export interface AiImportResult { questions: QuestionInput[]; taxonomySuggestions: { domains: string[]; categories: string[]; tags: string[] } }
export interface AiReviewItem { questionId: string; verdict: 'valid' | 'needs_changes' | 'uncertain'; issues: string[]; suggestedChanges?: QuestionInput }
export interface AiReviewResult { items: AiReviewItem[]; approvedIds: string[] }
export interface AiRun<Result = AiExplanation | AiGradeResult | AiImportResult | AiReviewResult | AiPaperPlanResult> {
  id: string; kind: AiRunKind; status: 'completed'; createdAt: string; model: string; warnings: string[];
  questionIds: string[]; attemptId?: string; result: Result; appliedAt?: string;
  appliedScores?: string[]; appendedNotes?: string[]; importedQuestionIds?: string[]; correctedQuestionIds?: string[]; createdPaperId?: string;
}
export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false, baseUrl: '', model: '', hasKey: false, supportsImages: false, sendImages: false,
  timeoutSeconds: 60, maxTokens: 4096, updatedAt: '1970-01-01T00:00:00.000Z',
};
