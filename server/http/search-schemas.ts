import { z } from 'zod';
import { SEARCH_TYPES, type SearchResponse } from '../../shared/models/search.js';

const count = z.number().int().nonnegative();
export const searchResponseOutputSchema = z.object({
  query: z.string(), type: z.enum(['all', ...SEARCH_TYPES]), sort: z.enum(['relevance', 'updatedAt']), includeUnpublished: z.boolean(),
  page: z.number().int().positive(), pageSize: z.number().int().positive(), total: count, totalAll: count,
  counts: z.record(z.enum(SEARCH_TYPES), count),
  items: z.array(z.object({
    key: z.string(), type: z.enum(SEARCH_TYPES), id: z.string(), title: z.string(), excerpt: z.string(), href: z.string(), description: z.string(),
    status: z.string().optional(), domainIds: z.array(z.string()), questionId: z.string().optional(), partId: z.string().optional(), updatedAt: z.string().optional(),
    matchIn: z.enum(['title', 'id', 'content', 'reference']),
  })),
  scope: z.object({ pdf: z.literal('metadata'), answers: z.literal('match_only'), notes: z.boolean(), excluded: z.array(z.string()) }),
}) satisfies z.ZodType<SearchResponse>;
