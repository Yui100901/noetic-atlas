import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../server/core/store.js';
import { settingsSchema, getSettings } from '../../server/modules/settings/service.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';
import {
  AI_IMPORT_HARD_LIMITS,
  DEFAULT_AI_IMPORT_LIMITS,
  needsBatchedImport,
} from '../../shared/ai/import-limits.js';
import { createDocumentJob } from '../../server/modules/ai/document-service.js';
import { extractDocumentFiles } from '../../web/features/ai/ai-document-files.js';
import Fastify from 'fastify';
import { registerAiDocumentRoutes } from '../../server/modules/ai/document-routes.js';
import { registerAiWorkspaceDraftRoutes } from '../../server/modules/ai/workspace-drafts.js';
import { ApiError } from '../../server/core/validation.js';

test('AI import settings fill older configuration defaults and reject unsafe or incoherent budgets', () => {
  const { aiImport: _omitted, ...older } = DEFAULT_SETTINGS;
  assert.deepEqual(settingsSchema.parse(older).aiImport, DEFAULT_AI_IMPORT_LIMITS);
  for (const aiImport of [
    { ...DEFAULT_AI_IMPORT_LIMITS, fileMiB: AI_IMPORT_HARD_LIMITS.fileMiB + 1 },
    { ...DEFAULT_AI_IMPORT_LIMITS, totalMiB: 1 },
    { ...DEFAULT_AI_IMPORT_LIMITS, sourceCharacters: 0 },
    { ...DEFAULT_AI_IMPORT_LIMITS, blocks: AI_IMPORT_HARD_LIMITS.blocks + 1 },
  ])
    assert.equal(settingsSchema.safeParse({ ...DEFAULT_SETTINGS, aiImport }).success, false);
  assert.ok(DEFAULT_AI_IMPORT_LIMITS.fileMiB > 30);
  assert.ok(DEFAULT_AI_IMPORT_LIMITS.pdfPages > 2000);
});

test('local material preflight uses configured file, aggregate, text and block limits without partial results', async () => {
  const file = new File(['本机提取正文'], 'book.md');
  Object.defineProperty(file, 'size', { value: 64 * 1024 * 1024 });
  assert.equal((await extractDocumentFiles([file])).files, 1);
  await assert.rejects(extractDocumentFiles([file], { limits: { fileMiB: 32 } }), /单文件32MiB/);
  await assert.rejects(
    extractDocumentFiles([file, file], { limits: { totalMiB: 100 } }),
    /总大小超过100MiB/,
  );
  await assert.rejects(
    extractDocumentFiles([new File(['x'.repeat(2000)], 'chapter.md')], {
      limits: { sourceCharacters: 1000 },
    }),
    /当前配置/,
  );
  await assert.rejects(
    extractDocumentFiles([new File(['x'.repeat(24001)], 'chapter.md')], { limits: { blocks: 1 } }),
    /1个分块/,
  );
  assert.equal(needsBatchedImport('汉'.repeat(140000)), true);
  assert.equal(needsBatchedImport('plain material'), false);
});

test('server independently enforces current task byte, character and post-split block budgets', () => {
  const store = new Store(':memory:');
  try {
    const input = {
      confirmed: true,
      sourceName: '预算验收',
      sections: [{ text: 'x'.repeat(1500) }],
    };
    store.put('settings', 'system', {
      ...DEFAULT_SETTINGS,
      aiImport: { ...DEFAULT_AI_IMPORT_LIMITS, sourceCharacters: 1000 },
    });
    assert.throws(
      () => createDocumentJob(store, input),
      (error: any) => error.code === 'AI_DOCUMENT_TOO_LARGE',
    );
    assert.equal(store.database.records('ai_import_jobs').length, 0);
    store.put('settings', 'system', {
      ...getSettings(store),
      aiImport: { ...DEFAULT_AI_IMPORT_LIMITS, sourceCharacters: 2000 },
    });
    assert.equal(createDocumentJob(store, input).blockCount, 1);
    store.put('settings', 'system', {
      ...getSettings(store),
      aiImport: { ...DEFAULT_AI_IMPORT_LIMITS, sourceMiB: 1 },
    });
    assert.throws(
      () => createDocumentJob(store, { ...input, sections: [{ text: '汉'.repeat(400000) }] }),
      (error: any) => error.code === 'AI_DOCUMENT_TOO_LARGE',
    );
    store.put('settings', 'system', {
      ...getSettings(store),
      aiImport: { ...DEFAULT_AI_IMPORT_LIMITS, blocks: 1 },
    });
    assert.throws(
      () => createDocumentJob(store, { ...input, sections: [{ text: 'x'.repeat(24001) }] }),
      (error: any) => error.code === 'AI_DOCUMENT_TOO_MANY_BLOCKS',
    );
    assert.equal(store.database.records('ai_import_jobs').length, 1);
  } finally {
    store.database.close();
  }
});

test('material and draft routes accept configured inputs beyond Fastify default body limits without truncation', async () => {
  const store = new Store(':memory:'),
    app = Fastify();
  app.setErrorHandler((error, _request, reply) =>
    error instanceof ApiError
      ? reply.code(error.status).send({ error: { code: error.code, message: error.message } })
      : reply.send(error),
  );
  registerAiDocumentRoutes(app, store);
  registerAiWorkspaceDraftRoutes(app, store);
  try {
    const text = 'x'.repeat(1_200_000);
    const response = await app.inject({
      method: 'POST',
      url: '/api/ai/document-jobs',
      payload: { confirmed: true, sourceName: '大材料HTTP验收', sections: [{ text }] },
    });
    assert.equal(response.statusCode, 201, response.body);
    assert.equal(
      store.database
        .records<any>('ai_import_jobs')[0]!
        .blocks.reduce((total: number, block: any) => total + block.text.length, 0),
      text.length,
    );
    const saved = await app.inject({
      method: 'POST',
      url: '/api/ai/workspace-drafts',
      payload: { kind: 'import', contextId: null, state: { text } },
    });
    assert.equal(saved.statusCode, 201, saved.body);
    assert.equal(saved.json().state.text.length, text.length);
    store.put('settings', 'system', {
      ...DEFAULT_SETTINGS,
      aiImport: { ...DEFAULT_AI_IMPORT_LIMITS, sourceMiB: 1 },
    });
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/ai/document-jobs',
      payload: { confirmed: true, sourceName: '降低材料上限', sections: [{ text }] },
    });
    assert.equal(rejected.statusCode, 413, rejected.body);
    assert.equal(rejected.json().error.code, 'AI_DOCUMENT_TOO_LARGE');
    assert.equal(store.database.records('ai_import_jobs').length, 1);
  } finally {
    await app.close();
    store.database.close();
  }
});
