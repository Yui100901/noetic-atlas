import type { FastifyInstance } from 'fastify';
import type { Store } from '../../core/store.js';
import { parse } from '../../core/validation.js';
import { getId } from '../../http/request.js';
import { documentListQuerySchema } from './list.js';
import { documentSourceParamsSchema, relatedQuestionsQuerySchema } from './source-schema.js';
import { documentContentVersion, readDocumentSource, relatedDocumentQuestions } from './sources.js';
import { archiveDocument, createDocument, documentKinds, documentPage, getDocument, listDocuments, updateDocument } from './service.js';

export function registerLibraryRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/documents', async request => listDocuments(store, parse(documentListQuerySchema, request.query)));
  app.get('/api/documents/page', async request => documentPage(store, parse(documentListQuerySchema, request.query)));
  app.get('/api/documents/kinds', async () => documentKinds(store));
  app.get('/api/documents/:id', async request => {const document=getDocument(store,getId(request));return {...document,contentVersion:documentContentVersion(document)};});
  app.get('/api/documents/:id/versions/:versionId', async request => {const params=parse(documentSourceParamsSchema,request.params);return readDocumentSource(store,params.id,params.versionId);});
  app.get('/api/documents/:id/questions', async request => relatedDocumentQuestions(store,getId(request),parse(relatedQuestionsQuerySchema,request.query)));
  app.post('/api/documents', async (request, reply) => reply.code(201).send(createDocument(store, request.body)));
  app.put('/api/documents/:id', async request => updateDocument(store, getId(request), request.body));
  app.delete('/api/documents/:id', async request => archiveDocument(store, getId(request)));
}
