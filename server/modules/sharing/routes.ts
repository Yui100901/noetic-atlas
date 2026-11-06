import type { FastifyInstance } from 'fastify';
import { now, type Store } from '../../core/store.js';
import { fail, parse } from '../../core/validation.js';
import { readOnlyOperation } from '../../http/operation.js';
import { normalizeScoring } from '../practice/scoring.js';
import type { StoredPaper } from '../practice/service.js';
import { paperExportDocument } from '../transfer/exports.js';
import {
  shareSelectionSchema,
  shareImportInputSchema,
  shareImportPreviewInputSchema,
} from './schema.js';
import { exportShare, importShare, planShareImport } from './service.js';

export function registerSharingRoutes(app: FastifyInstance, store: Store) {
  app.post('/api/sharing/export', readOnlyOperation, async (request) =>
    exportShare(store, parse(shareSelectionSchema, request.body)),
  );
  app.post('/api/sharing/preview', readOnlyOperation, async (request) => {
    const input = parse(shareImportPreviewInputSchema, request.body);
    return planShareImport(store, input.data, input.dedup, true, input).preview;
  });
  app.post('/api/sharing/import', async (request) => {
    const input = parse(shareImportInputSchema, request.body);
    return importShare(store, input.data, input.expectedFingerprint, input.dedup, input);
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
