import { z } from 'zod';
export const exportPreflightSchema = z
  .object({
    allowed: z.boolean(),
    questionCount: z.number().int().nonnegative(),
    estimatedExpandedBytes: z.number().int().nonnegative(),
    estimatedZipBytes: z.number().int().nonnegative(),
    attachmentBytes: z.number().int().nonnegative(),
    estimatedFiles: z.number().int().nonnegative(),
    maxQuestions: z.number().int().positive(),
    estimateIsUpperBound: z.literal(true),
    reasons: z.array(z.string()),
    recommendations: z.array(z.object({ label: z.string(), href: z.string() }).strict()),
  })
  .strict();
