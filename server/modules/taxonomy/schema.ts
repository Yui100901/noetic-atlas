import { z } from 'zod';
import { id } from '../../core/validation.js';
import { paginationFields } from '../../core/pagination.js';

export const taxonomyQuerySchema = z
  .object({
    ...paginationFields,
    search: z.string().max(1000).optional(),
    domainId: id.optional(),
    parentId: id.optional(),
    kind: z.string().max(40).optional(),
  })
  .strict();
