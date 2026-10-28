import { z } from 'zod';
import type { PaperListItem, PaperListPage, PaperMetadata } from '../../../shared/practice/paper-list.js';
import type { Store } from '../../core/store.js';
import { paginationFields } from '../../core/pagination.js';
import { fail, id } from '../../core/validation.js';
import { cleanLearningRecord } from '../../../shared/questions/learning-records.js';
import { paperView, type StoredPaper } from './service.js';

export const paperListPageQuerySchema = z.object({
  ...paginationFields,
  search: z.string().max(1000).optional(),
  organization: z.enum(['all', 'domain', 'other']).default('all'),
  domainId: id.optional(),
  archived: z.enum(['true', 'false']).default('false'),
}).strict();
export type PaperListPageQuery = z.infer<typeof paperListPageQuerySchema>;

/** The same order as the existing list: last update, then authoritative
 * insertion order. Database rebuilds cannot shuffle equal timestamps. */
export function paperListPageQuery(store: Store, input: PaperListPageQuery) {
  const db = store.database, field = db.expressions.field.bind(db.expressions);
  let query = db.query.selectFrom('paper_read_model as p').innerJoin('papers as original', 'original.id', 'p.id').select('p.data');
  if (input.archived !== 'true') query = query.where(db.expressions.booleanOrFalse(field('p.data', 'archived')), '=', 0);
  if (input.organization !== 'all') query = query.where(eb => eb.fn.coalesce(field<string>('p.data', 'organization'), eb.val('other')), '=', input.organization);
  if (input.domainId) query = query.where(field('p.data', 'domainId'), '=', input.domainId);
  if (input.search) query = query.where(db.expressions.unicodeContains(field<string>('p.data', 'title'), input.search.toLowerCase()));
  return query.orderBy(field('p.data', 'updatedAt'), 'desc').orderBy(db.expressions.rowOrder('original'), 'asc');
}

function listItem(row: { data: string }): PaperListItem {
  // Normalize only this page, preserving strict scoring validation even for
  // legacy or grouped snapshots. Never serialize its large maps to the client.
  const record = cleanLearningRecord('papers', JSON.parse(row.data)) as StoredPaper;
  const paper = paperView(record), scoring = paper.scoring;
  const description = (paper.description || '').slice(0, 1000).replace(/[\uD800-\uDBFF]$/, '');
  return {
    id: paper.id, title: paper.title, description, mode: paper.mode, questionCount: paper.questionCount ?? record.questionIds.length,
    practiceKind: paper.practiceKind, organization: paper.organization, domainId: paper.domainId,
    archived: !!paper.archived, version: paper.version, createdAt: paper.createdAt, updatedAt: paper.updatedAt,
    scoring: { enabled: scoring.enabled, scheme: scoring.scheme, totalPoints: scoring.totalPoints, objectivePoints: scoring.objectivePoints, subjectivePoints: scoring.subjectivePoints },
  };
}
export function paperListPage(store: Store, input: PaperListPageQuery): PaperListPage {
  const db = store.database; db.projections.ensure(['papers']);
  const query = paperListPageQuery(store, input), pageSize = input.pageSize ?? 20;
  const total = Number(db.one(query.clearSelect().clearOrderBy().select(eb => eb.fn.countAll<number>().as('count')))?.count ?? 0);
  const page = Math.min(input.page ?? 1, Math.max(1, Math.ceil(total / pageSize)));
  // Sort tiny IDs first. Carrying p.data through a deep OFFSET sorter would
  // copy even off-page question maps and compact snapshots into its temp rows.
  const ids = db.all(query.clearSelect().select('p.id').limit(pageSize).offset((page - 1) * pageSize)).map(row => row.id);
  const rows = ids.length ? db.all(db.query.selectFrom('paper_read_model').select(['id', 'data']).where(db.expressions.idInJson('id', ids))) : [];
  const byId = new Map(rows.map(row => [row.id, row]));
  const items = ids.map(paperId => listItem(byId.get(paperId)!));
  return { items, total, page, pageSize };
}

/** Existence checks should not expand snapshots or enumerate every paper. */
export function paperMetadata(store: Store, paperId: string): PaperMetadata {
  const db = store.database, field = db.expressions.field.bind(db.expressions); db.projections.ensure(['papers']);
  const row = db.one(db.query.selectFrom('paper_read_model').select('id').select([
    field<string>('data', 'title').as('title'), field<number>('data', 'version').as('version'), field<number | null>('data', 'archived').as('archived'),
  ]).where('id', '=', paperId));
  const value = row ?? fail(404, 'NOT_FOUND', '记录不存在');
  return { id: value.id, title: value.title, version: value.version, archived: !!value.archived };
}
