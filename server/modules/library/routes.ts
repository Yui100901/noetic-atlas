import type { FastifyInstance } from 'fastify';
import type { Store } from '../../core/store.js';
import { parse } from '../../core/validation.js';
import { getId } from '../../http/request.js';
import { documentListQuerySchema } from './list.js';
import { archiveDocument, createDocument, documentKinds, documentPage, getDocument, listDocuments, updateDocument } from './service.js';

export function registerLibraryRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/documents', async request => listDocuments(store, parse(documentListQuerySchema, request.query)));
  app.get('/api/documents/page', async request => documentPage(store, parse(documentListQuerySchema, request.query)));
  app.get('/api/documents/kinds', async () => documentKinds(store));
  app.get('/api/documents/:id', async request => getDocument(store, getId(request)));
  app.post('/api/documents', async (request, reply) => reply.code(201).send(createDocument(store, request.body)));
  app.put('/api/documents/:id', async request => updateDocument(store, getId(request), request.body));
  app.delete('/api/documents/:id', async request => archiveDocument(store, getId(request)));
}
