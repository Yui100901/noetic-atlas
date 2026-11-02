import { z } from 'zod';
import { CLEANUP_KINDS } from '../../../shared/models/maintenance.js';
import { cleanupSelectionSchema } from './cleanup.js';
import { resetSelectionSchema } from './reset-plan.js';

const count = z.number().int().nonnegative(),
  stamp = z.string().datetime({ offset: true }),
  fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const storage = z.object({
  databaseBytes: count,
  freeBytes: count,
  pageSize: count,
  integrity: z.array(z.string()).optional(),
});
export const healthOutputSchema = z.object({
  checkedAt: stamp,
  storage,
  counts: z.record(z.string(), count),
  unusedAssets: count,
  unusedAssetBytes: count,
  activeAiJobs: count,
  issues: z.array(
    z.object({
      level: z.enum(['warning', 'info']),
      message: z.string(),
      href: z.string().optional(),
    }),
  ),
  operations: z
    .array(
      z.object({
        at: stamp,
        kind: z.enum(['cleanup', 'reset', 'compact', 'reindex']),
        summary: z.string(),
        count,
      }),
    )
    .max(20),
});
export const cleanupOutputSchema = z.object({
  fingerprint,
  selection: cleanupSelectionSchema,
  cutoff: stamp,
  total: count,
  logicalBytes: count,
  protectedAiRuns: count,
  items: z.array(
    z.object({
      kind: z.enum(CLEANUP_KINDS),
      count,
      bytes: count,
      samples: z.array(z.object({ id: z.string(), title: z.string(), date: stamp })).max(8),
    }),
  ),
});
export const resetOutputSchema = z.object({
  fingerprint,
  selection: resetSelectionSchema,
  title: z.string(),
  counts: z.object({
    states: count,
    partStates: count,
    reviews: count,
    results: count,
    reviewCards: count,
    reviewEvents: count,
    questionHistory: count,
    focusSessions: count,
    planProgress: count,
  }),
  retained: z.object({
    attempts: count,
    drafts: count,
    sharedState: z.boolean(),
    mixedFocus: count,
  }),
  removed: z.object({
    attempts: count,
    drafts: count,
    questionHistory: count,
    study: count,
    aiGrades: count,
  }),
});
export const compactOutputSchema = z.object({
  ok: z.literal(true),
  before: storage,
  after: storage,
});
