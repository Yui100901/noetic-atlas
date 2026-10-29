import { z } from 'zod';
import { AI_RUN_KINDS, type AiRunKind } from '../../../shared/ai/ai.js';
import { id, leafId, types } from '../../core/validation.js';
import { aiDiagnosticsSchema } from './audit-schema.js';
import {
  explanationSchema,
  gradeResultSchema,
  aiImportResultOutputSchema,
  reviewResultSchema,
  aiPaperPlanOutputSchema,
} from './schema.js';
import { aiDocumentPlanResultSchema, aiDocumentGenerateResultSchema } from './document-schema.js';
import { aiQuestionEditResultSchema } from './question-edit-schema.js';
import { questionFeedbackReviewSchema } from '../quality-feedback/schema.js';
import { aiSimilarQuestionsResultSchema } from '../questions/similar-schema.js';

const stamp = z.string().datetime({ offset: true });
const ids = z.array(id).refine((values) => new Set(values).size === values.length, '题号不能重复');
const leafIds = z
  .array(leafId)
  .refine((values) => new Set(values).size === values.length, '小题号不能重复');

/** Persisted application context, never provider input or a public API field. */
export const aiRunContextSchema = z
  .object({
    questionVersions: z.record(id, z.string()),
    sourceByItem: z.record(leafId, id),
    attemptVersion: z.string().optional(),
    candidateVersions: z.record(id, z.string()).optional(),
    partByItem: z
      .record(leafId, z.object({ partId: id, type: types.exclude(['group']) }).strict())
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const item of Object.keys(value.partByItem || {}))
      if (!value.sourceByItem[item])
        context.addIssue({ code: 'custom', message: '小题 AI 上下文缺少原题引用' });
  });
export type AiRunContext = z.infer<typeof aiRunContextSchema>;

export const storedAiPaperPlanResultSchema = aiPaperPlanOutputSchema
  .extend({
    requestedCount: z.number().int().positive(),
    candidateCount: z.number().int().nonnegative(),
    candidates: z.array(z.object({ id, title: z.string(), type: types }).strict()),
    retrieval: z
      .object({
        availableCount: z.number().int().nonnegative(),
        matchedCount: z.number().int().nonnegative(),
        reviewedCount: z.number().int().nonnegative(),
        batches: z.number().int().nonnegative(),
        interpreted: z.boolean(),
        summary: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Strict saved results. Provider coercion/repair belongs in the model adapters;
 * a new kind must explicitly register its durable contract here. */
export const completedAiResultSchemas = {
  explain: explanationSchema,
  grade: gradeResultSchema,
  import: aiImportResultOutputSchema,
  review: reviewResultSchema.extend({ approvedIds: ids }).strict(),
  paper_plan: storedAiPaperPlanResultSchema,
  document_plan: aiDocumentPlanResultSchema,
  document_generate: aiDocumentGenerateResultSchema,
  feedback_review: questionFeedbackReviewSchema,
  similar_questions: aiSimilarQuestionsResultSchema,
  question_edit: aiQuestionEditResultSchema,
} satisfies Record<Exclude<AiRunKind, 'connection_test'>, z.ZodType>;

export const completedAiRunMetadataSchema = z
  .object({
    id,
    kind: z.enum(AI_RUN_KINDS.filter((kind) => kind !== 'connection_test')),
    status: z.literal('completed'),
    createdAt: stamp,
    model: z.string().max(200),
    warnings: z.array(z.string()),
    questionIds: leafIds,
    attemptId: id.optional(),
    result: z.unknown(),
    _context: aiRunContextSchema,
    appliedAt: stamp.optional(),
    appliedScores: leafIds.optional(),
    appendedNotes: leafIds.optional(),
    importedQuestionIds: ids.optional(),
    correctedQuestionIds: ids.optional(),
    createdPaperId: id.optional(),
    diagnostics: aiDiagnosticsSchema.optional(),
    jobId: id.optional(),
    batchId: id.optional(),
    feedbackId: id.optional(),
  })
  .strict();

/** Shared by writes and full SQLite restore. A result valid for a different
 * kind must still fail; reference ownership checks remain in their services. */
export const storedCompletedAiRunSchema = completedAiRunMetadataSchema.superRefine(
  (run, context) => {
    const result = completedAiResultSchemas[run.kind].safeParse(run.result);
    if (!result.success)
      for (const issue of result.error.issues)
        context.addIssue({ ...issue, path: ['result', ...issue.path] });
  },
);
