import { z } from 'zod';
import { AI_RUN_KINDS } from '../../../shared/ai/ai.js';
import type { Store } from '../../core/store.js';
import { id, leafId } from '../../core/validation.js';
import { paginationFields } from '../../core/pagination.js';

export const aiHistoryQuerySchema = z.object({ ...paginationFields, kind: z.enum(AI_RUN_KINDS).optional(), status: z.enum(['completed', 'failed', 'cancelled']).optional(), jobId: id.optional(), questionId: leafId.optional(), attemptId: id.optional() }).strict();

/** Filter/count/page before loading result bodies. Hundreds of textbook batches
 * must not deserialize every stored preview just to open one history page. */
export function aiHistoryPage<T>(store: Store, input: z.infer<typeof aiHistoryQuerySchema>, publicRun: (record: any) => T) {
  const database = store.database, expressions = database.expressions;
  let selection = database.query.selectFrom('ai_runs');
  for (const key of ['kind', 'status', 'jobId', 'attemptId'] as const) if (input[key]) selection = selection.where(expressions.field('data', key), '=', input[key]);
  if (input.questionId) selection = selection.where(expressions.arrayAny('data', 'questionIds', [input.questionId]));
  const paged = input.page !== undefined || input.pageSize !== undefined;
  const page = input.page || 1, pageSize = input.pageSize || 20;
  const total = paged ? Number(database.one(selection.select(eb => eb.fn.countAll<number>().as('count')))?.count || 0) : 0;
  let records = selection.select(expressions.jsonWithout('data', ['_context']).as('data')).orderBy(expressions.field('data', 'createdAt'), 'desc').orderBy('id');
  if (paged) records = records.limit(pageSize).offset((page - 1) * pageSize);
  const items = database.all(records).map(row => publicRun(JSON.parse(row.data)));
  return paged ? { items, total, page, pageSize } : items;
}
