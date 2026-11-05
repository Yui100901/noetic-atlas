import type { FastifyInstance } from 'fastify';
import type { Store } from '../../core/store.js';
import { bulkQuestionImportSchema, parse } from '../../core/validation.js';
import { importNewQuestionData } from './import-export.js';
import { questionImportTemplate } from './import-template.js';

export function registerQuestionImportRoutes(app: FastifyInstance, store: Store) {
  // Static imports precede /questions/:id in the offline router.
  app.get('/api/questions/import-template', async (_request, reply) =>
    reply
      .header('Content-Disposition', 'attachment; filename="new-questions-template.json"')
      .send(questionImportTemplate()),
  );
  app.post('/api/questions/bulk-import', async (request, reply) => {
    const { data } = parse(bulkQuestionImportSchema, request.body);
    const result = importNewQuestionData(store, data);
    return reply.code(201).send(result);
  });
}
