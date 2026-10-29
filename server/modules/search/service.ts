import type { SearchItem, SearchResponse, SearchType } from '../../../shared/models/search.js';
import { SEARCH_TYPES } from '../../../shared/models/search.js';
import type { Store } from '../../core/store.js';
import { normalizeSearch } from '../../database/search-projections.js';
import type { SearchQuery } from './schema.js';

interface Metadata { id: string; title: string; href: string; description: string; status?: string; categoryIds?: string[]; domainIds?: string[]; questionId?: string; partId?: string; updatedAt?: string }
const scope: SearchResponse['scope'] = { pdf: 'metadata', answers: 'match_only', notes: true, excluded: ['archived', 'draft_edits', 'attempt_answers', 'ai_configuration', 'attachment_bytes'] };

/** Match only the compact, disposable index; full source JSON stays out of
 * steady-state search. One materialized match set serves counts and the page. */
export function unifiedSearch(store: Store, input: SearchQuery): SearchResponse {
  const query = input.q.normalize('NFKC').trim().replace(/\s+/gu, ' '), normalized = normalizeSearch(query);
  const counts = Object.fromEntries(SEARCH_TYPES.map(type => [type, 0])) as Record<SearchType, number>;
  const response: SearchResponse = { query, type: input.type, sort: input.sort, includeUnpublished: input.includeUnpublished === 'true', page: input.page, pageSize: input.pageSize, total: 0, totalAll: 0, counts, items: [], scope: { ...scope, excluded: [...scope.excluded] } };
  if (!normalized) return response;
  const d = store.database, x = d.expressions, tokens = [...new Set(normalized.split(' '))];
  d.projections.search.ensure();
  const status = response.includeUnpublished ? ['published', 'pending', 'draft'] : ['published'];
  // Counts need identities only. Carrying metadata and relevance through the
  // whole match set makes broad searches unnecessarily expensive.
  const match = d.query.selectFrom('search_read_model as s').select(['s.key', 's.kind'])
    .where('s.archived', '=', 0).where('s.status', 'in', status)
    .where(eb => eb.and(tokens.map(token => x.containsLiteral(eb.ref('s.search_text'), token))));
  const withMatches = d.query.with(cte => cte('matches').materialized(), () => match);
  const rows = d.all(withMatches
    .with(cte => cte('counts').materialized(), eb => eb.selectFrom('matches').select('kind').select(e => e.fn.countAll<number>().as('count')).groupBy('kind'))
    .with(cte => cte('chosen').materialized(), eb => {
      let chosen = eb.selectFrom('matches as m').innerJoin('search_read_model as s', 's.key', 'm.key')
        .select(['s.key', 's.updated_at'])
        .select(e => e.case().when('s.id_key', '=', normalized).then(0).when('s.title_key', '=', normalized).then(1)
          .when(x.startsWithLiteral(e.ref('s.id_key'), normalized)).then(2)
          .when(x.startsWithLiteral(e.ref('s.title_key'), normalized)).then(3)
          .when(x.containsLiteral(e.ref('s.title_key'), normalized)).then(4)
          .when(e.and(tokens.map(token => e.or([x.containsLiteral(e.ref('s.id_key'), token), x.containsLiteral(e.ref('s.title_key'), token), x.containsLiteral(e.ref('s.content_key'), token)])))).then(5).else(6).end().as('rank'));
      if (input.type !== 'all') chosen = chosen.where('m.kind', '=', input.type);
      chosen = input.sort === 'updatedAt' ? chosen.orderBy('updated_at', 'desc').orderBy('rank', 'asc') : chosen.orderBy('rank', 'asc').orderBy('updated_at', 'desc');
      return chosen.orderBy('s.key', 'asc').limit(input.pageSize).offset((input.page - 1) * input.pageSize);
    })
    // Counts and page records are separate rows. A cross join repeats each
    // excerpt and JSON record once per matching content type (up to seven).
    .selectFrom('counts').select(eb => [
      eb.ref('counts.kind').$castTo<string | null>().as('countKind'), 'counts.count', eb.val<string | null>(null).as('key'),
      eb.val<string | null>(null).as('kind'), eb.val<string | null>(null).as('entity_id'), eb.val<string | null>(null).as('data'),
      eb.val<number | null>(null).as('rank'), eb.val<string | null>(null).as('updated_at'), eb.val<string | null>(null).as('excerpt'),
    ])
    .unionAll(eb => eb.selectFrom('chosen').innerJoin('search_read_model as original', 'original.key', 'chosen.key')
      .select(e => [e.val<string | null>(null).as('countKind'), e.val<number>(0).as('count'),
        'chosen.key', 'original.kind', 'original.entity_id', 'original.data', 'chosen.rank', 'chosen.updated_at',
        x.searchExcerpt(e.ref('original.content'), e.ref('original.content_key'), tokens[0]).as('excerpt')]))
    .orderBy(input.sort === 'updatedAt' ? 'updated_at' : 'rank', input.sort === 'updatedAt' ? 'desc' : 'asc')
    .orderBy(input.sort === 'updatedAt' ? 'rank' : 'updated_at', input.sort === 'updatedAt' ? 'asc' : 'desc').orderBy('key', 'asc'));
  const found = new Map<string, SearchItem>(), categoryIds = new Set<string>(), itemCategories = new Map<string, string[]>();
  for (const row of rows) {
    if (row.countKind) counts[row.countKind as SearchType] = Number(row.count);
    if (!row.key || !row.data || !row.kind) continue;
    const data = JSON.parse(row.data) as Metadata;
    itemCategories.set(row.key, data.categoryIds || []);
    for (const id of data.categoryIds || []) categoryIds.add(id);
    const matchIn: SearchItem['matchIn'] = row.rank === 0 || row.rank === 2 ? 'id' : row.rank === 1 || row.rank === 3 || row.rank === 4 ? 'title' : row.rank === 6 ? 'reference' : 'content';
    found.set(row.key, { key: row.key, type: row.kind as SearchType, id: row.entity_id!, title: data.title, excerpt: row.excerpt || '', href: data.href,
      description: data.description, ...(data.status ? { status: data.status } : {}), domainIds: [...data.domainIds || []],
      ...(data.questionId ? { questionId: data.questionId } : {}), ...(data.partId ? { partId: data.partId } : {}), ...(data.updatedAt ? { updatedAt: data.updatedAt } : {}), matchIn });
  }
  // Resolve small page-local classification metadata against today's taxonomy.
  // Moving/renaming a category never leaves stale question-domain labels.
  const domains = new Map(categoryIds.size ? d.all(d.query.selectFrom('categories').select('id').select(x.field<string>('data', 'domainId').as('domainId')).where(x.idInJson('id', [...categoryIds]))).map(row => [row.id, row.domainId]) : []);
  for (const item of found.values()) {
    item.domainIds = [...new Set([...item.domainIds, ...itemCategories.get(item.key)!.flatMap(id => domains.has(id) ? [domains.get(id)!] : [])])];
  }
  response.totalAll = Object.values(counts).reduce((total, value) => total + value, 0);
  response.total = input.type === 'all' ? response.totalAll : counts[input.type];
  response.items = [...found.values()];
  return response;
}
