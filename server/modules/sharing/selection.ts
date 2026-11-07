import type { LearningShareSelection, ShareSelection } from '../../../shared/models/sharing.js';
import type { Question } from '../../../shared/models/types.js';
import type { Store } from '../../core/store.js';
import { fail, parse } from '../../core/validation.js';
import { globalLearningShareSource } from '../practice/global-learning.js';
import { contextLearningShareSource } from '../practice/learning.js';
import { paperListPageQuery, paperListPageQuerySchema } from '../practice/paper-list.js';
import { queueQuerySchema } from '../review-scheduler/schema.js';
import { reviewQueue } from '../review-scheduler/service.js';
import { getSettings } from '../settings/service.js';
import { flattenQuestions } from '../questions/structure.js';

/** Resolve identities without loading snapshots. A filtered export selects all
 * matches, independently of the visible page, and refuses an oversized scope. */
export function selectedPaperIds(store: Store, selection: ShareSelection): string[] {
  if (selection.id) return [selection.id];
  if (selection.ids?.length) return selection.ids;
  const filters = { ...selection.filters };
  if (typeof filters.archived === 'boolean') filters.archived = String(filters.archived);
  const input = parse(paperListPageQuerySchema.omit({ page: true, pageSize: true }), filters);
  store.database.projections.ensure(['papers']);
  const ids = store.database
    .all(paperListPageQuery(store, input).clearSelect().select('p.id').limit(101))
    .map((row) => row.id);
  if (ids.length > 100)
    fail(422, 'SHARE_PAPER_LIMIT', '一次最多分享100份题集，请按标题或领域缩小范围，或分批选择。');
  if (!ids.length) fail(422, 'EMPTY_SHARE', '当前筛选没有可分享的题集');
  return ids;
}

export function learningShareSource(
  store: Store,
  selection: LearningShareSelection,
  filters: Record<string, unknown> = {},
) {
  if (selection.source)
    return contextLearningShareSource(store, {
      source: selection.source,
      paperId: selection.paperId,
      kind: selection.kind,
    });
  if (selection.kind !== 'due' || getSettings(store).reviewScheduling.strategy !== 'fsrs')
    return globalLearningShareSource(store, selection.kind);
  const queueFilters = parse(
    queueQuerySchema.omit({ page: true, pageSize: true }),
    Object.fromEntries(
      Object.entries(filters).filter(
        ([, value]) => value !== '' && value !== undefined && value !== null,
      ),
    ),
  );
  const queue = reviewQueue(store, { ...queueFilters, page: 1, pageSize: 1_500_000 });
  const unique = new Map(
    queue.items.map((item) => [JSON.stringify([item.questionId, item.partId || null]), item]),
  );
  const items = [...unique.values()].map((item) => ({
    id: item.questionId + (item.partId ? `::${item.partId}` : ''),
    sourceId: item.questionId,
    attemptId: undefined,
  }));
  return {
    title: '待复习',
    items,
    paperIds: [] as string[],
    load: () => {
      const db = store.database,
        roots = [...new Set(items.map((item) => item.sourceId))];
      const questions = new Map(
        db
          .all(
            db.query
              .selectFrom('questions')
              .select('data')
              .where(db.expressions.idInJson('id', roots)),
          )
          .map((row) => {
            const q = JSON.parse(row.data) as Question;
            return [q.id, q] as const;
          }),
      );
      return items.map((item) =>
        flattenQuestions([questions.get(item.sourceId)!]).find((q) => q.id === item.id)!,
      );
    },
  };
}
