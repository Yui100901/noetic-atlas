import { z } from 'zod';
import { id, types } from '../../core/validation.js';
import { paginationFields } from '../../core/pagination.js';
import { searchQuerySchema } from '../search/schema.js';

export const similarQuestionsQuerySchema = z.object({
  partId: id.optional(), q: searchQuerySchema.shape.q,
  page: paginationFields.page.default(1), pageSize: paginationFields.pageSize.default(20),
}).strict();
export const aiSimilarQuestionsInputSchema = z.object({
  questionId: id, partId: id.optional(), q: searchQuerySchema.shape.q, requirements: z.string().trim().max(2000).default(''), confirmed: z.literal(true),
}).strict();
export const aiSimilarQuestionsOutputSchema = z.object({
  items: z.array(z.object({ questionId: id, reason: z.string().trim().min(1).max(1500) }).strict()).max(20),
}).strict();
export const aiSimilarQuestionsResultSchema = aiSimilarQuestionsOutputSchema.extend({
  candidates: z.array(z.object({ id, title: z.string().min(1).max(300), type: types }).strict()).max(40),
  scope: z.string().min(1).max(1000),
}).strict();
export type SimilarQuestionsQuery = z.infer<typeof similarQuestionsQuerySchema>;
export type AiSimilarQuestionsInput = z.infer<typeof aiSimilarQuestionsInputSchema>;
