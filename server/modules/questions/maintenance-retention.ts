import type { Store } from '../../core/store.js';

/** Project small identities only; pruning never loads historical question bodies. */
function candidates(
  store: Store,
  table: 'question_drafts' | 'question_revisions',
  limit: number,
  preserveId?: string,
) {
  const d = store.database,
    x = d.expressions;
  let query = d.query
    .selectFrom(table)
    .select(['id', x.field<string | null>('data', 'questionId').as('questionId')]);
  if (preserveId) {
    const context = d.one(
      d.query
        .selectFrom(table)
        .select(x.field<string | null>('data', 'questionId').as('questionId'))
        .where('id', '=', preserveId),
    );
    if (context)
      query = context.questionId
        ? query.where(x.field('data', 'questionId'), '=', context.questionId)
        : query.where(x.field('data', 'questionId'), 'is', null);
  }
  const values = d.all(
    query
      .orderBy(x.field('data', table === 'question_drafts' ? 'updatedAt' : 'sequence'), 'desc')
      .orderBy('id', 'desc'),
  );
  const counts = new Map<string, number>(),
    result: string[] = [];
  if (preserveId) {
    const keep = values.find((row) => row.id === preserveId);
    if (keep) counts.set(keep.questionId ?? '', 1);
  }
  for (const row of values) {
    if (row.id === preserveId) continue;
    const key = row.questionId ?? '',
      count = counts.get(key) || 0;
    counts.set(key, count + 1);
    if (count >= limit) result.push(row.id);
  }
  return result;
}
export const questionDraftRetentionCandidates = (
  store: Store,
  limit: number,
  preserveId?: string,
) => candidates(store, 'question_drafts', limit, preserveId);
export const questionRevisionRetentionCandidates = (
  store: Store,
  limit: number,
  preserveId?: string,
) => candidates(store, 'question_revisions', limit, preserveId);
