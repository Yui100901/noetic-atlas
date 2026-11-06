import type { FastifyInstance } from 'fastify';
import type { Store } from '../../core/store.js';
import { parse } from '../../core/validation.js';
import { aiHistoryQuerySchema, aiHistorySelection } from './history.js';
import { aiUsageSummarySchema } from './usage-schema.js';
import {
  addAiUsage,
  emptyAiUsage,
  type AiUsageSummary,
  type AiUsageStatistics,
} from '../../../shared/ai/usage.js';

/** Select aggregate metadata only. Large model result bodies never need to be
 * materialized just to count tokens; pagination does not limit the summary. */
export function aiUsageStatistics(
  store: Store,
  input: Parameters<typeof aiHistorySelection>[1],
): AiUsageStatistics {
  const db = store.database,
    x = db.expressions;
  const rows = db.all(
    aiHistorySelection(store, input).select([
      x.field<string>('data', 'kind').as('kind'),
      x.field<string>('data', 'model').as('model'),
      x.field<string>('data', 'status').as('status'),
      x.nestedField<string | null>('data', ['diagnostics', 'provider']).as('provider'),
      x.nestedField<string | null>('data', ['diagnostics', 'usage']).as('usage'),
      x.nestedField<number | null>('data', ['diagnostics', 'providerCalls']).as('calls'),
    ]),
  );
  const groups = new Map<string, AiUsageStatistics['groups'][number]>();
  const report: AiUsageStatistics = {
    runs: 0,
    failedRuns: 0,
    cancelledRuns: 0,
    unknownCallRuns: 0,
    usage: emptyAiUsage(),
    groups: [],
  };
  for (const row of rows) {
    const provider = row.provider || 'unknown',
      model = row.model || 'unknown',
      kind = row.kind;
    let usage: AiUsageSummary | undefined;
    try {
      const parsed = aiUsageSummarySchema.safeParse(
        typeof row.usage === 'string' ? JSON.parse(row.usage) : row.usage,
      );
      if (parsed.success) usage = parsed.data;
    } catch {
      /* Legacy or corrupt metadata is unknown, never a zero-token success. */
    }
    const unknownCallRun =
      !usage &&
      !(typeof row.calls === 'number' && Number.isSafeInteger(row.calls) && row.calls > 0);
    usage ||= { ...emptyAiUsage(), calls: unknownCallRun ? 0 : row.calls! };
    const key = JSON.stringify([provider, model, kind]);
    const group = groups.get(key) || {
      provider,
      model,
      kind,
      runs: 0,
      unknownCallRuns: 0,
      usage: emptyAiUsage(),
    };
    group.runs++;
    group.unknownCallRuns += Number(unknownCallRun);
    group.usage = addAiUsage(group.usage, usage);
    groups.set(key, group);
    report.runs++;
    report.unknownCallRuns += Number(unknownCallRun);
    report.failedRuns += Number(row.status === 'failed');
    report.cancelledRuns += Number(row.status === 'cancelled');
    report.usage = addAiUsage(report.usage, usage);
  }
  report.groups = [...groups.values()].sort(
    (a, b) => b.runs - a.runs || a.model.localeCompare(b.model) || a.kind.localeCompare(b.kind),
  );
  if (report.unknownCallRuns && report.usage.reportedCalls) report.usage.status = 'partial';
  for (const group of report.groups)
    if (group.unknownCallRuns && group.usage.reportedCalls) group.usage.status = 'partial';
  return report;
}
export function registerAiUsageRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/ai/usage', async (request) =>
    aiUsageStatistics(store, parse(aiHistoryQuerySchema, request.query)),
  );
}
