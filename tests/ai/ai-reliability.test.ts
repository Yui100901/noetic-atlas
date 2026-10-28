import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import Fastify from 'fastify';
import { z } from 'zod';
import { Store, now } from '../../server/core/store.js';
import { ApiError, parse, questionSchema } from '../../server/core/validation.js';
import { registerAiRoutes } from '../../server/modules/ai/routes.js';
import { auditAiOperation, auditedFailure, AI_AUDIT_HEADER } from '../../server/modules/ai/audit.js';
import { aiFailedRunSchema } from '../../server/modules/ai/audit-schema.js';
import { requestAiJson } from '../../server/modules/ai/provider.js';

const secret = 'secret-fixture-key-never-record', material = 'PRIVATE_INPUT_NOT_FOR_HISTORY';
const valid = { explanationMarkdown: '原子性是全部提交或全部回滚。', followUpsMarkdown: '', pitfallsMarkdown: '' };
const envelope = (content: string, reason = 'stop') => JSON.stringify({ choices: [{ finish_reason: reason, message: { content } }] });
async function fixture(t: test.TestContext) {
  const store = new Store(':memory:');
  store.put('questions', 'S1', parse(questionSchema, { id: 'S1', type: 'short_answer', title: '原子性', stemMarkdown: material, answerMarkdown: '全部或全不', createdAt: now(), updatedAt: now() }));
  const requests: any[] = [];
  let mode: (index: number) => { status?: number; body: string } = () => ({ body: envelope(JSON.stringify(valid)) });
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const result = mode(requests.length);
    response.writeHead(result.status || 200, { 'Content-Type': 'application/json', Connection: 'close' }); response.end(result.body);
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const settings = { enabled: true, baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}`, model: 'isolated-reliability-model', key: secret, supportsImages: false, sendImages: false, maxTokens: 4096, timeoutSeconds: 10, updatedAt: now() };
  store.database.putRecord('ai_settings', 'local', settings);
  const app = Fastify(); app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) return reply.code(error.status).send({ error: { code: error.code, message: error.message, details: error.details } });
    return reply.code(500).send({ error: { code: 'UNEXPECTED_TEST_FAILURE' } });
  }); registerAiRoutes(app, store);
  const api = (url: string, body?: unknown) => app.inject({ url, method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { payload: body }) });
  t.after(async () => { await app.close(); store.database.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); });
  return { store, api, settings, requests, mode(value: typeof mode) { mode = value; } };
}

test('provider HTTP failures retain specific safe diagnostics in history and cannot be applied', async t => {
  const f = await fixture(t);
  for (const status of [401, 429, 503]) {
    f.mode(() => ({ status, body: JSON.stringify({ error: { message: `${secret} provider private body ${material}` } }) }));
    const response = await f.api('/api/ai/explain', { questionId: 'S1' }); assert.equal(response.statusCode, 502);
    const id = response.headers[AI_AUDIT_HEADER]; assert.equal(typeof id, 'string');
    const run = (await f.api('/api/ai/runs/' + id)).json();
    assert.equal(run.status, 'failed'); assert.equal(run.result, undefined); assert.equal(run._context, undefined);
    assert.equal(run.failure.code, 'AI_PROVIDER_ERROR'); assert.match(run.failure.message, new RegExp(`HTTP ${status}`));
    assert.equal(run.diagnostics.httpStatus, status); assert.equal(run.diagnostics.providerCalls, 1);
    assert.ok(run.diagnostics.inputBytes > 0); assert.ok(run.diagnostics.outputBytes > 0); assert.equal(run.diagnostics.attempts[0].status, 'failed');
    const stored = f.store.database.getRecord('ai_runs', String(id)); assert.equal(aiFailedRunSchema.safeParse(stored).success, true);
    const exposed = JSON.stringify({ response: response.json(), run, stored }); assert.ok(!exposed.includes(secret)); assert.ok(!exposed.includes(material)); assert.ok(!exposed.includes('provider private body'));
    for (const [action, body] of [['apply', { confirmed: true, appendNotes: true }], ['import', { confirmed: true }], ['paper', { confirmed: true, title: '禁止失败成卷', questionIds: ['S1'] }], ['correction', { confirmed: true, questionId: 'S1' }]] as const) {
      const rejected = await f.api(`/api/ai/runs/${id}/${action}`, body); assert.equal(rejected.statusCode, 409); assert.equal(rejected.json().error.code, 'AI_RUN_NOT_COMPLETED');
    }
  }
  assert.equal((await f.api('/api/ai/runs?status=failed')).json().length, 3);
  assert.deepEqual((await f.api('/api/ai/runs?status=completed')).json(), []);
  assert.ok(f.requests.every(request => request.stream === false), 'metadata collection must not silently opt JSON calls into streaming');
  assert.equal(f.store.all('study').length, 0); assert.equal(f.store.all('papers').length, 0);
});

test('JSON failures distinguish envelope and generated content with numeric locations only', async t => {
  const f = await fixture(t);
  for (const row of [{ body: '{"choices": }', stage: 'provider_envelope' }, { body: envelope('{"explanationMarkdown": }'), stage: 'json_content' }]) {
    f.mode(() => ({ body: row.body }));
    const response = await f.api('/api/ai/explain', { questionId: 'S1' }); assert.equal(response.statusCode, 502);
    const failure = response.json().error.details.failure;
    assert.equal(failure.code, 'AI_INVALID_JSON'); assert.equal(failure.stage, row.stage);
    if (failure.jsonLocation) assert.ok(Object.values(failure.jsonLocation).every(value => typeof value === 'number'));
    else assert.match(failure.message, /解析器未提供字符位置/);
    const rowInHistory = (await f.api('/api/ai/runs/' + response.headers[AI_AUDIT_HEADER])).json();
    assert.equal(rowInHistory.failure.stage, row.stage); assert.ok(!JSON.stringify(rowInHistory).includes(row.body));
  }
});

test('output schema diagnostics name allowed fields and rules without echoing unknown fields or values', async t => {
  const f = await fixture(t);
  f.mode(() => ({ body: envelope(JSON.stringify({ explanationMarkdown: 7, [secret]: material })) }));
  const response = await f.api('/api/ai/explain', { questionId: 'S1' }); assert.equal(response.statusCode, 502);
  const run = (await f.api('/api/ai/runs/' + response.headers[AI_AUDIT_HEADER])).json();
  assert.equal(run.failure.stage, 'output_schema');
  assert.ok(run.failure.validationIssues.some((issue: any) => issue.path === 'explanationMarkdown' && issue.rule === 'invalid_type'));
  assert.ok(run.failure.validationIssues.some((issue: any) => issue.rule === 'unrecognized_keys'));
  const serialized = JSON.stringify({ response: response.json(), run }); assert.ok(!serialized.includes(secret)); assert.ok(!serialized.includes(material));
});

test('truncation and empty completion remain failures while a valid completion has bounded success diagnostics', async t => {
  const f = await fixture(t);
  f.mode(() => ({ body: envelope('{', 'length') }));
  const truncated = await f.api('/api/ai/explain', { questionId: 'S1' });
  assert.equal(truncated.json().error.code, 'AI_OUTPUT_TRUNCATED'); assert.equal(truncated.json().error.details.diagnostics.finishReason, 'length');
  assert.match(truncated.json().error.message,/4096 Token/);assert.match(truncated.json().error.message,/系统配置/);
  f.mode(() => ({ body: envelope('') }));
  const empty = await f.api('/api/ai/explain', { questionId: 'S1' }); assert.equal(empty.json().error.code, 'AI_EMPTY_RESPONSE');
  f.mode(() => ({ body: envelope(JSON.stringify(valid)) }));
  const good = await f.api('/api/ai/explain', { questionId: 'S1' }); assert.equal(good.statusCode, 200);
  assert.deepEqual(good.json().result, valid); assert.equal(good.json().diagnostics.stage, 'validated');
  assert.equal(good.json().diagnostics.providerCalls, 1); assert.equal(good.json().diagnostics.finishReason, 'stop');
  assert.ok(!JSON.stringify(good.json()).includes(secret)); assert.ok(!JSON.stringify(good.json()).includes(material));
  assert.equal((await f.api('/api/ai/runs?status=failed')).json().length, 2);
  assert.equal((await f.api('/api/ai/runs?status=completed')).json().length, 1);
});

test('invalid local requests and disabled AI do not create misleading provider failure records', async t => {
  const f = await fixture(t);
  await f.api('/api/ai/explain', { questionId: 'missing' });
  await f.api('/api/ai/import', { text: material, count: 0 });
  f.store.database.putRecord('ai_settings', 'local', { ...f.settings, enabled: false });
  assert.equal((await f.api('/api/ai/explain', { questionId: 'S1' })).statusCode, 409);
  assert.equal(f.requests.length, 0); assert.equal(f.store.database.records('ai_runs').length, 0);
});

test('multi-call audit retains successful and failed attempt metadata with batch identity', async t => {
  const f = await fixture(t); f.mode(index => index === 1 ? { body: envelope('{"ok":true}') } : { status: 503, body: secret });
  let captured: unknown;
  try {
    await auditAiOperation(f.store, 'document_generate', async context => {
      await requestAiJson(f.settings, 'first', { ok: true }, { text: material }, z.object({ ok: z.boolean() }), [], context);
      await requestAiJson(f.settings, 'second', { ok: true }, { text: material }, z.object({ ok: z.boolean() }), [], context);
    }, undefined, { jobId: 'job-isolated', batchId: 'chapter-two' });
  } catch (error) { captured = error; }
  const audit = auditedFailure(captured); assert.ok(audit); assert.equal(audit.failure.code, 'AI_PROVIDER_ERROR');
  assert.equal(audit.diagnostics.providerCalls, 2); assert.equal(audit.diagnostics.attempts[0].status, 'completed'); assert.equal(audit.diagnostics.attempts[1].status, 'failed');
  const records = (await f.api('/api/ai/runs?kind=document_generate&status=failed&jobId=job-isolated')).json();
  assert.equal(records.length, 1); assert.equal(records[0].batchId, 'chapter-two'); assert.equal(records[0].result, undefined);
  assert.ok(!JSON.stringify(records).includes(secret)); assert.ok(!JSON.stringify(records).includes(material));
});

test('unexpected post-provider failures are sanitized and remain distinct from successful outputs', async t => {
  const f = await fixture(t);
  let caught: unknown;
  try { await auditAiOperation(f.store, 'import', async context => { await requestAiJson(f.settings, 'explain', {}, {}, z.object({ explanationMarkdown: z.string(), followUpsMarkdown: z.string(), pitfallsMarkdown: z.string() }), [], context); throw new Error(`${secret} ${material}`); }); }
  catch (error) { caught = error; }
  const audit = auditedFailure(caught); assert.ok(audit); assert.equal(audit.failure.code, 'AI_PROCESSING_FAILED'); assert.equal(audit.failure.stage, 'business_validation');
  const records = (await f.api('/api/ai/runs')).json(); assert.equal(records.length, 1); assert.equal(records[0].status, 'failed');
  assert.ok(!JSON.stringify(records).includes(secret)); assert.ok(!JSON.stringify(records).includes(material));
});
