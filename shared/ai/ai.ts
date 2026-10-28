import type { QuestionInput } from '../models/types.js';
import type {AiQuestionEditResult} from './question-edit.js';

export interface AiSettings {
  enabled: boolean; baseUrl: string; model: string; hasKey: boolean;
  supportsImages: boolean; sendImages: boolean; timeoutSeconds: number; maxTokens: number; updatedAt: string;
}
export interface AiSettingsInput extends Omit<AiSettings, 'hasKey' | 'updatedAt'> { updatedAt?: string; key?: string; clearKey?: boolean }
export const AI_RUN_KINDS = ['explain', 'grade', 'import', 'review', 'paper_plan', 'document_plan', 'document_generate', 'connection_test', 'feedback_review', 'similar_questions', 'question_edit'] as const;
export type AiRunKind = typeof AI_RUN_KINDS[number];
export const AI_PAPER_MAX_QUESTIONS = 500;
export interface AiPaperPlanItem { questionId: string; reason: string }
export interface AiPaperPlanRetrieval { availableCount: number; matchedCount: number; reviewedCount: number; batches: number; interpreted: boolean; summary: string }
export interface AiPaperPlanResult { title: string; description: string; items: AiPaperPlanItem[]; requestedCount: number; candidateCount: number; candidates: { id: string; title: string; type: string }[]; retrieval?: AiPaperPlanRetrieval }
export interface AiExplanation { explanationMarkdown: string; followUpsMarkdown: string; pitfallsMarkdown: string }
export type AiGradeVerdict = 'correct' | 'partial' | 'incorrect';
export interface AiGradeItem { questionId: string; verdict: AiGradeVerdict; score: number | null; maxPoints: number | null; comment: string; strengths: string[]; improvements: string[]; requiresRegrade?: true }
export interface AiGradeResult { items: AiGradeItem[]; gradingRequirements?: string }
export const AI_GRADE_VERDICT_LABELS: Record<AiGradeVerdict, string> = { correct: '正确', partial: '部分正确', incorrect: '错误' };
export function aiScoreVerdict(score: number, maxPoints: number): AiGradeVerdict { return score === maxPoints ? 'correct' : score === 0 ? 'incorrect' : 'partial'; }
/** Old unscored suggestions contain no usable judgment. Keep them reviewable,
 * but require a new evaluation before they can change an attempt. */
export function normalizeAiGradeItem(item: Omit<AiGradeItem, 'verdict'> & { verdict?: AiGradeVerdict }): AiGradeItem {
  const canDerive = item.score != null && item.maxPoints != null && item.maxPoints > 0;
  return { ...item, verdict: item.verdict ?? (canDerive ? aiScoreVerdict(item.score!, item.maxPoints!) : 'partial'), ...(!item.verdict && !canDerive ? { requiresRegrade: true as const } : {}) };
}
export type AiImportMode = 'extract' | 'generate';
export interface AiImportSource { mode: AiImportMode; name: string; url?: string; requirements?: string }
export interface AiImportResult { questions: QuestionInput[]; taxonomySuggestions: { domains: string[]; categories: string[]; tags: string[] }; source?: AiImportSource }
export interface AiReviewItem { questionId: string; verdict: 'valid' | 'needs_changes' | 'uncertain'; issues: string[]; suggestedChanges?: QuestionInput }
export interface AiReviewResult { items: AiReviewItem[]; approvedIds: string[] }
export interface AiValidationIssue { path: string; rule: string; message: string }
export interface AiProviderAttempt {
  index: number; startedAt: string; finishedAt?: string; durationMs?: number;
  phase: string; inputBytes: number; outputBytes: number; httpStatus?: number; finishReason?: string;
  status?: 'completed' | 'failed'; code?: string;
}
export interface AiDiagnostics {
  startedAt: string; finishedAt: string; durationMs: number; stage: string; providerCalls: number;
  inputBytes: number; outputBytes: number; httpStatus?: number; finishReason?: string; attempts: AiProviderAttempt[];
}
export interface AiFailure {
  code: string; message: string; stage: string; retryable: boolean; recommendation: string; statusCode?: number;
  jsonLocation?: { offset?: number; line?: number; column?: number }; validationIssues?: AiValidationIssue[];
}
export interface AiRunBase {
  id: string; kind: AiRunKind; createdAt: string; model: string; warnings: string[];
  questionIds: string[]; attemptId?: string; appliedAt?: string; jobId?: string; batchId?: string; feedbackId?: string; diagnostics?: AiDiagnostics;
  appliedScores?: string[]; appendedNotes?: string[]; importedQuestionIds?: string[]; correctedQuestionIds?: string[]; createdPaperId?: string;
}
export type AiRun<Result = AiExplanation | AiGradeResult | AiImportResult | AiReviewResult | AiPaperPlanResult | AiQuestionEditResult> = AiRunBase & (
  | { status: 'completed'; result: Result; failure?: never }
  | { status: 'failed' | 'cancelled'; failure: AiFailure; diagnostics: AiDiagnostics; result?: never }
);
export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false, baseUrl: '', model: '', hasKey: false, supportsImages: false, sendImages: false,
  timeoutSeconds: 60, maxTokens: 16384, updatedAt: '1970-01-01T00:00:00.000Z',
};
