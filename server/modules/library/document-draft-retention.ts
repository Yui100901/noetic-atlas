import type { Store } from '../../core/store.js';

/** Read headers only; large draft text need not be decoded to enforce a cap. */
export function documentDraftRetentionCandidates(store: Store, maximum: number, preserveId?: string) {
  const database = store.database, field = database.expressions.field.bind(database.expressions);
  const rows = database.all(database.query.selectFrom('document_drafts').select('id').select([
    field<string | null>('data', 'documentId').as('documentId'),
    field<string>('data', 'updatedAt').as('updatedAt'),
  ]));
  const groups = new Map<string | null, typeof rows>();
  for (const row of rows) { const group = groups.get(row.documentId) || []; group.push(row); groups.set(row.documentId, group); }
  return [...groups.values()].flatMap(group => {
    group.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
    const kept = group.find(value => value.id === preserveId);
    return (kept ? [kept, ...group.filter(value => value.id !== preserveId)] : group).slice(maximum).map(value => value.id);
  });
}
