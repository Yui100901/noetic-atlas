import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Question } from '../../../shared/models/types.js';
import type { PaperDraft } from '../../../shared/practice/paper-drafts.js';
import { normalizeQuestionBlankStems } from '../../../shared/questions/blank-markers.js';
import { Store,makeId,nextStamp,now } from '../../core/store.js';
import { fail,parse,pendingEnvelopeSchema,questionMetadataInputSchema,questionReviewSchema,selectedIdsSchema } from '../../core/validation.js';
import { readOnlyOperation } from '../../http/operation.js';
import { getId } from '../../http/request.js';
import { validateAssetReferences } from '../assets/service.js';
import { validateDocumentCitations } from '../library/sources.js';
import type { StoredPaper } from '../practice/service.js';
import { getSettings } from '../settings/service.js';
import { requireQuestionDraftVersion } from './drafts.js';
import { assertNewQuestionId,exportPendingQuestions,importPendingQuestions } from './import-export.js';
import { questionSaveSchema } from './maintenance-schema.js';
import { questionQuerySchema } from './query-schema.js';
import { captureQuestionRevision } from './revisions.js';

export function registerQuestionRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/questions', async request => {
    const query = parse(questionQuerySchema, request.query);return store.questionPage(query);
  });
  app.get('/api/questions/:id', async request => store.question(getId(request)));
  app.post('/api/questions/metadata', readOnlyOperation, async request => store.questionMetadataByIds(parse(questionMetadataInputSchema,request.body).ids));
  app.post('/api/questions', async (request, reply) => {
    const {revisionReason='',draftId,draftUpdatedAt,...raw}=parse(questionSaveSchema,request.body);const input = normalizeQuestionBlankStems(raw); assertNewQuestionId(input.id); store.validateRefs(input); validateAssetReferences(store, input, getSettings(store));
    const q = { ...input, status: input.status === 'draft' ? 'draft' : 'pending', id: input.id || makeId('q'), createdAt: now(), updatedAt: now() } as Question;
    store.transaction(()=>{if(draftId)requireQuestionDraftVersion(store,draftId,draftUpdatedAt!,null);validateDocumentCitations(store,q,true);store.insert('questions', q.id, q);captureQuestionRevision(store,undefined,q,'baseline',revisionReason);if(draftId)store.remove('question_drafts',draftId);}); return reply.code(201).send(store.question(q.id));
  });
  app.put('/api/questions/:id', async request => {
    const qid = getId(request); const previous = store.require<Question>('questions', qid); const {revisionReason='',draftId,draftUpdatedAt,...raw}=parse(questionSaveSchema,request.body);const input = normalizeQuestionBlankStems(raw);
    if (input.id && input.id !== qid) fail(400, 'ID_IMMUTABLE', '题号不能在编辑时更换'); store.validateRefs(input); validateAssetReferences(store, input, getSettings(store));
    if (input.updatedAt && input.updatedAt !== previous.updatedAt) fail(409, 'QUESTION_VERSION_CONFLICT', '题目已被修改，请刷新后再编辑');
    if (input.status === 'published' && previous.status !== 'published') fail(409, 'REVIEW_REQUIRED', '未发布题目必须先送审，再通过用户确认审核');
    const q = { ...input, id: qid, createdAt: previous.createdAt || now(), updatedAt: nextStamp(previous.updatedAt) }; store.transaction(()=>{const current=store.require<Question>('questions',qid);if(current.updatedAt!==previous.updatedAt)fail(409,'QUESTION_VERSION_CONFLICT','题目已被修改，请重新核对');if(draftId)requireQuestionDraftVersion(store,draftId,draftUpdatedAt!,qid);validateDocumentCitations(store,q,true);captureQuestionRevision(store,previous,q,'manual',revisionReason);store.put('questions', qid, q);if(draftId)store.remove('question_drafts',draftId);}); return store.question(qid);
  });
  app.post('/api/questions/review', async request => {
    const input = parse(questionReviewSchema, request.body);
    return store.transaction(() => {
      const questions = input.ids.map(qid => {
        const q = store.require<Question>('questions', qid);
        if (q.status !== 'pending') fail(409, 'QUESTION_NOT_PENDING', `题目已不在待审核状态：${qid}`);
        if (q.updatedAt !== input.expectedUpdatedAt[qid]) fail(409, 'QUESTION_VERSION_CONFLICT', `题目已被修改，请刷新并重新检查：${qid}`);
        store.validateRefs(q); validateAssetReferences(store, q); return q;
      });
      for (const q of questions) store.put('questions', q.id, { ...q, status: input.action === 'approve' ? 'published' : 'draft', updatedAt: nextStamp(q.updatedAt) });
      return { ok: true, action: input.action, count: questions.length, items: questions.map(q => store.question(q.id)) };
    });
  });
  app.post('/api/questions/pending/export', readOnlyOperation, async (request, reply) => {
    const { ids } = parse(selectedIdsSchema, request.body);
    return reply.header('Content-Disposition', 'attachment; filename="pending-questions.json"').send(exportPendingQuestions(store, ids));
  });
  app.post('/api/questions/pending/import', async request => {
    const { data } = parse(z.object({ data: pendingEnvelopeSchema, confirmed: z.literal(true) }).strict(), request.body);
    return importPendingQuestions(store, data);
  });
  app.delete('/api/questions/:id', async request => {
    const qid = getId(request); store.require<Question>('questions', qid);
    const papers = store.all<StoredPaper>('papers').filter(p => p.questionIds.includes(qid));
    const drafts = store.all<PaperDraft>('paper_drafts').filter(d => d.state.questionIds.includes(qid));
    if (drafts.length) fail(409, 'QUESTION_IN_DRAFT', '题目仍被组卷草稿引用，请先编辑或删除相关草稿', { draftIds: drafts.map(d => d.id) });
    if (papers.length) fail(409, 'QUESTION_IN_PAPER', '题目仍被当前试卷引用，请先从这些试卷中移除；可先将题目归档', { paperIds: papers.map(p => p.id), paperTitles: papers.map(p => p.title) });
    return store.transaction(() => {
      store.remove('questions', qid);
      for(const table of ['question_drafts','question_revisions'] as const){const d=store.database;for(const row of d.all(d.query.selectFrom(table).select('id').where(d.expressions.field('data','questionId'),'=',qid)))store.remove(table,row.id);}
      if (store.get('study', qid)) store.remove('study', qid);
      for (const state of store.all<any>('study_parts')) if (state.questionId === qid) store.remove('study_parts', JSON.stringify([qid, state.partId]));
      for (const review of store.all<any>('reviews')) if (review.questionId === qid) store.remove('reviews', review.id);
      return { ok: true, deleted: qid };
    });
  });
}
