import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PaperDraft } from '../../../shared/practice/paper-drafts.js';
import { Store, makeId } from '../../core/store.js';
import { fail, parse, id, domainSchema, categorySchema, tagSchema } from '../../core/validation.js';
import { paginationFields, paginate } from '../../core/pagination.js';
import { getId } from '../../http/request.js';

export function registerTaxonomyRoutes(app: FastifyInstance, store: Store) {
  for (const table of ['domains', 'categories', 'tags'] as const) {
    app.get(`/api/${table}`, async request => {
      const query = parse(z.object({ ...paginationFields, search: z.string().max(1000).optional(), domainId: id.optional(), parentId: id.optional(), kind: z.string().max(40).optional() }).strict(), request.query);
      const items = store.all<any>(table).filter(item => (!query.search || item.name.toLowerCase().includes(query.search.toLowerCase())) && (!query.domainId || item.domainId === query.domainId) && (!query.parentId || item.parentId === query.parentId) && (!query.kind || item.kind === query.kind));
      return paginate(query, items);
    });
    const schema = table === 'domains' ? domainSchema : table === 'categories' ? categorySchema : tagSchema;
    app.post(`/api/${table}`, async (request, reply) => {
      const input = parse(schema as z.ZodType<any>, request.body); const entity = { ...input, id: input.id || makeId(table.slice(0, -1)) };
      if (table === 'categories') store.validateCategory(entity);
      if (table === 'tags') { entity.domainId ??= null; entity.kind ??= 'custom'; store.validateTag(entity); }
      store.insert(table, entity.id, entity); return reply.code(201).send(entity);
    });
    app.put(`/api/${table}/:id`, async request => {
      const entityId = getId(request); const previous = store.require<any>(table, entityId); const input = parse(schema as z.ZodType<any>, request.body);
      if (input.id && input.id !== entityId) fail(400, 'ID_IMMUTABLE', 'ID 不能在编辑时更换');
      const entity = { ...input, id: entityId }; if (table === 'categories') store.validateCategory(entity);
      if (table === 'tags') { entity.domainId = input.domainId === undefined ? previous.domainId ?? null : input.domainId; entity.kind = input.kind || previous.kind || 'custom'; store.validateTag(entity); }
      return store.transaction(() => { store.put(table, entityId, entity); if (table !== 'domains') store.validateTaxonomyReferences(); return entity; });
    });
    app.delete(`/api/${table}/:id`, async request => {
      const entityId = getId(request);
      const referenced = store.all<PaperDraft>('paper_drafts').some(d => (table === 'domains' && d.state.domainId === entityId) || [d.state.filters, d.state.random].some(f => table === 'domains' ? f.domainId === entityId : table === 'categories' ? f.categoryId === entityId : Array.isArray(f.tagIds) && f.tagIds.includes(entityId)));
      if (referenced) fail(409, 'TAXONOMY_IN_DRAFT', '分类或标签仍被组卷草稿引用，请先编辑或删除相关草稿');
      store.deleteTaxonomy(table, entityId); return { ok: true };
    });
  }
}
