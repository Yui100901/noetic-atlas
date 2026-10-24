import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PaperDraft } from '../../../shared/practice/paper-drafts.js';
import type { Question } from '../../../shared/models/types.js';
import { Store, now, nextStamp } from '../../core/store.js';
import { fail, parse, id, leafId, paperInputSchema, filtersSchema, answersSchema, scoreSchema } from '../../core/validation.js';
import { attemptView, buildPaper, createAttempt, createQuickAttempt, saveAttempt, revealQuickAttempt, paperMarkdown, paperView, reviewAttempt, submitAttempt, syncAttempt, syncExams, getActiveExam, type StoredAttempt, type StoredPaper } from './service.js';
import { getSettings } from '../settings/routes.js';
import { paginationFields } from '../../core/pagination.js';
import { paperList, attemptList } from '../../core/read-models.js';
import { getId } from '../../http/request.js';
import { flattenQuestions, validatePaperAnswers } from '../questions/structure.js';
import { normalizeScoring } from './scoring.js';

export function registerPracticeRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/papers', async request => {
    const query = parse(z.object({ ...paginationFields, archived: z.enum(['true', 'false']).optional(), organization: z.enum(['domain', 'other']).optional(), domainId: id.optional() }).strict(), request.query);
    return paperList(store,query);
  });
  app.get('/api/papers/:id', async request => {
    const query=parse(z.object({summary:z.enum(['true','false']).optional()}).strict(),request.query);
    return paperView(store.require<StoredPaper>('papers',getId(request)),query.summary==='true'?'summary':true);
  });
  app.get('/api/papers/:id/questions/:questionId', async request => {
    const params = parse(z.object({id,questionId:leafId}).strict(), request.params);
    const paper = store.require<StoredPaper>('papers', params.id);
    const question = flattenQuestions(paper.snapshot).find(q=>q.id===params.questionId);
    if (!question) fail(404,'QUESTION_SET_MEMBER_NOT_FOUND','该题目不属于此题集');
    return question;
  });
  app.post('/api/papers', async (request, reply) => { const paper = buildPaper(store, parse(paperInputSchema, request.body)); store.insert('papers', paper.id, paper); return reply.code(201).send(paperView(paper, true)); });
  app.post('/api/papers/preview', async request => paperView(buildPaper(store, parse(paperInputSchema, request.body)), true));
  app.put('/api/papers/:id', async request => {
    const pid = getId(request); const old = store.require<StoredPaper>('papers', pid); const input = parse(paperInputSchema, request.body);
    if (input.id && input.id !== pid) fail(400, 'ID_IMMUTABLE', 'ID 不能在编辑时更换');
    const paper = buildPaper(store, input, old); store.put('papers', pid, paper); return paperView(paper, true);
  });
  app.post('/api/papers/:id/restore', async request => {
    parse(z.object({ confirmed: z.literal(true) }).strict(), request.body);
    return store.transaction(() => {
      const paper = store.require<StoredPaper>('papers', getId(request));
      if (!paper.archived) return paperView(paper, 'summary');
      if (!paper.questionIds.length) fail(409, 'EMPTY_PAPER', '空题集不能恢复，请先添加题目');
      const sourceQuestions = paper.questionIds.map(qid => store.get<Question>('questions', qid));
      const unavailable = paper.questionIds.filter((_qid, index) => sourceQuestions[index]?.status !== 'published');
      if (unavailable.length) fail(409, 'QUESTION_SET_NOT_READY', '题集中仍有未审核、已归档或不存在的题目，请先处理这些题目', { unavailableQuestionIds: unavailable });
      // The first restoration of an untouched legacy collection adopts its
      // reviewed references, including very large sets. Later versions and
      // edited/scored sets keep their authored snapshot and score rules.
      let restored = { ...paper, archived: false, updatedAt: nextStamp(paper.updatedAt) };
      if (paper.legacyBankId && paper.version === 1 && !paper.scoring?.enabled) {
        const snapshot = sourceQuestions as Question[];
        validatePaperAnswers(snapshot, 1_500_000);
        restored = { ...restored, snapshot, scoring: normalizeScoring(snapshot, { enabled: false }), version: paper.version + 1 };
      }
      store.put('papers', paper.id, restored);
      return paperView(restored, 'summary');
    });
  });
  app.delete('/api/papers/:id', async request => {
    const pid = getId(request), p = store.require<StoredPaper>('papers', pid);
    const query = parse(z.object({ permanent: z.enum(['true', 'false']).optional() }).strict(), request.query);
    if (query.permanent === 'true') {
      const drafts=store.all<PaperDraft>('paper_drafts').filter(draft=>draft.context===pid);
      if(drafts.length)fail(409,'PAPER_HAS_AUTHORING_DRAFTS',`这份题集还有${drafts.length}份组卷草稿，请先进入编辑页删除这些草稿，再永久删除题集。`);
      store.remove('papers', pid); return { ok: true, deleted: pid, retainedAttempts: store.all<StoredAttempt>('attempts').filter(a => (a.source || 'paper') === 'paper' && a.paperId === pid).length };
    }
    store.put('papers', pid, { ...p, archived: true, updatedAt: now() }); return { ok: true };
  });
  app.get('/api/papers/:id/export', async (request, reply) => {
    const p = store.require<StoredPaper>('papers', getId(request)); const answers = (request.query as any).answers === 'true';
    return reply.header('Content-Disposition', `attachment; filename="paper.md"; filename*=UTF-8''${encodeURIComponent(`paper-${p.id}.md`)}`).type('text/markdown; charset=utf-8').send(paperMarkdown(p, answers));
  });
  app.post('/api/papers/:id/attempts', async (request, reply) => {
    const paper = store.require<StoredPaper>('papers', getId(request)); if (paper.archived) fail(409, 'PAPER_ARCHIVED', '题集已归档，可查看历史作答，不能新建练习');
    const input = parse(z.object({ mode: z.enum(['practice','exam']).optional(), durationMinutes: z.number().int().min(1).max(1440).optional(), count:z.number().int().min(1).max(500).optional(), selection:z.enum(['ordered','random']).optional() }).strict(), request.body || {});
    return reply.code(201).send(attemptView(createAttempt(store, paper, input)));
  });
  app.get('/api/papers/:id/drafts', async request => {
    const paperId = getId(request); store.require('papers', paperId);
    return store.all<StoredAttempt>('attempts').filter(a => (a.source || 'paper') === 'paper' && a.paperId === paperId && a.status === 'in_progress').sort((a, b) => (b.updatedAt || b.startedAt).localeCompare(a.updatedAt || a.startedAt) || b.id.localeCompare(a.id)).slice(0, getSettings(store).maxDraftsPerPaper).map(attemptView);
  });
  app.post('/api/quick-practice', async (request, reply) => {
    const input = parse(z.object({ questionId: id.optional(), excludeQuestionId: id.optional(), filters: filtersSchema.optional() }).strict().refine(v => !(v.questionId && (v.filters || v.excludeQuestionId)), '指定题号和随机筛选只能选择一种'), request.body || {});
    return reply.code(201).send(attemptView(createQuickAttempt(store, input)));
  });
  app.get('/api/attempts', async request => {
    const query = parse(z.object({ ...paginationFields, paperId: id.optional(), source: z.enum(['paper','quick']).optional(), status: z.enum(['in_progress','submitted']).optional() }).strict(), request.query);
    return attemptList(store,query);
  });
  app.get('/api/exams/active', async () => { const attempt = getActiveExam(store); return { attempt: attempt ? attemptView(attempt) : null }; });
  app.post('/api/exams/sync', async () => { syncExams(store); const attempt = getActiveExam(store); return { attempt: attempt ? attemptView(attempt) : null }; });
  app.post('/api/attempts/:id/sync', async request => attemptView(syncAttempt(store, store.require<StoredAttempt>('attempts', getId(request)))));
  app.get('/api/attempts/:id', async request => attemptView(store.require<StoredAttempt>('attempts', getId(request))));
  app.put('/api/attempts/:id', async request => {
    const aid = getId(request); const attempt = store.require<StoredAttempt>('attempts', aid);
    const { answers } = parse(z.object({ answers: answersSchema }).strict(), request.body); return attemptView(saveAttempt(store, attempt, answers));
  });
  app.post('/api/attempts/:id/reveal', async request => attemptView(revealQuickAttempt(store, store.require<StoredAttempt>('attempts', getId(request)))));
  app.post('/api/attempts/:id/submit', async request => {
    const attempt = store.require<StoredAttempt>('attempts', getId(request));
    const body = parse(z.object({ answers: answersSchema.optional() }).strict(), request.body || {}); return attemptView(submitAttempt(store, attempt, body.answers));
  });
  app.put('/api/attempts/:id/review', async request => {
    const { scores, mastery, verdicts } = parse(scoreSchema, request.body); return attemptView(reviewAttempt(store, store.require<StoredAttempt>('attempts', getId(request)), scores, mastery,verdicts));
  });
}
