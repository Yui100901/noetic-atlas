import { z } from 'zod';
import type { Category } from '../../../shared/models/types.js';
import { paginationFields } from '../../core/pagination.js';
import type { Store } from '../../core/store.js';
import { id } from '../../core/validation.js';

export const documentListQuerySchema = z.object({
  ...paginationFields, search: z.string().max(1000).optional(),
  collection: z.enum(['general', 'personal', 'all']).optional(), kind: z.string().max(300).optional(),
  domainId: id.optional(), categoryId: id.optional(), tagIds: z.string().max(10000).optional(),
  format: z.enum(['markdown', 'pdf']).optional(),
}).strict();

/** Keep filtering in the query builder: books must never be downloaded to the
 * application just to decide which ten cards match a search. */
export function documentSelection(store: Store, input: z.infer<typeof documentListQuerySchema>, categories: Category[]) {
  const { query, expressions } = store.database;
  store.database.projections.ensure(['documents']);
  if (input.domainId) store.require('domains', input.domainId);
  const descendants = input.categoryId ? store.categoryDescendants(input.categoryId) : null;
  const tags = input.tagIds?.split(',').filter(Boolean) || [];
  for (const tag of tags) store.require('tags', tag);
  let selected = query.selectFrom('document_read_model as d').where(expressions.booleanOrFalse(expressions.field('d.data', '_archived')), '=', 0);
  if (input.collection && input.collection !== 'all') selected = selected.where(expressions.field('d.data', 'collection'), '=', input.collection);
  if (input.kind) selected = selected.where(expressions.field('d.data', 'kind'), '=', input.kind);
  if (input.format) selected = input.format === 'markdown' ? selected.where(eb => eb.or([
    eb(expressions.field('d.data', 'format'), '=', 'markdown'), eb(expressions.field('d.data', 'format'), 'is', null), eb(expressions.field('d.data', 'format'), '=', ''),
  ])) : selected.where(expressions.field('d.data', 'format'), '=', input.format);
  // Legacy documents may have categoryIds without explicit domainIds.
  if (input.domainId) selected = selected.where(eb => eb.or([
    expressions.arrayAny('d.data', 'domainIds', [input.domainId!]),
    expressions.arrayAny('d.data', 'categoryIds', categories.filter(category => category.domainId === input.domainId).map(category => category.id)),
  ]));
  if (descendants) selected = selected.where(expressions.arrayAny('d.data', 'categoryIds', [...descendants]));
  if (tags.length) selected = selected.where(expressions.arrayAll('d.data', 'tagIds', tags));
  const search = input.search?.trim().toLowerCase();
  if (search) selected = selected.where(eb => expressions.containsLiteral(eb.ref('d.search_text'), search));
  return selected;
}

export function orderedDocuments(selection: ReturnType<typeof documentSelection>, store: Store) {
  const { expressions } = store.database;
  return selection.orderBy(eb => eb.fn.coalesce(expressions.field('d.data', 'updatedAt'), eb.val('')), 'desc').orderBy('d.source_order', 'asc');
}
