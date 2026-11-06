/** Only supplier-reported counts are retained. Cache/reasoning fields are
 * breakdowns of input/output, never additional tokens to add to the total. */
export const AI_TOKEN_FIELDS = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadInputTokens',
  'cacheMissInputTokens',
  'cacheWriteInputTokens',
  'reasoningTokens',
] as const;
export type AiTokenField = (typeof AI_TOKEN_FIELDS)[number];
export type AiTokenUsage = Record<AiTokenField, number | null>;
export interface AiUsageSummary extends AiTokenUsage {
  status: 'unknown' | 'partial' | 'complete';
  calls: number;
  reportedCalls: number;
  completeCalls: number;
}
export interface AiUsageStatistics {
  runs: number;
  failedRuns: number;
  cancelledRuns: number;
  unknownCallRuns: number;
  usage: AiUsageSummary;
  groups: Array<{
    provider: string;
    model: string;
    kind: string;
    runs: number;
    unknownCallRuns: number;
    usage: AiUsageSummary;
  }>;
}
export const emptyTokenUsage = (): AiTokenUsage =>
  Object.fromEntries(AI_TOKEN_FIELDS.map((field) => [field, null])) as AiTokenUsage;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const count = (...values: unknown[]) =>
  values.find((value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) as
    number | undefined;
export function reportedTokenUsage(value: unknown): AiTokenUsage | undefined {
  const usage = object(value),
    input = object(usage.prompt_tokens_details || usage.input_tokens_details),
    output = object(usage.completion_tokens_details || usage.output_tokens_details);
  const result: AiTokenUsage = {
    inputTokens:
      count(usage.prompt_tokens, usage.input_tokens, usage.inputTokens, usage.promptTokenCount) ??
      null,
    outputTokens:
      count(
        usage.completion_tokens,
        usage.output_tokens,
        usage.outputTokens,
        usage.candidatesTokenCount,
      ) ?? null,
    totalTokens: count(usage.total_tokens, usage.totalTokens, usage.totalTokenCount) ?? null,
    cacheReadInputTokens:
      count(
        usage.prompt_cache_hit_tokens,
        usage.cache_read_input_tokens,
        input.cached_tokens,
        usage.cachedContentTokenCount,
      ) ?? null,
    cacheMissInputTokens: count(usage.prompt_cache_miss_tokens) ?? null,
    cacheWriteInputTokens:
      count(usage.cache_creation_input_tokens, input.cache_creation_tokens) ?? null,
    reasoningTokens:
      count(output.reasoning_tokens, usage.reasoning_tokens, usage.thoughtsTokenCount) ?? null,
  };
  return AI_TOKEN_FIELDS.some((field) => result[field] !== null) ? result : undefined;
}
export function mergeReportedUsage(
  previous: AiTokenUsage | undefined,
  next: AiTokenUsage,
): AiTokenUsage {
  const value = { ...(previous || emptyTokenUsage()) };
  for (const field of AI_TOKEN_FIELDS) if (next[field] !== null) value[field] = next[field];
  return value;
}
export function emptyAiUsage(): AiUsageSummary {
  return { ...emptyTokenUsage(), status: 'unknown', calls: 0, reportedCalls: 0, completeCalls: 0 };
}
export function addAiUsage(left: AiUsageSummary, right: AiUsageSummary): AiUsageSummary {
  const result = emptyAiUsage();
  for (const field of AI_TOKEN_FIELDS) {
    const values = [left[field], right[field]].filter((value): value is number => value !== null);
    const sum = values.reduce((value, item) => value + item, 0);
    result[field] = values.length && Number.isSafeInteger(sum) ? sum : null;
  }
  result.calls = left.calls + right.calls;
  result.reportedCalls = left.reportedCalls + right.reportedCalls;
  result.completeCalls = left.completeCalls + right.completeCalls;
  result.status = !result.reportedCalls
    ? 'unknown'
    : result.completeCalls === result.calls &&
        ['inputTokens', 'outputTokens', 'totalTokens'].every(
          (field) => result[field as AiTokenField] !== null,
        )
      ? 'complete'
      : 'partial';
  return result;
}
export function attemptAiUsage(usage: AiTokenUsage | undefined, final = false): AiUsageSummary {
  const result = { ...emptyAiUsage(), ...(usage || {}), calls: 1, reportedCalls: usage ? 1 : 0 };
  result.completeCalls =
    usage &&
    final &&
    usage.inputTokens !== null &&
    usage.outputTokens !== null &&
    usage.totalTokens !== null
      ? 1
      : 0;
  result.status = result.completeCalls ? 'complete' : result.reportedCalls ? 'partial' : 'unknown';
  return result;
}
