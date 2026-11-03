import { z } from 'zod';
import type { Store } from '../../core/store.js';
import { fail, id, moneySchema } from '../../core/validation.js';
import type { Question } from '../../../shared/models/types.js';
import type { StoredPaper } from '../practice/service.js';
import { flattenQuestions } from '../questions/structure.js';
import { gradingRequirementsSchema, aiLeafIds } from './schema.js';

export const readingSourceSchema = z
  .object({
    questionId: id,
    partId: id.optional(),
    questionVersion: z.string(),
    paperId: id.optional(),
    paperVersion: z.number().int().positive().optional(),
  })
  .strict();
const sourceFields = {
  questionId: id,
  partId: id.optional(),
  paperId: id.optional(),
  paperVersion: z.number().int().positive().optional(),
};
export const explainInputSchema = z
  .object(sourceFields)
  .strict()
  .refine((v) => !!v.paperId === (v.paperVersion !== undefined), '题集来源需要同时指定ID和版本');
export const standaloneGradeInputSchema = z
  .object({
    ...sourceFields,
    answer: z.string().max(100_000),
    maxPoints: moneySchema
      .refine((v) => v >= 0.01 && v <= 1000, '每题分值须在0.01至1000之间')
      .optional(),
    gradingRequirements: gradingRequirementsSchema.optional(),
  })
  .strict()
  .refine((v) => !!v.paperId === (v.paperVersion !== undefined), '题集来源需要同时指定ID和版本');
export const gradeInputSchema = z.union([
  z
    .object({
      attemptId: id,
      questionIds: aiLeafIds.optional(),
      gradingRequirements: gradingRequirementsSchema.optional(),
    })
    .strict(),
  standaloneGradeInputSchema,
]);

/** Resolve trusted stored content, never accept arbitrary question bodies from
 * the browser. A set reader must analyse the same immutable snapshot it shows. */
export function resolveReadingSource(store: Store, input: z.infer<typeof explainInputSchema>) {
  const current = store.require<Question>('questions', input.questionId);
  let root = current;
  let gradingRequirements = '';
  if (input.paperId) {
    const paper = store.require<StoredPaper>('papers', input.paperId);
    if (paper.version !== input.paperVersion)
      fail(409, 'AI_PAPER_VERSION_CONFLICT', '题集内容已变化，请刷新题目后重新分析');
    gradingRequirements = paper.gradingRequirements || '';
    root =
      paper.snapshot.find((q) => q.id === input.questionId) ??
      fail(404, 'QUESTION_SET_MEMBER_NOT_FOUND', '该题目不属于此题集');
  }
  const question = input.partId
    ? flattenQuestions([root]).find((q) => q.partId === input.partId)
    : root;
  if (!question) fail(400, 'AI_PART_NOT_FOUND', '指定的小题不存在');
  return {
    current,
    gradingRequirements,
    question: question!,
    source: {
      questionId: input.questionId,
      questionVersion: current.updatedAt || current.createdAt || '',
      ...(input.partId ? { partId: input.partId } : {}),
      ...(input.paperId ? { paperId: input.paperId, paperVersion: input.paperVersion } : {}),
    },
  };
}
