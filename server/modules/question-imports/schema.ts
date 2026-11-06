import { z } from 'zod';
import { id } from '../../core/validation.js';
export const importDedupDecisionSchema = z
  .object({
    key: z.string().regex(/^i-\d+$/),
    action: z.enum(['replace', 'keep', 'both']),
    targetId: id.optional(),
  })
  .strict();
export const importDedupOptionsSchema = z
  .object({
    enabled: z.boolean().optional(),
    expectedFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    decisions: z.array(importDedupDecisionSchema).max(50000).optional(),
  })
  .strict();
export const importDedupPreviewSchema = z
  .object({
    enabled: z.boolean().optional(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    total: z.number().int().nonnegative(),
    counts: z
      .object({
        new: z.number().int().nonnegative(),
        exact: z.number().int().nonnegative(),
        similar: z.number().int().nonnegative(),
      })
      .strict(),
    items: z.array(
      z
        .object({
          key: z.string(),
          index: z.number().int().nonnegative(),
          title: z.string(),
          type: z.string(),
          kind: z.enum(['new', 'exact', 'similar']),
          targetId: z.string().optional(),
          duplicateOf: z.string().optional(),
          candidates: z
            .array(
              z
                .object({
                  id: z.string(),
                  title: z.string(),
                  type: z.string(),
                  status: z.enum(['published', 'pending', 'draft', 'archived']),
                  score: z.number(),
                  reason: z.string(),
                  incomingIndex: z.number().int().nonnegative().optional(),
                })
                .strict(),
            )
            .max(5),
        })
        .strict(),
    ),
    metrics: z
      .object({
        indexed: z.number().int().nonnegative(),
        compared: z.number().int().nonnegative(),
        candidateLimit: z.number().int().positive(),
        hashesReused: z.number().int().nonnegative().optional(),
        hashesComputed: z.number().int().nonnegative().optional(),
      })
      .strict(),
  })
  .strict();
