import { z } from 'zod';
import { AI_RUN_KINDS } from '../../../shared/ai/ai.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const aiTokenUsageSchema = z
  .object({
    inputTokens: count.nullable(),
    outputTokens: count.nullable(),
    totalTokens: count.nullable(),
    cacheReadInputTokens: count.nullable(),
    cacheMissInputTokens: count.nullable(),
    cacheWriteInputTokens: count.nullable(),
    reasoningTokens: count.nullable(),
  })
  .strict();
export const aiUsageSummarySchema = aiTokenUsageSchema
  .extend({
    status: z.enum(['unknown', 'partial', 'complete']),
    calls: count,
    reportedCalls: count,
    completeCalls: count,
  })
  .strict()
  .superRefine((value, context) => {
    const issue = () => context.addIssue({ code: 'custom', message: 'AI用量覆盖范围不一致' });
    if (value.completeCalls > value.reportedCalls || value.reportedCalls > value.calls) issue();
    if (
      value.status === 'unknown' &&
      (value.reportedCalls ||
        value.completeCalls ||
        [
          'inputTokens',
          'outputTokens',
          'totalTokens',
          'cacheReadInputTokens',
          'cacheMissInputTokens',
          'cacheWriteInputTokens',
          'reasoningTokens',
        ].some((key) => value[key as keyof typeof value] !== null))
    )
      issue();
    if (
      value.status === 'complete' &&
      (!value.calls ||
        value.completeCalls !== value.calls ||
        value.inputTokens === null ||
        value.outputTokens === null ||
        value.totalTokens === null)
    )
      issue();
    if (value.status === 'partial' && !value.reportedCalls) issue();
  });

/** The same compact output contract can be used by API documentation without
 * loading or exposing AI result bodies. */
export const aiUsageStatisticsSchema = z
  .object({
    runs: count,
    failedRuns: count,
    cancelledRuns: count,
    unknownCallRuns: count,
    usage: aiUsageSummarySchema,
    groups: z.array(
      z
        .object({
          provider: z.string().max(300),
          model: z.string().max(200),
          kind: z.enum(AI_RUN_KINDS),
          runs: count,
          unknownCallRuns: count,
          usage: aiUsageSummarySchema,
        })
        .strict(),
    ),
  })
  .strict();
