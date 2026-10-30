import type { SystemSettings } from '../../../shared/models/settings.js';
import type { Store } from '../../core/store.js';

/** Retention inspects indexed metadata, never deserializes question snapshots. */
export function focusSessionSignatures(
  store: Store,
  scope?: { paperId: string | null; status: 'in_progress' | 'submitted' },
) {
  const db = store.database,
    x = db.expressions;
  let query = db.query
    .selectFrom('focus_sessions')
    .select('id')
    .select([
      x.field<string | null>('data', 'paperId').as('paperId'),
      x.field<'in_progress' | 'submitted'>('data', 'status').as('status'),
      x.field<string>('data', 'updatedAt').as('updatedAt'),
      x.field<number>('data', 'revision').as('revision'),
    ]);
  if (scope)
    query = query
      .where(x.field('data', 'paperId'), scope.paperId ? '=' : 'is', scope.paperId)
      .where(x.field('data', 'status'), '=', scope.status);
  return db.all(query.orderBy('id'));
}

export function focusRetentionCandidates(
  store: Store,
  settings: SystemSettings,
  scope?: { paperId: string | null; status: 'in_progress' | 'submitted'; preserveId?: string },
) {
  const groups = new Map<string, ReturnType<typeof focusSessionSignatures>>();
  for (const row of focusSessionSignatures(store, scope)) {
    if (scope && (row.paperId !== scope.paperId || row.status !== scope.status)) continue;
    const key = JSON.stringify([row.paperId, row.status]),
      group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap((group) => {
    const first = group[0]!,
      draft = first.status === 'in_progress',
      limit = draft
        ? first.paperId
          ? settings.maxDraftsPerPaper
          : settings.maxQuickDrafts
        : first.paperId
          ? settings.maxHistoryPerPaper
          : settings.maxQuickHistory;
    if (!draft && !limit) return [];
    group.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
    const preserved = scope?.preserveId && group.find((row) => row.id === scope.preserveId);
    const sorted = preserved ? [preserved, ...group.filter((row) => row !== preserved)] : group;
    return sorted.slice(limit);
  });
}
