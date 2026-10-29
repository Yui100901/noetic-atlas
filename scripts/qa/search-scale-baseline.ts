/** Fixed pre-optimization implementation, for synthetic before/after comparisons only. */
import type { SearchItem, SearchResponse, SearchType } from '../../shared/models/search.js';
import { SEARCH_TYPES } from '../../shared/models/search.js';
import type { Store } from '../../server/core/store.js';
import { normalizeSearch } from '../../server/database/search-projections.js';
import type { SearchQuery } from '../../server/modules/search/schema.js';

interface Metadata { id: string; title: string; href: string; description: string; status?: string; categoryIds?: string[]; domainIds?: string[]; questionId?: string; partId?: string; updatedAt?: string }
const scope: SearchResponse['scope'] = { pdf: 'metadata', answers: 'match_only', notes: true, excluded: ['archived', 'draft_edits', 'attempt_answers', 'ai_configuration', 'attachment_bytes'] };

/** Match only the compact, disposable index; full source JSON stays out of
 * steady-state search. One materialized match set serves counts and the page. */
export function baselineUnifiedSearch(store: Store, input: SearchQuery): SearchResponse {
  const query = input.q.normalize('NFKC').trim().replace(/\s+/gu, ' '), normalized = normalizeSearch(query);
  const counts = Object.fromEntries(SEARCH_TYPES.map(type => [type, 0])) as Record<SearchType, number>;
  const response: SearchResponse = { query, type: input.type, sort: input.sort, includeUnpublished: input.includeUnpublished === 'true', page: input.page, pageSize: input.pageSize, total: 0, totalAll: 0, counts, items: [], scope: { ...scope, excluded: [...scope.excluded] } };
  if (!normalized) return response;
  const d = store.database, x = d.expressions, tokens = [...new Set(normalized.split(' '))];
  d.projections.search.ensure();
  const status = response.includeUnpublished ? ['published', 'pending', 'draft'] : ['published'];
  const match = d.query.selectFrom('search_read_model as s').select(['s.key', 's.kind', 's.entity_id', 's.data', 's.title_key', 's.id_key', 's.updated_at'])
    .where('s.archived', '=', 0).where('s.status', 'in', status)
    .where(eb => eb.and(tokens.map(token => x.containsLiteral(eb.ref('s.search_text'), token))))
    .select(eb => eb.case().when('s.id_key', '=', normalized).then(0).when('s.title_key', '=', normalized).then(1)
      .when(x.startsWithLiteral(eb.ref('s.id_key'), normalized)).then(2)
      .when(x.startsWithLiteral(eb.ref('s.title_key'), normalized)).then(3)
      .when(x.containsLiteral(eb.ref('s.title_key'), normalized)).then(4)
      .when(eb.and(tokens.map(token => eb.or([x.containsLiteral(eb.ref('s.id_key'), token), x.containsLiteral(eb.ref('s.title_key'), token), x.containsLiteral(eb.ref('s.content_key'), token)])))).then(5).else(6).end().as('rank'));
  const withMatches = d.query.with(cte => cte('matches').materialized(), () => match);
  const rows = d.all(withMatches
    .with(cte => cte('counts').materialized(), eb => eb.selectFrom('matches').select('kind').select(e => e.fn.countAll<number>().as('count')).groupBy('kind'))
    .with(cte => cte('chosen').materialized(), eb => {
      let chosen = eb.selectFrom('matches').selectAll();
      if (input.type !== 'all') chosen = chosen.where('kind', '=', input.type);
      chosen = input.sort === 'updatedAt' ? chosen.orderBy('updated_at', 'desc').orderBy('rank', 'asc') : chosen.orderBy('rank', 'asc').orderBy('updated_at', 'desc');
      return chosen.orderBy('key', 'asc').limit(input.pageSize).offset((input.page - 1) * input.pageSize);
    })
    .selectFrom('counts').leftJoin('chosen', join => join.onTrue()).leftJoin('search_read_model as original', 'original.key', 'chosen.key')
    .select(['counts.kind as countKind', 'counts.count', 'chosen.key', 'chosen.kind', 'chosen.entity_id', 'chosen.data', 'chosen.id_key', 'chosen.title_key', 'chosen.rank', 'chosen.updated_at'])
    .select(eb => x.searchExcerpt(eb.ref('original.content'), eb.ref('original.content_key'), tokens[0]).as('excerpt'))
    .orderBy(input.sort === 'updatedAt' ? 'chosen.updated_at' : 'chosen.rank', input.sort === 'updatedAt' ? 'desc' : 'asc')
    .orderBy(input.sort === 'updatedAt' ? 'chosen.rank' : 'chosen.updated_at', input.sort === 'updatedAt' ? 'asc' : 'desc').orderBy('chosen.key', 'asc'));
  const found = new Map<string, SearchItem>(), categoryIds = new Set<string>();
  for (const row of rows) {
    counts[row.countKind as SearchType] = Number(row.count);
    if (!row.key || !row.data || !row.kind) continue;
    const data = JSON.parse(row.data) as Metadata;
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
    const data = JSON.parse(rows.find(row => row.key === item.key)!.data!) as Metadata;
    item.domainIds = [...new Set([...item.domainIds, ...(data.categoryIds || []).flatMap(id => domains.has(id) ? [domains.get(id)!] : [])])];
  }
  response.totalAll = Object.values(counts).reduce((total, value) => total + value, 0);
  response.total = input.type === 'all' ? response.totalAll : counts[input.type];
  response.items = [...found.values()];
  return response;
}

