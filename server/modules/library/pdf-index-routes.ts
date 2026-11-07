import { pdfQueueInputSchema, pdfSearchQuerySchema } from './pdf-index-schema.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from '../../core/store.js';
import { parse } from '../../core/validation.js';
import {
  claimPdfJob,
  controlPdfJob,
  ingestPdfPages,
  listPdfJobs,
  queueDocumentPdf,
  queuePdfAsset,
  searchPdfAsset,
} from './pdf-index-service.js';
export function registerPdfIndexRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/pdf-index/jobs', async () => listPdfJobs(store));
  app.post('/api/pdf-index/jobs', async (request) => {
    const input = parse(pdfQueueInputSchema, request.body);
    if (input.all) {
      for (const doc of store.all<any>('documents'))
        if (!doc._archived) queueDocumentPdf(store, doc);
      return listPdfJobs(store);
    }
    return queuePdfAsset(store, input.assetId || '');
  });
  const id = (value: unknown) => parse(z.object({ id: z.string() }), value).id;
  app.post('/api/pdf-index/jobs/:id/claim', async (request) =>
    claimPdfJob(store, id(request.params)),
  );
  app.post('/api/pdf-index/jobs/:id/control', async (request) =>
    controlPdfJob(store, id(request.params), request.body),
  );
  app.post('/api/pdf-index/jobs/:id/pages', async (request) =>
    ingestPdfPages(store, id(request.params), request.body),
  );
  app.get('/api/pdf-index/assets/:id/search', async (request) => {
    const input = parse(pdfSearchQuerySchema, request.query);
    return searchPdfAsset(store, id(request.params), input.q, input.page, input.pageSize);
  });
}
