import type { AiDiagnostics, AiFailure } from '../ai/ai.js';
import type { LeafQuestionType, QuestionType, Option, QuestionPart, BlankSpec } from './types.js';

export const QUESTION_FEEDBACK_KINDS = ['answer', 'explanation', 'ambiguous', 'duplicate', 'outdated', 'missing_content', 'other'] as const;
export type QuestionFeedbackKind = typeof QUESTION_FEEDBACK_KINDS[number];
export const QUESTION_FEEDBACK_KIND_LABELS: Record<QuestionFeedbackKind, string> = { answer: '答案有误', explanation: '解析问题', ambiguous: '题意歧义', duplicate: '重复或冲突', outdated: '可能过时', missing_content: '缺少内容', other: '其他问题' };
export type QuestionFeedbackStatus = 'pending' | 'confirmed' | 'resolved' | 'dismissed';
export const QUESTION_FEEDBACK_STATUS_LABELS: Record<QuestionFeedbackStatus, string> = { pending: '待核查', confirmed: '已确认问题', resolved: '已解决', dismissed: '已忽略' };
export const QUESTION_FEEDBACK_VERDICT_LABELS = { valid: '反馈成立', invalid: '反馈不成立', uncertain: '暂不确定' };
export type QuestionFeedbackVerdict = keyof typeof QUESTION_FEEDBACK_VERDICT_LABELS;
export interface QuestionFeedbackInput { questionId: string; partId?: string; kind: QuestionFeedbackKind; description: string; expectedUpdatedAt?: string }
export interface QuestionFeedbackSummary { openCount: number; pendingCount: number; confirmedCount: number; partIds: string[]; wholeCount: number; partCounts: Record<string, number> }
export interface FeedbackCandidate {
  id: string; questionId: string; partId?: string; title: string; type: QuestionType | LeafQuestionType;
  stemMarkdown: string; answerMarkdown: string; explanationMarkdown: string; reason: string;
  options?: Option[]; correctAnswers?: string[]; blanks?:BlankSpec[]; parts?: QuestionPart[];
}
export interface FeedbackComparison { candidateId: string; questionId: string; partId?: string; relation: 'similar' | 'conflict' | 'supports' | 'unrelated'; reason: string }
export interface QuestionFeedbackReview {
  verdict: QuestionFeedbackVerdict; reason: string; suggestion: string; comparisons: FeedbackComparison[];
  runId: string; reviewedAt: string; sourceFingerprint: string; candidateCount: number;
}
export interface QuestionFeedback {
  id: string; questionId: string; partId?: string; questionTitle: string; kind: QuestionFeedbackKind; description: string;
  status: QuestionFeedbackStatus; baseUpdatedAt: string; contentFingerprint: string;
  createdAt: string; updatedAt: string; note: string;
  origin?: 'user'|'quality'; qualityIssueId?: string;
  review?: QuestionFeedbackReview; lastFailure?: { failedAt: string; failure: AiFailure; auditId?: string; diagnostics?: AiDiagnostics };
}
export interface QuestionFeedbackView extends QuestionFeedback { sourceAvailable: boolean; sourceChanged: boolean }
export interface FeedbackCandidates { feedbackId: string; sourceCurrent: boolean; sourceChanged: boolean; items: FeedbackCandidate[]; limit: number; scope: string }
export interface FeedbackReviewBatch {
  status: 'completed' | 'partial' | 'failed'; completed: number; failed: number;
  items: Array<{ id: string; status: 'completed' | 'failed'; feedback: QuestionFeedbackView; runId?: string; failure?: AiFailure }>;
}
