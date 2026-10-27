import { z } from 'zod';
import { AI_RUN_KINDS } from '../../../shared/ai/ai.js';

const date = z.string().datetime({ offset: true });
const safeName = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.:[\]-]+$/);
const bytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const status = z.number().int().min(100).max(599);
export const aiFinishReasonSchema = z.enum(['stop', 'length', 'content_filter', 'aborted', 'insufficient_system_resource', 'tool_calls', 'function_call', 'unknown']);
export const aiValidationIssueSchema = z.object({ path: safeName, rule: safeName, message: z.string().min(1).max(300) }).strict();
export const aiFailureSchema = z.object({
  code: z.string().min(1).max(100).regex(/^[A-Z][A-Z0-9_]+$/), message: z.string().min(1).max(1800), stage: safeName,
  retryable: z.boolean(), recommendation: z.string().min(1).max(1000), statusCode: status.optional(),
  jsonLocation: z.object({ offset: bytes.optional(), line: bytes.optional(), column: bytes.optional() }).strict().optional(),
  validationIssues: z.array(aiValidationIssueSchema).max(20).optional(),
}).strict();
export const aiProviderAttemptSchema = z.object({
  index: z.number().int().min(1), startedAt: date, finishedAt: date.optional(), durationMs: bytes.optional(),
  phase: safeName, inputBytes: bytes, outputBytes: bytes, httpStatus: status.optional(), finishReason: aiFinishReasonSchema.optional(),
  status: z.enum(['completed', 'failed']).optional(), code: z.string().max(100).regex(/^[A-Z][A-Z0-9_]+$/).optional(),
}).strict();
export const aiDiagnosticsSchema = z.object({
  startedAt: date, finishedAt: date, durationMs: bytes, stage: safeName, providerCalls: z.number().int().min(1),
  inputBytes: bytes, outputBytes: bytes, httpStatus: status.optional(), finishReason: aiFinishReasonSchema.optional(),
  attempts: z.array(aiProviderAttemptSchema).min(1).max(200),
}).strict();
const identity = z.string().min(1).max(322);
export const aiFailedRunSchema = z.object({
  id: identity, kind: z.enum(AI_RUN_KINDS),
  status: z.enum(['failed', 'cancelled']), createdAt: date, model: z.string().max(200), warnings: z.array(z.string().max(1000)).max(100),
  questionIds: z.array(identity).max(500), attemptId: identity.optional(), jobId: identity.optional(), batchId: identity.optional(), feedbackId: identity.optional(),
  failure: aiFailureSchema, diagnostics: aiDiagnosticsSchema,
  _context: z.object({ questionVersions: z.record(z.string(), z.string()), sourceByItem: z.record(z.string(), z.string()) }).strict().optional(),
}).strict();
