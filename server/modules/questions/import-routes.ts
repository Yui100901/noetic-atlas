import type { FastifyInstance } from 'fastify';
import type { Store } from '../../core/store.js';
import {
  bulkQuestionImportSchema,
  newQuestionEnvelopeSchema,
  parse,
} from '../../core/validation.js';
import { z } from 'zod';
import { importDedupOptionsSchema } from '../question-imports/schema.js';
import { previewQuestionImport } from '../question-imports/service.js';
import { readOnlyOperation } from '../../http/operation.js';
import { importNewQuestionData } from './import-export.js';
import { questionImportTemplate } from './import-template.js';
import { normalizeQuestionBlankStems } from '../../../shared/questions/blank-markers.js';

export function registerQuestionImportRoutes(app: FastifyInstance, store: Store) {
  app.post('/api/questions/import-preview', readOnlyOperation, (request) => {
    const { data, dedup } = parse(
      z
        .object({ data: newQuestionEnvelopeSchema, dedup: importDedupOptionsSchema.optional() })
        .strict(),
      request.body,
    );
    return previewQuestionImport(
      store,
      data.questions.map(normalizeQuestionBlankStems),
      undefined,
      dedup,
    );
  });
  // Static imports precede /questions/:id in the offline router.
  app.get('/api/questions/import-template', async (_request, reply) =>
    reply
      .header('Content-Disposition', 'attachment; filename="new-questions-template.json"')
      .send(questionImportTemplate()),
  );
  app.post('/api/questions/bulk-import', async (request, reply) => {
    const { data, dedup } = parse(
      bulkQuestionImportSchema.extend({ dedup: importDedupOptionsSchema.optional() }),
      request.body,
    );
    const result = importNewQuestionData(store, data, dedup);
    return reply.code(201).send(result);
  });
}
