import type { FastifyInstance } from 'fastify';
import type { Store } from '../../core/store.js';
import { id, parse } from '../../core/validation.js';
import { runAuditedAiAction } from '../ai/audit.js';
import { aiSimilarQuestionsInputSchema, similarQuestionsQuerySchema } from './similar-schema.js';
import { recommendSimilarQuestions, similarQuestionsPage } from './similar-service.js';

export function registerSimilarQuestionRoutes(app: FastifyInstance, store: Store, options: { native?: boolean } = {}) {
  app.get('/api/questions/:id/similar', async request => similarQuestionsPage(store, parse(id, (request.params as { id: string }).id), parse(similarQuestionsQuerySchema, request.query)));
  app.post('/api/ai/similar-questions', async (request, reply) => runAuditedAiAction(store, 'similar_questions', request, reply,
    execution => recommendSimilarQuestions(store, parse(aiSimilarQuestionsInputSchema, request.body), execution), options));
}
