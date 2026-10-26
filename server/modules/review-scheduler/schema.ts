import { z } from 'zod';
import { id, leafId } from '../../core/validation.js';
import { paginationFields } from '../../core/pagination.js';
import { REVIEW_DIRECTIONS, REVIEW_RATINGS } from '../../../shared/models/adaptive-review.js';
import { reviewSchedulingSettingsSchema } from '../settings/review-scheduling.js';

const stamp = z.string().datetime({ offset: true });
const key = z.string().min(1).max(1600);
export const ratingSchema = z.enum(REVIEW_RATINGS);
export const directionSchema = z.enum(REVIEW_DIRECTIONS);
export const memorySchema = z.object({
  due: stamp, stability: z.number().finite().nonnegative(), difficulty: z.number().finite().min(0).max(10),
  elapsed_days: z.number().finite().nonnegative(), scheduled_days: z.number().finite().nonnegative(),
  learning_steps: z.number().int().nonnegative(), reps: z.number().int().nonnegative(), lapses: z.number().int().nonnegative(),
  state: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]), last_review: stamp.optional(),
}).strict();
const identity = { questionId: id, partId: id.optional(), direction: directionSchema };
export const reviewCardSchema = z.object({
  ...identity, id: key, algorithm: z.literal('FSRS-6'), libraryVersion: z.literal('5.4.2'),
  memory: memorySchema, baseline: memorySchema, dueAt: stamp.nullable(), lastReviewedAt: stamp.nullable(),
  legacyDueAt: stamp.nullable(), legacyLastReviewedAt: stamp.nullable(), suspended: z.boolean(), manualDueAt: stamp.nullable(),
  createdAt: stamp, updatedAt: stamp,
}).strict();
export const reviewEventSchema = z.object({
  ...identity, id: key, cardId: key, source: z.enum(['attempt', 'manual']), attemptId: id.optional(), leafId: leafId.optional(),
  rating: ratingSchema, ratingSource: z.enum(['automatic', 'manual']), occurredAt: stamp, recordedAt: stamp, updatedAt: stamp,
  parameters: reviewSchedulingSettingsSchema, algorithm: z.literal('FSRS-6'), libraryVersion: z.literal('5.4.2'),
  before: memorySchema, after: memorySchema,
}).strict();
export const cardQuerySchema = z.object({ questionId: id, partId: id.optional(), direction: directionSchema.optional(), attemptId: id.optional(), leafId: leafId.optional() }).strict();
export const manualReviewSchema = z.object({ questionId: id, partId: id.optional(), direction: directionSchema.optional(), rating: ratingSchema, requestId: id }).strict();
export const changeCardSchema = z.object({ questionId: id, partId: id.optional(), direction: directionSchema.optional(), suspended: z.boolean().optional(), dueAt: stamp.nullable().optional() }).strict().refine(value => value.suspended !== undefined || value.dueAt !== undefined, '请选择暂停状态或复习日期');
export const attemptRatingSchema = z.object({ leafId, rating: ratingSchema.nullable() }).strict();
export const queueQuerySchema = z.object({ page: paginationFields.page.default(1), pageSize: paginationFields.pageSize.default(20), domainId: id.optional(), categoryId: id.optional(), kind: z.enum(['all', 'overdue', 'relearning', 'today']).default('all'), direction: directionSchema.optional() }).strict();
