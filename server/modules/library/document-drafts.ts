import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DocumentDraft } from '../../../shared/models/document-drafts.js';
import type { DocumentRecord } from '../../../shared/models/types.js';
import { makeId, nextStamp, type Store } from '../../core/store.js';
import { documentSchema, fail, id, parse } from '../../core/validation.js';
import { getSettings } from '../settings/service.js';
import { normalizeDocument, validateDocument } from './routes.js';
import { documentDraftRetentionCandidates } from './document-draft-retention.js';
import { createDocumentDraftSchema, updateDocumentDraftSchema, deleteDocumentDraftSchema, publishDocumentDraftSchema, documentDraftQuerySchema, validateDocumentDraftState } from './document-draft-schema.js';
export { documentDraftSchema, documentDraftStateSchema, createDocumentDraftSchema, updateDocumentDraftSchema, deleteDocumentDraftSchema, publishDocumentDraftSchema, documentDraftQuerySchema, validateDocumentDraftState } from './document-draft-schema.js';

function checkVersion(draft: DocumentDraft, expected: string) {
  if (draft.updatedAt !== expected) fail(409, 'DOCUMENT_DRAFT_VERSION_CONFLICT', '这份资料草稿已在其他页面修改，请保留当前内容，重新选择草稿后继续。');
}
export function listDocumentDrafts(store: Store, documentId?: string) {
  const database = store.database, field = database.expressions.field.bind(database.expressions);
  let query = database.query.selectFrom('document_drafts').select('data');
  query = documentId ? query.where(field('data', 'documentId'), '=', documentId) : query.where(field('data', 'documentId'), 'is', null);
  return database.all(query.orderBy(field('data', 'updatedAt'), 'desc').orderBy('id', 'desc').limit(getSettings(store).maxDocumentDrafts)).map(row => JSON.parse(row.data) as DocumentDraft);
}
export function registerDocumentDraftRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/document-drafts', async request => {
    const { documentId } = parse(documentDraftQuerySchema, request.query);
    return listDocumentDrafts(store, documentId);
  });
  app.post('/api/document-drafts', async (request, reply) => {
    const input = parse(createDocumentDraftSchema, request.body);
    return store.transaction(() => {
      if (input.documentId) store.require('documents', input.documentId);
      validateDocumentDraftState(store, input.state);
      const database = store.database;
      const latest = database.one(database.query.selectFrom('document_drafts').select(database.expressions.field<string>('data', 'updatedAt').as('stamp')).orderBy(database.expressions.field('data', 'updatedAt'), 'desc').limit(1));
      const stamp = nextStamp(latest?.stamp), draft: DocumentDraft = { ...input, id: makeId('document-draft'), createdAt: stamp, updatedAt: stamp };
      store.insert('document_drafts', draft.id, draft);
      for (const old of documentDraftRetentionCandidates(store, getSettings(store).maxDocumentDrafts, draft.id)) store.remove('document_drafts', old);
      reply.code(201); return draft;
    });
  });
  app.put('/api/document-drafts/:id', async request => {
    const params = parse(z.object({ id }).strict(), request.params), input = parse(updateDocumentDraftSchema, request.body);
    return store.transaction(() => {
      const previous = store.require<DocumentDraft>('document_drafts', params.id); checkVersion(previous, input.expectedUpdatedAt);
      validateDocumentDraftState(store, input.state);
      const saved: DocumentDraft = { ...previous, state: input.state, updatedAt: nextStamp(previous.updatedAt) };
      store.put('document_drafts', saved.id, saved); return saved;
    });
  });
  app.delete('/api/document-drafts/:id', async request => {
    const params = parse(z.object({ id }).strict(), request.params), input = parse(deleteDocumentDraftSchema, request.body);
    return store.transaction(() => { const draft = store.require<DocumentDraft>('document_drafts', params.id); checkVersion(draft, input.expectedUpdatedAt); store.remove('document_drafts', draft.id); return { deleted: true }; });
  });
  app.post('/api/document-drafts/:id/publish', async request => {
    const params = parse(z.object({ id }).strict(), request.params), input = parse(publishDocumentDraftSchema, request.body);
    return store.transaction(() => {
      const draft = store.require<DocumentDraft>('document_drafts', params.id); checkVersion(draft, input.expectedUpdatedAt);
      const previous = draft.documentId && !input.asNew ? store.get<DocumentRecord & { _archived?: boolean }>('documents', draft.documentId) : undefined;
      if (draft.documentId && !input.asNew && (!previous || previous._archived || (previous.updatedAt || null) !== draft.baseDocumentUpdatedAt)) fail(409, 'DOCUMENT_VERSION_CONFLICT', '原资料已更新、归档或删除。草稿已保留，可另存为新资料，或重新打开原资料后继续编辑。');
      const value = parse(documentSchema, draft.state);
      const document = normalizeDocument(store, { ...value, id: previous?.id || makeId('doc'), updatedAt: nextStamp(previous?.updatedAt) } as DocumentRecord);
      validateDocument(store, document);
      if (previous) store.put('documents', document.id, document); else store.insert('documents', document.id, document);
      store.remove('document_drafts', draft.id); return document;
    });
  });
}
