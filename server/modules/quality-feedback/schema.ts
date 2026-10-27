import { z } from 'zod';
import { QUESTION_FEEDBACK_KINDS } from '../../../shared/models/question-feedback.js';
import { id } from '../../core/validation.js';
import { aiFailureSchema, aiDiagnosticsSchema } from '../ai/audit-schema.js';

const date = z.string().datetime({ offset: true }), fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
export const feedbackStatusSchema = z.enum(['pending', 'confirmed', 'resolved', 'dismissed']);
export const questionFeedbackInputSchema = z.object({
  questionId: id, partId: id.optional(), kind: z.enum(QUESTION_FEEDBACK_KINDS), description: z.string().trim().min(1).max(5000), expectedUpdatedAt: date.optional(),
}).strict();
const comparisonSchema = z.object({ candidateId: z.string().min(1).max(40), questionId: id, partId: id.optional(), relation: z.enum(['similar', 'conflict', 'supports', 'unrelated']), reason: z.string().min(1).max(3000) }).strict();
export const questionFeedbackReviewSchema = z.object({
  verdict: z.enum(['valid', 'invalid', 'uncertain']), reason: z.string().min(1).max(8000), suggestion: z.string().max(5000), comparisons: z.array(comparisonSchema).max(8),
  runId: id, reviewedAt: date, sourceFingerprint: fingerprint, candidateCount: z.number().int().min(0).max(8),
}).strict();
export const questionFeedbackSchema = z.object({
  id, questionId: id, partId: id.optional(), questionTitle: z.string().min(1).max(300), kind: z.enum(QUESTION_FEEDBACK_KINDS), description: z.string().trim().min(1).max(5000),
  origin:z.enum(['user','quality']).optional(),qualityIssueId:id.optional(),status: feedbackStatusSchema, baseUpdatedAt: z.string().max(100), contentFingerprint: fingerprint, createdAt: date, updatedAt: date, note: z.string().max(5000),
  review: questionFeedbackReviewSchema.optional(),
  lastFailure: z.object({ failedAt: date, failure: aiFailureSchema, auditId: id.optional(), diagnostics: aiDiagnosticsSchema.optional() }).strict().optional(),
}).strict();
export const questionFeedbackResolveSchema = z.object({ status: feedbackStatusSchema, note: z.string().trim().max(5000).default(''), expectedUpdatedAt: date }).strict()
  .refine(value => !['resolved', 'dismissed'].includes(value.status) || !!value.note, '解决或忽略反馈时请填写处理说明');
export const questionFeedbackAiInputSchema = z.object({
  ids: z.array(id).min(1).max(20).refine(values => new Set(values).size === values.length, '反馈不能重复'), expectedUpdatedAt: z.record(id, date),
}).strict().refine(value => Object.keys(value.expectedUpdatedAt).length === value.ids.length && value.ids.every(key => !!value.expectedUpdatedAt[key]), '每条反馈必须提供且仅提供对应的updatedAt版本');
export const feedbackAiOutputSchema = z.object({
  verdict: z.enum(['valid', 'invalid', 'uncertain']), reason: z.string().trim().min(1).max(8000), suggestion: z.string().max(5000).default(''),
  comparisons: z.array(z.object({ candidateId: z.string().min(1).max(40), relation: z.enum(['similar', 'conflict', 'supports', 'unrelated']), reason: z.string().trim().min(1).max(3000) }).strict()).max(8).default([]),
}).strict();
