import { z } from 'zod';
import { id, questionSchema } from '../../core/validation.js';
import { importDedupOptionsSchema } from '../question-imports/schema.js';

export const aiImportSelectionSchema = z
  .object({
    indexes: z
      .array(z.number().int().min(0).max(49))
      .min(1)
      .max(50)
      .refine((values) => new Set(values).size === values.length, '序号不能重复')
      .optional(),
    questions: z.array(questionSchema).min(1).max(50).optional(),
    categoryIds: z.array(id).max(100).optional(),
    tagIds: z.array(id).max(100).optional(),
    dedup: importDedupOptionsSchema.optional(),
  })
  .strict();
export const aiImportApplySchema = aiImportSelectionSchema.extend({ confirmed: z.literal(true) });
