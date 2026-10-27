import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Store } from '../../server/core/store.js';
import { ApiError } from '../../server/core/validation.js';
import { registerAiRoutes } from '../../server/modules/ai/routes.js';

test('AI history pages filter batch failures and keep private execution context out of responses', async t => {
  const store = new Store(':memory:'), app = Fastify();
  t.after(async () => { await app.close(); store.db.close(); });
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof ApiError ? error.status : 500).send({ error: { code: error instanceof ApiError ? error.code : 'INTERNAL_ERROR' } }));
  registerAiRoutes(app, store);
  for (let index = 0; index < 45; index++) {
    const failed = index % 3 === 0, id = 'history-' + String(index).padStart(3, '0');
    store.database.putRecord('ai_runs', id, { id, kind: 'document_plan', status: failed ? 'failed' : 'completed', createdAt: '2026-10-26T00:00:00.000Z', model: 'local-fixture', questionIds: ['question-' + index % 2], warnings: [], jobId: 'job-' + index % 2, batchId: 'block-' + index,
      ...(failed ? { failure: { code: 'AI_PROVIDER_ERROR', message: 'HTTP 429', stage: 'request', retryable: true, recommendation: '稍后重试' } } : { result: { title: '知识块', summary: '知识摘要', topics: ['概念'], sourceName: '教材', label: '第一章' } }), _context: { privateCanary: 'NEVER_RETURN_PRIVATE_CONTEXT', questionVersions: {}, sourceByItem: {} } });
  }
  const get = async (url: string, status = 200) => { const response = await app.inject(url); assert.equal(response.statusCode, status); assert.ok(!response.body.includes('NEVER_RETURN_PRIVATE_CONTEXT')); return response.json(); };
  const first = await get('/api/ai/runs?page=1&pageSize=10'), second = await get('/api/ai/runs?page=2&pageSize=10');
  assert.equal(first.total, 45); assert.equal(first.items.length, 10); assert.equal(new Set([...first.items, ...second.items].map((item: any) => item.id)).size, 20);
  const failures = await get('/api/ai/runs?kind=document_plan&status=failed&jobId=job-0&questionId=question-0&page=1&pageSize=20');
  assert.equal(failures.total, 8); assert.ok(failures.items.every((item: any) => item.status === 'failed' && item.jobId === 'job-0' && !('result' in item)));
  assert.equal((await get('/api/ai/runs?page=20&pageSize=10')).items.length, 0);
  await get('/api/ai/runs?status=partial', 400); await get('/api/ai/runs?pageSize=999', 400);
  assert.equal((await get('/api/ai/runs')).length, 45);
});
