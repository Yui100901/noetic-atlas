import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Store } from '../../core/store.js';
import { id, parse } from '../../core/validation.js';
import { paginationFields } from '../../core/pagination.js';
import { runAiAction } from './execution.js';
import { createDocumentJob, deleteDocumentJob, documentJob, documentSummary, documentView, importDocumentJob, processDocumentJob } from './document-service.js';
import type { StoredAiDocumentJob } from './document-schema.js';

export function registerAiDocumentRoutes(app: FastifyInstance, store: Store, options: { native?: boolean } = {}) {
  app.get('/api/ai/document-jobs', async request => {
    const query = parse(z.object(paginationFields).strict(), request.query);
    const database = store.database;
    let selection = database.query.selectFrom('ai_import_jobs').select(database.expressions.jsonWithout('data', ['blocks', 'requirements']).as('data')).orderBy(database.expressions.field('data', 'updatedAt'), 'desc').orderBy('id');
    const paged = query.page !== undefined || query.pageSize !== undefined, page = query.page || 1, pageSize = query.pageSize || 20;
    if (paged) selection = selection.limit(pageSize).offset((page - 1) * pageSize);
    const items = database.all(selection).map(row => documentSummary(JSON.parse(row.data) as StoredAiDocumentJob));
    return paged ? { items, page, pageSize, total: Number(database.one(database.query.selectFrom('ai_import_jobs').select(eb => eb.fn.countAll<number>().as('count')))!.count) } : items;
  });
  app.post('/api/ai/document-jobs', async (request, reply) => reply.code(201).send(createDocumentJob(store, request.body)));
  app.get('/api/ai/document-jobs/:id', async request => documentView(documentJob(store, parse(id, (request.params as any).id))));
  app.delete('/api/ai/document-jobs/:id', async request => deleteDocumentJob(store, parse(id, (request.params as any).id)));
  app.post('/api/ai/document-jobs/:id/plan', async (request, reply) => runAiAction(request, reply, context => processDocumentJob(store, parse(id, (request.params as any).id), 'plan', request.body, context), options));
  app.post('/api/ai/document-jobs/:id/generate', async (request, reply) => runAiAction(request, reply, context => processDocumentJob(store, parse(id, (request.params as any).id), 'generate', request.body, context), options));
  app.post('/api/ai/document-jobs/:id/import', async request => importDocumentJob(store, parse(id, (request.params as any).id), request.body));
}
