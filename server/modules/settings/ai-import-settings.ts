import { z } from 'zod';
import {
  AI_IMPORT_HARD_LIMITS,
  DEFAULT_AI_IMPORT_LIMITS,
} from '../../../shared/ai/import-limits.js';

export const aiImportSettingsSchema = z
  .object({
    fileMiB: z
      .number()
      .int()
      .min(1)
      .max(AI_IMPORT_HARD_LIMITS.fileMiB)
      .default(DEFAULT_AI_IMPORT_LIMITS.fileMiB),
    totalMiB: z
      .number()
      .int()
      .min(1)
      .max(AI_IMPORT_HARD_LIMITS.totalMiB)
      .default(DEFAULT_AI_IMPORT_LIMITS.totalMiB),
    files: z
      .number()
      .int()
      .min(1)
      .max(AI_IMPORT_HARD_LIMITS.files)
      .default(DEFAULT_AI_IMPORT_LIMITS.files),
    pdfPages: z
      .number()
      .int()
      .min(1)
      .max(AI_IMPORT_HARD_LIMITS.pdfPages)
      .default(DEFAULT_AI_IMPORT_LIMITS.pdfPages),
    sourceCharacters: z
      .number()
      .int()
      .min(1000)
      .max(AI_IMPORT_HARD_LIMITS.sourceCharacters)
      .default(DEFAULT_AI_IMPORT_LIMITS.sourceCharacters),
    sourceMiB: z
      .number()
      .int()
      .min(1)
      .max(AI_IMPORT_HARD_LIMITS.sourceMiB)
      .default(DEFAULT_AI_IMPORT_LIMITS.sourceMiB),
    blocks: z
      .number()
      .int()
      .min(1)
      .max(AI_IMPORT_HARD_LIMITS.blocks)
      .default(DEFAULT_AI_IMPORT_LIMITS.blocks),
  })
  .strict()
  .refine((value) => value.totalMiB >= value.fileMiB, {
    path: ['totalMiB'],
    message: '材料总大小上限不能小于单文件上限',
  });
