import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Question } from '../../../shared/models/types.js';
import type { QuestionFeedback, QuestionFeedbackSummary } from '../../../shared/models/question-feedback.js';
import { QUESTION_FEEDBACK_KINDS } from '../../../shared/models/question-feedback.js';
import type { Store } from '../../core/store.js';
import { id, parse } from '../../core/validation.js';
import { paginationFields } from '../../core/pagination.js';
import { runAiAction } from '../ai/execution.js';
import { questionFeedbackInputSchema, questionFeedbackResolveSchema, questionFeedbackAiInputSchema } from './schema.js';
import { createQuestionFeedback, resolveQuestionFeedback, requireFeedback, feedbackView, feedbackFingerprint, enrichQuestionsWithFeedback, feedbackCandidates, reviewFeedbackBatch } from './service.js';

export const questionFeedbackQuerySchema = z.object({
  page: paginationFields.page.default(1), pageSize: paginationFields.pageSize.default(20), status: z.enum(['pending', 'confirmed', 'resolved', 'dismissed', 'open', 'all']).default('open'),
  questionId: id.optional(), partId: id.optional(), domainId: id.optional(), kind: z.enum(QUESTION_FEEDBACK_KINDS).optional(), search: z.string().trim().max(200).default(''),
}).strict().refine(value => !value.partId || !!value.questionId, '按小题筛选时还需提供原题ID');
export const questionFeedbackSummariesSchema = z.object({ questionIds: z.array(id).min(1).max(500).refine(values => new Set(values).size === values.length, '题号不能重复') }).strict();
export function questionFeedbackPage(store: Store, query: z.infer<typeof questionFeedbackQuerySchema>) {
  const d = store.database, x = d.expressions;
  let matches = d.query.selectFrom('question_feedback as f');
  if (query.status === 'open') matches = matches.where(x.field<string>('f.data', 'status'), 'in', ['pending', 'confirmed']);
  else if (query.status !== 'all') matches = matches.where(x.field<string>('f.data', 'status'), '=', query.status);
  if (query.questionId) matches = matches.where(x.field<string>('f.data', 'questionId'), '=', query.questionId);
  if (query.partId) matches = matches.where(x.field<string>('f.data', 'partId'), '=', query.partId);
  if (query.kind) matches = matches.where(x.field<string>('f.data', 'kind'), '=', query.kind);
  if (query.search) matches = matches.where(eb => eb.or([x.containsLiteral(x.field<string>('f.data', 'questionTitle'), query.search), x.containsLiteral(x.field<string>('f.data', 'description'), query.search)]));
  if (query.domainId) {
    d.projections.ensure(['questions']);
    const categories = d.all(d.query.selectFrom('categories').select('id').where(x.field<string>('data', 'domainId'), '=', query.domainId)).map(row => row.id);
    matches = matches.where(eb => eb.exists(eb.selectFrom('question_read_model as q').select('q.id').whereRef('q.id', '=', x.field<string>('f.data', 'questionId')).where(x.arrayAny('q.data', 'categoryIds', categories))));
  }
  const total = Number(d.one(matches.select(eb => eb.fn.countAll<number>().as('count')))?.count || 0);
  const records = d.all(matches.select('f.data').orderBy(x.field<string>('f.data', 'updatedAt'), 'desc').orderBy('f.id').limit(query.pageSize).offset((query.page - 1) * query.pageSize)).map(row => JSON.parse(row.data) as QuestionFeedback);
  // Fetch only the current page's unique source rows once, not one full read per report.
  const ids = [...new Set(records.map(record => record.questionId))];
  const sources = new Map(ids.length ? d.all(d.query.selectFrom('questions').select(['id', 'data']).where(x.idInJson('id', ids))).map(row => [row.id, JSON.parse(row.data) as Question]) : []);
  const items = records.map(record => {
    const question = sources.get(record.questionId), part = record.partId ? question?.parts?.find(item => item.id === record.partId) : undefined;
    const source = question && (!record.partId || part) ? { question, ...(part ? { part } : {}) } : undefined;
    return { ...record, sourceAvailable: !!source, sourceChanged: !source || feedbackFingerprint(source) !== record.contentFingerprint };
  });
  return { items, total, page: query.page, pageSize: query.pageSize };
}
export function registerQuestionFeedbackRoutes(app: FastifyInstance, store: Store, options: { native?: boolean } = {}) {
  app.get('/api/question-feedback', async request => questionFeedbackPage(store, parse(questionFeedbackQuerySchema, request.query)));
  app.post('/api/question-feedback', async (request, reply) => reply.code(201).send(createQuestionFeedback(store, parse(questionFeedbackInputSchema, request.body))));
  app.post('/api/question-feedback/summaries', async request => {
    const input = parse(questionFeedbackSummariesSchema, request.body), questions = enrichQuestionsWithFeedback(store, input.questionIds.map(id => ({ id })));
    const summaries: Record<string, QuestionFeedbackSummary> = Object.fromEntries(questions.map(question => [question.id, question.feedbackSummary])); return { summaries };
  });
  app.get('/api/question-feedback/:id', async request => feedbackView(store, requireFeedback(store, parse(id, (request.params as any).id))));
  app.get('/api/question-feedback/:id/candidates', async request => feedbackCandidates(store, requireFeedback(store, parse(id, (request.params as any).id))));
  app.post('/api/question-feedback/:id/resolve', async request => resolveQuestionFeedback(store, requireFeedback(store, parse(id, (request.params as any).id)), parse(questionFeedbackResolveSchema, request.body)));
  app.post('/api/question-feedback/ai-review', async (request, reply) => runAiAction(request, reply, async execution => reviewFeedbackBatch(store, parse(questionFeedbackAiInputSchema, request.body), execution), options));
}
