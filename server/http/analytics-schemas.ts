import { z } from 'zod';
import type { AnalyticsMetrics, AnalyticsReport, WeeklyReport } from '../../shared/models/analytics.js';

const count = z.number().int().nonnegative();
const percentage = z.number().min(0).max(100).nullable();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const analyticsMetrics = z.object({
  sessions: count, answeredSessions: count, paperSessions: count, quickSessions: count,
  answers: count, uniqueItems: count, uniqueQuestions: count,
  correct: count, partial: count, incorrect: count, ungraded: count, omitted: count, unknown: count,
  graded: count, accuracy: percentage,
  elapsedSeconds: count, timedSessions: count, missingTimeSessions: count,
  reviewEvents: count, activeDays: count,
}) satisfies z.ZodType<AnalyticsMetrics>;

const breakdown = z.object({
  id: z.string(), label: z.string(), answers: count, uniqueItems: count,
  correct: count, partial: count, incorrect: count, ungraded: count, graded: count, accuracy: percentage,
});
const adaptiveRecall = { feedbackEvents: count, recallSuccesses: count, recallSuccessRate: percentage };
const adaptiveAnalytics = z.object({
  ...adaptiveRecall, uniqueCards: count,
  ratings: z.object({ again: count, hard: count, good: count, easy: count }),
  timing: z.object({ new: z.object(adaptiveRecall), early: z.object(adaptiveRecall), due: z.object(adaptiveRecall), overdue: z.object(adaptiveRecall), unknown: z.object(adaptiveRecall) }),
  queue: z.object({ asOf: z.string(), due: count, overdue: count, relearning: count, today: count, suspended: count }).nullable(),
  dueProcessing: z.object({ completedDueCycles: count, pendingDue: count.nullable(), rate: percentage, reason: z.string() }),
});

/** Documentation schemas are checked against the shared response contract.
 * They describe responses without installing a second runtime serializer. */
export const analyticsReportOutputSchema = z.object({
  range: z.object({ from: day, to: day, timeZone: z.string(), asOf: z.string(), partial: z.boolean() }),
  summary: analyticsMetrics,
  adaptive: adaptiveAnalytics.optional(),
  daily: z.array(z.object({ date: day, metrics: analyticsMetrics })),
  domains: z.array(breakdown), types: z.array(breakdown),
  recommendations: z.array(z.object({ id: z.string(), title: z.string(), description: z.string(), href: z.string() })),
  quality: z.object({
    unknownAnswerItems: count, missingTypeAnswers: count, missingDomainAnswers: count,
    missingDurationSessions: count, resetExcludedSessions: count, warnings: z.array(z.string()),
  }),
}) satisfies z.ZodType<AnalyticsReport>;

export const weeklyReportOutputSchema = z.object({
  weekStart: day, weekEnd: day, timeZone: z.string(), generatedAt: z.string(), isCurrentWeek: z.boolean(),
  current: analyticsReportOutputSchema,
  comparison: z.object({
    mode: z.enum(['matched_elapsed', 'full_week']), from: day, to: day, label: z.string(), summary: analyticsMetrics,
    adaptive: adaptiveAnalytics.optional(),
    deltas: z.object({ answers: z.number().int(), sessions: z.number().int(), elapsedSeconds: z.number().int(), activeDays: z.number().int(), accuracyPoints: z.number().min(-100).max(100).nullable() }),
  }),
}) satisfies z.ZodType<WeeklyReport>;
