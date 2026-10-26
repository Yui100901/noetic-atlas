import { z } from 'zod';
import { DEFAULT_REVIEW_SCHEDULING } from '../../../shared/models/settings.js';

const steps = z.array(z.number().int().min(1).max(1440)).min(1).max(10);
export const reviewSchedulingSettingsSchema = z.object({
  strategy: z.enum(['fsrs', 'fixed']).default('fsrs'),
  desiredRetention: z.number().finite().min(0.7).max(0.99).default(0.9),
  maximumIntervalDays: z.number().int().min(1).max(36500).default(36500),
  learningStepsMinutes: steps.default([1, 10]), relearningStepsMinutes: steps.default([10]),
  enableFuzz: z.boolean().default(false), autoRateObjective: z.boolean().default(true), reduceNewWhenOverdue: z.boolean().default(true),
}).strict().default(() => structuredClone(DEFAULT_REVIEW_SCHEDULING));
