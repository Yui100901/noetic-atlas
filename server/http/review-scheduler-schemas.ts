import { z } from 'zod';
import { directionSchema, ratingSchema, reviewCardSchema } from '../modules/review-scheduler/schema.js';
import type { AttemptReviewOverview, ReviewCardView, ReviewQueue } from '../../shared/models/adaptive-review.js';

const identity = { questionId: z.string(), partId: z.string().optional(), direction: directionSchema };
const count = z.number().int().nonnegative();
export const reviewCardViewOutputSchema = z.object({
  ...identity, strategy: z.enum(['fsrs', 'fixed']), card: reviewCardSchema.nullable(), dueAt: z.string().nullable(), lastReviewedAt: z.string().nullable(),
  suspended: z.boolean(), state: z.enum(['new', 'learning', 'review', 'relearning']), retrievability: z.number().min(0).max(1).nullable(),
  preview: z.array(z.object({ rating: ratingSchema, label: z.string(), dueAt: z.string(), intervalSeconds: count, scheduledDays: z.number().nonnegative() })),
  eventCount: count, latestRating: ratingSchema.nullable(), canReview: z.boolean(), reason: z.string().optional(),
}) satisfies z.ZodType<ReviewCardView>;
export const attemptReviewOutputSchema = z.object({
  attemptId: z.string(), strategy: z.enum(['fsrs', 'fixed']), items: z.array(z.object({
    ...identity, leafId: z.string(), eligible: z.boolean(), reason: z.string().optional(), eventId: z.string().optional(), rating: ratingSchema.optional(),
    ratingSource: z.enum(['automatic', 'manual']).optional(), card: reviewCardSchema.nullable(),
  })),
}) satisfies z.ZodType<AttemptReviewOverview>;
export const reviewQueueOutputSchema = z.object({
  page: z.number().int().positive(), pageSize: z.number().int().positive(), total: count,
  summary: z.object({ due: count, overdue: count, relearning: count, today: count, suspended: count }),
  items: z.array(z.object({ ...identity, key: z.string(), title: z.string(), partTitle: z.string().optional(), href: z.string(), card: reviewCardSchema.nullable(), dueAt: z.string(), reason: z.enum(['legacy', 'overdue', 'relearning', 'today']) })),
}) satisfies z.ZodType<ReviewQueue>;
