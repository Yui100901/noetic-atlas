import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { now, type Store } from '../../core/store.js';
import { fail, parse } from '../../core/validation.js';
import { readOnlyOperation } from '../../http/operation.js';
import { normalizeScoring } from '../practice/scoring.js';
import type { StoredPaper } from '../practice/service.js';
import { paperExportDocument } from '../transfer/exports.js';
import { shareSelectionSchema } from './schema.js';
import { exportShare, importShare, planShareImport } from './service.js';
import { importDedupOptionsSchema } from '../question-imports/schema.js';

export function registerSharingRoutes(app: FastifyInstance, store: Store) {
  app.post('/api/sharing/export', readOnlyOperation, async (request) =>
    exportShare(store, parse(shareSelectionSchema, request.body)),
  );
  app.post(
    '/api/sharing/preview',
    readOnlyOperation,
    async (request) =>
      planShareImport(store, parse(z.object({ data: z.unknown() }).strict(), request.body).data)
        .preview,
  );
  app.post('/api/sharing/import', async (request) => {
    const input = parse(
      z
        .object({
          data: z.unknown(),
          confirmed: z.literal(true),
          expectedFingerprint: z.string().length(64).optional(),
          dedup:importDedupOptionsSchema.optional(),
        })
        .strict(),
      request.body,
    );
    return importShare(store, input.data, input.expectedFingerprint,input.dedup);
  });
  app.post('/api/sharing/export-document', readOnlyOperation, async (request) => {
    const input = parse(shareSelectionSchema, request.body);
    if (input.kind === 'paper') {
      const paper = store.require<StoredPaper>(
        'papers',
        input.id || fail(400, 'SHARE_SELECTION_REQUIRED', '请选择题集'),
      );
      if (paper.questionCount > 500)
        fail(422, 'SHARE_PDF_LIMIT', 'PDF单次最多500道题，请缩小范围或使用ZIP分享包');
      return paperExportDocument(paper, 'answers');
    }
    const data = exportShare(store, input);
    if (data.questions.length > 500)
      fail(422, 'SHARE_PDF_LIMIT', 'PDF单次最多500道题，请缩小范围或使用ZIP分享包');
    const snapshot = data.questions;
    const stamp = now();
    return paperExportDocument(
      {
        id: 'share-export',
        title: data.title,
        description: '题目分享 · 含参考答案与解析',
        mode: 'manual',
        questionIds: snapshot.map((question) => question.id),
        questionCount: snapshot.length,
        filters: null,
        archived: false,
        version: 1,
        createdAt: stamp,
        updatedAt: stamp,
        snapshot,
        scoring: normalizeScoring(snapshot, { enabled: false }),
      },
      'answers',
    );
  });
}
