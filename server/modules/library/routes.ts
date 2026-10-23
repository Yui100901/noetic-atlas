import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Category, DocumentRecord } from '../../../shared/models/types.js';
import { documentDomainIds } from '../../../shared/models/library.js';
import { Store, makeId, nextStamp, now } from '../../core/store.js';
import { documentSchema, fail, id, parse } from '../../core/validation.js';
import { validateAssetReferences } from '../assets/routes.js';
import { getSettings } from '../settings/routes.js';
import { paginationFields } from '../../core/pagination.js';

export function normalizeDocument(store: Store, value: DocumentRecord, categories?: Category[]): DocumentRecord {
  return { ...value, format: value.format || 'markdown', assetId: value.assetId || null, fileName: value.fileName || null, domainIds: documentDomainIds(value, categories || store.all<Category>('categories')), author: value.author || '', publisher: value.publisher || '', publishedYear: value.publishedYear || '', description: value.description || '' };
}
function validateDocument(store: Store, document: DocumentRecord) {
  store.validateRefs(document);
  if (new TextEncoder().encode(document.bodyMarkdown).length > getSettings(store).maxDocumentMiB * 1024 * 1024) fail(413, 'DOCUMENT_TOO_LARGE', '资料内容超过系统配置允许的大小');
  validateAssetReferences(store, document, getSettings(store));
}
export function registerLibraryRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/documents', async request => {
    const query = parse(z.object({ ...paginationFields, search: z.string().max(1000).optional(), collection: z.enum(['general', 'personal', 'all']).optional(), kind: z.string().max(300).optional(), domainId: id.optional(), categoryId: id.optional(), tagIds: z.string().max(10000).optional(), format: z.enum(['markdown', 'pdf']).optional() }).strict(), request.query);
    const search = query.search?.trim().toLowerCase(); const descendants = query.categoryId ? store.categoryDescendants(query.categoryId) : null;
    if (query.domainId) store.require('domains', query.domainId); const tags = query.tagIds?.split(',').filter(Boolean) || []; for (const tag of tags) store.require('tags', tag);
    const database = store.database, expressions = database.expressions, categories = store.all<Category>('categories');
    let selection = database.query.selectFrom('documents as d').where(eb => eb.or([eb(expressions.field('d.data', '_archived'), 'is', null), eb(expressions.field('d.data', '_archived'), '=', 0)]));
    if (query.collection && query.collection !== 'all') selection = selection.where(expressions.field('d.data', 'collection'), '=', query.collection);
    if (query.kind) selection = selection.where(expressions.field('d.data', 'kind'), '=', query.kind);
    if (query.format) selection = query.format === 'markdown' ? selection.where(eb => eb.or([eb(expressions.field('d.data', 'format'), '=', 'markdown'), eb(expressions.field('d.data', 'format'), 'is', null), eb(expressions.field('d.data', 'format'), '=', '')])) : selection.where(expressions.field('d.data', 'format'), '=', query.format);
    if (query.domainId) {
      // Old documents may have only categoryIds. Subject filters must retain
      // the same explicit + inferred domain union as normalizeDocument.
      selection = selection.where(eb => eb.or([expressions.arrayAny('d.data', 'domainIds', [query.domainId!]), expressions.arrayAny('d.data', 'categoryIds', categories.filter(category => category.domainId === query.domainId).map(category => category.id))]));
    }
    if (descendants) selection = selection.where(expressions.arrayAny('d.data', 'categoryIds', [...descendants]));
    if (tags.length) selection = selection.where(expressions.arrayAll('d.data', 'tagIds', tags));
    const ordered = selection.orderBy(eb => eb.fn.coalesce(expressions.field('d.data', 'updatedAt'), eb.val('')), 'desc').orderBy(expressions.rowOrder('d'), 'asc');
    const paged = query.page !== undefined || query.pageSize !== undefined, page = query.page ?? 1, pageSize = query.pageSize ?? 20;
    let total: number, rows: { data: string }[];
    if (search) {
      // SQLite lower() folds ASCII only. Preserve JS Unicode case-insensitive
      // search without reading every complete document into the application.
      const candidates = database.all(ordered.select('d.id').select([
        expressions.field('d.data', 'title').as('title'), expressions.field('d.data', 'author').as('author'), expressions.field('d.data', 'publisher').as('publisher'), expressions.field('d.data', 'description').as('description'), expressions.field('d.data', 'bodyMarkdown').as('bodyMarkdown'),
      ]));
      const matches = candidates.filter(row => [row.title, row.author, row.publisher, row.description, row.bodyMarkdown].map(value => value || '').join(' ').toLowerCase().includes(search)); total = matches.length;
      const ids = (paged ? matches.slice((page - 1) * pageSize, page * pageSize) : matches).map(row => row.id);
      rows = [];
      // Unpaged selectors can exceed a driver's bound-parameter limit. The IDs
      // already follow the result order, so chunked reads preserve that order.
      for (let offset = 0; offset < ids.length; offset += 500) rows.push(...database.all(database.query.selectFrom('documents as d').select('d.data').where('d.id', 'in', ids.slice(offset, offset + 500)).orderBy(eb => eb.fn.coalesce(expressions.field('d.data', 'updatedAt'), eb.val('')), 'desc').orderBy(expressions.rowOrder('d'), 'asc')));
    } else {
      total = paged ? Number(database.one(selection.select(eb => eb.fn.countAll<number>().as('total')))!.total) : 0;
      rows = database.all(paged ? ordered.select('d.data').limit(pageSize).offset((page - 1) * pageSize) : ordered.select('d.data'));
    }
    const items = rows.map(row => normalizeDocument(store, JSON.parse(row.data) as DocumentRecord, categories));
    return paged ? { items, total, page, pageSize } : items;
  });
  app.get('/api/documents/kinds', async () => {
    const { query, expressions } = store.database;
    return store.database.all(query.selectFrom('documents').select(expressions.field('data', 'kind').as('kind')).distinct().where(eb => eb.or([eb(expressions.field('data', '_archived'), 'is', null), eb(expressions.field('data', '_archived'), '=', 0)]))).map(row => String(row.kind)).sort((a,b) => a.localeCompare(b, 'zh-CN'));
  });
  app.get('/api/documents/:id', async request => { const document = store.require<DocumentRecord & { _archived?: boolean }>('documents', parse(id, (request.params as { id: string }).id)); if (document._archived) fail(404, 'NOT_FOUND', '资料已归档'); return normalizeDocument(store, document); });
  app.post('/api/documents', async (request, reply) => {
    const input = parse(documentSchema, request.body); store.validateRefs(input); const document = normalizeDocument(store, { ...input, id: input.id || makeId('doc'), updatedAt: now() } as DocumentRecord); validateDocument(store, document); store.insert('documents', document.id, document); return reply.code(201).send(document);
  });
  app.put('/api/documents/:id', async request => {
    const did = parse(id, (request.params as { id: string }).id); const previous = store.require<DocumentRecord>('documents', did); const input = parse(documentSchema, request.body);
    if (input.id && input.id !== did) fail(400, 'ID_IMMUTABLE', 'ID 不能在编辑时更换');
    if (input.updatedAt && input.updatedAt !== previous.updatedAt) fail(409, 'DOCUMENT_VERSION_CONFLICT', '资料已更新，请刷新后再编辑');
    store.validateRefs(input); const document = normalizeDocument(store, { ...input, id: did, updatedAt: nextStamp(previous.updatedAt) } as DocumentRecord); validateDocument(store, document); store.put('documents', did, document); return document;
  });
  app.delete('/api/documents/:id', async request => { const did = parse(id, (request.params as { id: string }).id); const document = store.require<DocumentRecord>('documents', did); store.put('documents', did, { ...document, _archived: true, updatedAt: nextStamp(document.updatedAt) }); return { ok: true }; });
}
