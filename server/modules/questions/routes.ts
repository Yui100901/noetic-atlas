import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Question, QuestionBank } from '../../../shared/models/types.js';
import type { PaperDraft } from '../../../shared/practice/paper-drafts.js';
import { Store, makeId, now, nextStamp } from '../../core/store.js';
import { fail, parse, id, types, questionSchema, questionReviewSchema, selectedIdsSchema, pendingEnvelopeSchema } from '../../core/validation.js';
import type { StoredPaper } from '../practice/service.js';
import { assertNewQuestionId } from '../banks/routes.js';
import { validateAssetReferences } from '../assets/routes.js';
import { getSettings } from '../settings/routes.js';
import { getId } from '../../http/request.js';

const questionQuerySchema = z.object({
  search: z.string().max(1000).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(30), domainId: id.optional(), categoryId: id.optional(), bankId: id.optional(), tagIds: z.string().max(10000).optional(), tagMode: z.enum(['all', 'any']).default('all'), type: types.optional(),
  difficulty: z.coerce.number().int().min(1).max(4).optional(), depth: z.coerce.number().int().min(1).max(4).optional(), frequency: z.coerce.number().int().min(0).max(3).optional(), collection: z.enum(['general', 'personal', 'all']).optional(), status: z.enum(['published', 'pending', 'draft', 'archived', 'all']).optional(), favorite: z.enum(['true', 'false', '1', '0']).optional(), due: z.enum(['true', 'false', '1', '0']).optional(), wrong: z.enum(['true', 'false', '1', '0']).optional(),
});
export function registerQuestionRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/questions', async request => {
    const query = parse(questionQuerySchema, request.query);return store.questionPage(query);
  });
  app.get('/api/questions/:id', async request => store.question(getId(request)));
  app.post('/api/questions', async (request, reply) => {
    const input = parse(questionSchema, request.body); assertNewQuestionId(input.id); store.validateRefs(input); validateAssetReferences(store, input, getSettings(store));
    const q = { ...input, status: input.status === 'draft' ? 'draft' : 'pending', id: input.id || makeId('q'), createdAt: now(), updatedAt: now() } as Question;
    store.insert('questions', q.id, q); return reply.code(201).send(store.question(q.id));
  });
  app.put('/api/questions/:id', async request => {
    const qid = getId(request); const previous = store.require<Question>('questions', qid); const input = parse(questionSchema, request.body);
    if (input.id && input.id !== qid) fail(400, 'ID_IMMUTABLE', '题号不能在编辑时更换'); store.validateRefs(input); validateAssetReferences(store, input, getSettings(store));
    if (input.updatedAt && input.updatedAt !== previous.updatedAt) fail(409, 'QUESTION_VERSION_CONFLICT', '题目已被修改，请刷新后再编辑');
    if (input.status === 'published' && previous.status !== 'published') fail(409, 'REVIEW_REQUIRED', '未发布题目必须先送审，再通过用户确认审核');
    const q = { ...input, id: qid, createdAt: previous.createdAt || now(), updatedAt: nextStamp(previous.updatedAt) }; store.put('questions', qid, q); return store.question(qid);
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
  app.post('/api/questions/pending/export', async (request, reply) => {
    const { ids } = parse(selectedIdsSchema, request.body);
    const questions = ids.map(qid => {
      const q = store.require<Question>('questions', qid);
      if (q.status !== 'pending') fail(409, 'QUESTION_NOT_PENDING', `只能导出待审核题目：${qid}`);
      return q;
    });
    return reply.header('Content-Disposition', 'attachment; filename="pending-questions.json"').send({ format: 'learning-pending-questions', schemaVersion: 1, exportedAt: now(), questions });
  });
  app.post('/api/questions/pending/import', async request => {
    const { data } = parse(z.object({ data: pendingEnvelopeSchema, confirmed: z.literal(true) }).strict(), request.body);
    return store.transaction(() => {
      const entries = data.questions.map(input => {
        const q = store.require<Question>('questions', input.id!);
        if (q.status !== 'pending') fail(409, 'QUESTION_NOT_PENDING', `只能更新现有待审核题目：${q.id}`);
        if (q.updatedAt !== input.updatedAt) fail(409, 'QUESTION_VERSION_CONFLICT', `题目已被修改，未覆盖更新：${q.id}`);
        store.validateRefs(input); validateAssetReferences(store, input, getSettings(store));
        return { ...input, id: q.id, status: 'pending' as const, createdAt: q.createdAt || now(), updatedAt: nextStamp(q.updatedAt) };
      });
      for (const q of entries) store.put('questions', q.id, q);
      return { ok: true, updated: entries.length, items: entries.map(q => store.question(q.id)) };
    });
  });
  app.delete('/api/questions/:id', async request => {
    const qid = getId(request); store.require<Question>('questions', qid);
    const papers = store.all<StoredPaper>('papers').filter(p => p.questionIds.includes(qid));
    const drafts = store.all<PaperDraft>('paper_drafts').filter(d => d.state.questionIds.includes(qid));
    if (drafts.length) fail(409, 'QUESTION_IN_DRAFT', '题目仍被组卷草稿引用，请先编辑或删除相关草稿', { draftIds: drafts.map(d => d.id) });
    if (papers.length) fail(409, 'QUESTION_IN_PAPER', '题目仍被当前试卷引用，请先从这些试卷中移除；可先将题目归档', { paperIds: papers.map(p => p.id), paperTitles: papers.map(p => p.title) });
    return store.transaction(() => {
      store.remove('questions', qid);
      if (store.get('study', qid)) store.remove('study', qid);
      for (const review of store.all<any>('reviews')) if (review.questionId === qid) store.remove('reviews', review.id);
      for (const bank of store.all<QuestionBank>('question_banks')) if (bank.questionIds.includes(qid)) store.put('question_banks', bank.id, { ...bank, questionIds: bank.questionIds.filter(id => id !== qid), updatedAt: nextStamp(bank.updatedAt) });
      return { ok: true, deleted: qid };
    });
  });
}
