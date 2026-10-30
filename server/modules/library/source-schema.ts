import { z } from 'zod';
import { documentVersionIdSchema, id } from '../../core/validation.js';
import { paginationFields } from '../../core/pagination.js';

export const documentVersionSchema = z
  .object({
    id: documentVersionIdSchema,
    documentId: id,
    versionId: documentVersionIdSchema,
    title: z.string().trim().min(1).max(300),
    format: z.enum(['markdown', 'pdf']),
    bodyMarkdown: z.string().max(50 * 1024 * 1024),
    assetId: id.nullable(),
    fileName: z.string().max(300).nullable(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export const documentSourceParamsSchema = z
  .object({ id, versionId: documentVersionIdSchema })
  .strict();
export const relatedQuestionsQuerySchema = z
  .object({
    ...paginationFields,
    versionId: documentVersionIdSchema.optional(),
    search: z.string().trim().max(500).default(''),
    pageNumber: z.coerce.number().int().min(1).max(100000).optional(),
  })
  .strict();
