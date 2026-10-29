import { z } from 'zod';
import { id, types } from '../../core/validation.js';

export const questionQuerySchema = z
  .object({
    search: z.string().max(1000).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(30),
    domainId: id.optional(),
    categoryId: id.optional(),
    paperId: id.optional(),
    tagIds: z.string().max(10000).optional(),
    tagMode: z.enum(['all', 'any']).default('all'),
    type: types.optional(),
    difficulty: z.coerce.number().int().min(1).max(4).optional(),
    depth: z.coerce.number().int().min(1).max(4).optional(),
    frequency: z.coerce.number().int().min(0).max(3).optional(),
    collection: z.enum(['general', 'personal', 'all']).optional(),
    status: z.enum(['published', 'pending', 'draft', 'archived', 'all']).optional(),
    favorite: z.enum(['true', 'false', '1', '0']).optional(),
    due: z.enum(['true', 'false', '1', '0']).optional(),
    wrong: z.enum(['true', 'false', '1', '0']).optional(),
  })
  .strict();
