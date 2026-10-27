import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createServer } from 'node:http';
import { Store, now, nextStamp } from '../../server/core/store.js';
import { ApiError, parse, questionSchema } from '../../server/core/validation.js';
import { registerAiRoutes } from '../../server/modules/ai/routes.js';
import { registerSimilarQuestionRoutes } from '../../server/modules/questions/similar-routes.js';
import { aiSimilarQuestionsResultSchema } from '../../server/modules/questions/similar-schema.js';

async function fixture(t: test.TestContext) {
  const store = new Store(':memory:');
  for (const name of ['cs', 'other']) {
    store.put('domains', name, { id: name, name, description: '', sortOrder: 0 });
    store.put('categories', `${name}-cat`, { id: `${name}-cat`, domainId: name, name, description: '', sortOrder: 0, parentId: null });
  }
  store.put('tags', 'python-tag', { id: 'python-tag', name: 'Python', domainId: 'cs', kind: 'topic', description: '', color: '#123456' });
  const put = (id: string, changes: Record<string, unknown> = {}) => {
    const question = { ...parse(questionSchema, { id, title: 'Python变量命名', type: 'short_answer', stemMarkdown: 'Python变量名能否以数字开头？', answerMarkdown: '不能。', explanationMarkdown: '变量名的第一位不允许为数字。', categoryIds: ['cs-cat'], tagIds: ['python-tag'], status: 'published', sourceDocument: 'C:/private/my-source.md', sourceAnchor: 'secret-source-anchor', ...changes }), createdAt: now(), updatedAt: now() };
    store.put('questions', id, question); return question;
  };
  put('Q1'); put('Q2', { title: 'Python变量命名规则' });
  put('OTHER', { title: '大气环流', stemMarkdown: '解释赤道低气压带。', answerMarkdown: '气流上升。', explanationMarkdown: '', categoryIds: ['other-cat'], tagIds: [] });
  put('SAME-CATEGORY', { title: '操作系统时钟中断', stemMarkdown: '时钟中断如何工作？', answerMarkdown: '响应时钟。', tagIds: [] });
  put('PENDING', { status: 'pending' }); put('DRAFT', { status: 'draft' }); put('ARCHIVED', { status: 'archived' });
  store.put('study', 'Q1', { ...store.study('Q1'), notes: 'private-notes-do-not-send' });
  const requests: any[] = [];
  let handler: (input: any) => unknown = input => ({ items: input.untrustedMaterial.candidates.slice(0, 2).map((candidate: any) => ({ questionId: candidate.questionId, reason: '同样考查Python变量的命名规则，可比较不同命名方式。' })) });
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const completion = JSON.parse(Buffer.concat(chunks).toString('utf8')), input = JSON.parse(completion.messages[1].content); requests.push(input);
    const output = handler(input) as any;
    if (output.httpStatus) { response.writeHead(output.httpStatus, { 'Content-Type': 'application/json', Connection: 'close' }); response.end(JSON.stringify({ error: { message: 'private-test-key-provider-body' } })); }
    else { response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' }); response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] })); }
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  store.database.putRecord('ai_settings', 'local', { enabled: true, baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}`, key: 'private-test-key', model: 'test-similar', maxTokens: 4096, timeoutSeconds: 10, supportsImages: false, sendImages: false, updatedAt: now() });
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => error instanceof ApiError ? reply.code(error.status).send({ error: { code: error.code, message: error.message, details: error.details } }) : reply.code(500).send({ error: { code: 'TEST_FAILURE', message: error.message } }));
  registerAiRoutes(app, store); registerSimilarQuestionRoutes(app, store);
  const api = async (url: string, payload?: unknown, status = 200) => { const response = await app.inject({ url, method: payload === undefined ? 'GET' : 'POST', ...(payload === undefined ? {} : { payload }) }); assert.equal(response.statusCode, status, response.body); return response.json(); };
  const recommend = (changes = {}, status = 200) => api('/api/ai/similar-questions', { questionId: 'Q1', confirmed: true, ...changes }, status);
  t.after(async () => { await app.close(); store.database.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); });
  return { store, put, app, api, recommend, requests, handler(value: typeof handler) { handler = value; } };
}

test('similar lookup ranks shared concepts before classification fallback and excludes source/unpublished questions', async t => {
  const f = await fixture(t), result = await f.api('/api/questions/Q1/similar');
  assert.equal(result.items[0].question.id, 'Q2'); assert.match(result.items[0].reason, /关键词/);
  const fallback = result.items.find((item: any) => item.question.id === 'SAME-CATEGORY'); assert.match(fallback.reason, /相同分类/);
  assert.ok(result.items[0].score > fallback.score);
  assert.deepEqual(result.items.map((item: any) => item.question.id).sort(), ['Q2', 'SAME-CATEGORY']);
  assert.match(result.query, /python/); assert.match(result.scope, /未查询互联网/); assert.equal(f.requests.length, 0);
});

test('similar lookup counts and paginates matches in the database with adjustable page size and stable order', async t => {
  const f = await fixture(t); for (let i = 0; i < 25; i++) f.put(`MATCH-${String(i).padStart(2, '0')}`);
  const first = await f.api('/api/questions/Q1/similar?q=Python&page=1&pageSize=10'), third = await f.api('/api/questions/Q1/similar?q=Python&page=3&pageSize=10');
  assert.equal(first.total, 26); assert.equal(first.items.length, 10); assert.equal(third.items.length, 6);
  assert.equal(new Set([...first.items, ...third.items].map(item => item.question.id)).size, 16);
  const past = await f.api('/api/questions/Q1/similar?q=Python&page=10&pageSize=20'); assert.equal(past.total, 26); assert.deepEqual(past.items, []);
  await f.api('/api/questions/Q1/similar?pageSize=15', undefined, 400);
});

test('manual keywords constrain the candidates, preserve literal wildcard text and do not fall back to unrelated taxonomy', async t => {
  const f = await fixture(t); f.put('TCP', { title: 'TCP流量控制', stemMarkdown: 'TCP窗口如何限制发送速率？', tagIds: [] });
  f.put('PERCENT', { title: 'CPU使用率100%', stemMarkdown: '观察CPU使用率100%。', tagIds: [] });
  const tcp = await f.api('/api/questions/Q1/similar?q=TCP'); assert.deepEqual(tcp.items.map((item: any) => item.question.id), ['TCP']);
  const literal = await f.api('/api/questions/Q1/similar?q=%25'); assert.deepEqual(literal.items.map((item: any) => item.question.id), ['PERCENT']);
  const empty = await f.api('/api/questions/Q1/similar?q=no-such-topic'); assert.equal(empty.total, 0);
  await f.api('/api/questions/Q1/similar?q=a+b+c+d+e+f+g+h+i', undefined, 400);
});

test('automatic programming concept extraction preserves C++ and C# rather than matching every occurrence of C', async t => {
  const f = await fixture(t); f.put('CPP', { title: 'C++引用', stemMarkdown: '简述C++引用。', categoryIds: [], tagIds: [] });
  f.put('CPP2', { title: 'C++左值引用', stemMarkdown: '如何使用C++引用？', categoryIds: [], tagIds: [] });
  f.put('CSHARP', { title: 'C#引用', stemMarkdown: '简述C#引用。', categoryIds: [], tagIds: [] });
  const result = await f.api('/api/questions/CPP/similar'); assert.match(result.query, /c\+\+/); assert.equal(result.items[0].question.id, 'CPP2');
});

test('group leaf lookup uses its own prompt, validates leaf identity and allows draft source with only published candidates', async t => {
  const f = await fixture(t);
  f.put('GROUP', { title: '程序阅读', type: 'group', parts: [{ id: 'tcp', title: 'TCP重传', type: 'short_answer', stemMarkdown: '解释TCP超时重传。', answerMarkdown: '重新发送。' }, { id: 'python', title: 'Python作用域', type: 'short_answer', stemMarkdown: '解释Python作用域。', answerMarkdown: '变量可见范围。' }] });
  f.put('TCP-LEAF', { title: 'TCP超时重传机制', stemMarkdown: 'TCP超时后如何重传？', tagIds: [] });
  const leaf = await f.api('/api/questions/GROUP/similar?partId=tcp'); assert.equal(leaf.items[0].question.id, 'TCP-LEAF');
  assert.ok(!leaf.items.some((item: any) => item.question.id === 'GROUP'));
  await f.api('/api/questions/GROUP/similar?partId=deleted', undefined, 404); await f.api('/api/questions/Q1/similar?partId=tcp', undefined, 404);
  await f.api('/api/questions/missing/similar', undefined, 404); await f.api('/api/questions/ARCHIVED/similar', undefined, 404);
  assert.ok((await f.api('/api/questions/DRAFT/similar')).items.every((item: any) => item.question.status === 'published'));
});

test('lookup uses bounded metadata projections and reads full question bodies only for the requested page', async t => {
  const f = await fixture(t); for (let i = 0; i < 120; i++) f.put(`MANY-${i}`, { stemMarkdown: 'Python变量。'.repeat(200) });
  f.store.database.projections.refreshAll();
  const originalAll = f.store.all.bind(f.store), originalRecords = f.store.database.records.bind(f.store.database);
  f.store.all = ((table: any) => { assert.notEqual(table, 'questions'); return originalAll(table); }) as typeof f.store.all;
  f.store.database.records = ((table: any) => { assert.notEqual(table, 'questions'); return originalRecords(table); }) as typeof f.store.database.records;
  const original = f.store.database.all.bind(f.store.database), loaded: number[] = [];
  f.store.database.all = ((query: any) => { const rows = original(query); const compiled = query.compile(); if (/select "id", "data" from "questions"/.test(compiled.sql)) loaded.push(rows.length); return rows; }) as typeof f.store.database.all;
  const page = await f.api('/api/questions/Q1/similar?pageSize=10'); assert.equal(page.items.length, 10); assert.deepEqual(loaded, [10]);
});

test('AI recommends only retrieved question IDs, audits the result and sends no study notes or local source paths', async t => {
  const f = await fixture(t), questions = f.store.database.records('questions'), study = f.store.database.records('study');
  const run = await f.recommend({ requirements: '优先命名规则的变式练习', q: 'Python' });
  assert.equal(run.kind, 'similar_questions'); assert.equal(run.status, 'completed'); assert.equal(run.diagnostics.providerCalls, 1);
  assert.equal(aiSimilarQuestionsResultSchema.safeParse(run.result).success, true); assert.deepEqual(run.result.items.map((item: any) => item.questionId), ['Q2']);
  assert.deepEqual(run.result.candidates.map((item: any) => item.id), ['Q2']);
  const sent = JSON.stringify(f.requests); for (const privateText of ['private-notes-do-not-send', 'C:/private', 'secret-source-anchor', 'private-test-key']) assert.ok(!sent.includes(privateText));
  assert.equal((await f.api(`/api/ai/runs/${run.id}`)).kind, 'similar_questions');
  assert.deepEqual(f.store.database.records('questions'), questions); assert.deepEqual(f.store.database.records('study'), study);
});

test('AI candidate pool remains bounded to 40 and empty local search makes no provider request', async t => {
  const f = await fixture(t); for (let i = 0; i < 80; i++) f.put(`CANDIDATE-${i}`);
  const run = await f.recommend(); assert.equal(run.result.candidates.length, 40); assert.equal(f.requests[0].untrustedMaterial.candidates.length, 40);
  const empty = await f.recommend({ q: 'impossible-keyword' }, 404); assert.equal(empty.error.code, 'AI_SIMILAR_NO_CANDIDATES'); assert.equal(f.requests.length, 1);
  assert.equal(f.store.database.records('ai_runs').length, 1);
});

test('AI duplicate IDs and invented IDs fail with diagnostics and cannot publish a recommendation result', async t => {
  const f = await fixture(t);
  for (const items of [[{ questionId: 'INVENTED', reason: '无效候选' }], [{ questionId: 'Q2', reason: '第一次' }, { questionId: 'Q2', reason: '重复' }]]) {
    f.handler(() => ({ items })); const failed = await f.recommend({}, 502); assert.equal(failed.error.code, 'AI_SIMILAR_INVALID_CANDIDATE');
  }
  const audits = await f.api('/api/ai/runs?kind=similar_questions&status=failed'); assert.equal(audits.length, 2); assert.ok(audits.every((run: any) => !run.result && run.diagnostics.providerCalls === 1));
});

test('concurrent source changes and candidate visibility changes reject stale recommendations with audited reasons', async t => {
  const f = await fixture(t);
  f.handler(input => { const q = f.store.get<any>('questions', 'Q1'); f.store.put('questions', q.id, { ...q, updatedAt: nextStamp(q.updatedAt), title: '修改后的Python题目' }); return { items: [{ questionId: input.untrustedMaterial.candidates[0].questionId, reason: '推荐' }] }; });
  assert.equal((await f.recommend({}, 409)).error.code, 'AI_QUESTION_VERSION_CONFLICT');
  f.handler(() => { const q = f.store.get<any>('questions', 'Q2'); f.store.put('questions', q.id, { ...q, status: 'draft' }); return { items: [{ questionId: 'Q2', reason: '推荐' }] }; });
  assert.equal((await f.recommend({ q: 'Python' }, 409)).error.code, 'AI_SIMILAR_VERSION_CONFLICT');
  assert.equal((await f.api('/api/ai/runs?status=completed')).length, 0);
});

test('provider failures retain concrete safe audit records while preflight validation never calls AI', async t => {
  const f = await fixture(t);
  await f.api('/api/ai/similar-questions', { questionId: 'Q1' }, 400);
  await f.recommend({ requirements: 'a'.repeat(2001) }, 400); assert.equal(f.requests.length, 0);
  f.handler(() => ({ httpStatus: 429 })); const failure = await f.recommend({}, 502); assert.match(failure.error.message, /429/);
  const failed = await f.api('/api/ai/runs?kind=similar_questions&status=failed'); assert.equal(failed.length, 1); assert.equal(failed[0].diagnostics.httpStatus, 429);
  assert.ok(!JSON.stringify(failed).includes('private-test-key')); assert.equal(failed[0].result, undefined);
});

test('similar recommendation supports opt-in SSE progress/result and audited error events', async t => {
  const f = await fixture(t);
  const success = await f.app.inject({ url: '/api/ai/similar-questions', method: 'POST', headers: { accept: 'text/event-stream' }, payload: { questionId: 'Q1', confirmed: true } });
  assert.equal(success.statusCode, 200); assert.match(success.headers['content-type']!, /text\/event-stream/); assert.match(success.body, /"stage":"retrieving"/); assert.match(success.body, /"type":"result"/); assert.match(success.body, /similar_questions/);
  f.handler(() => ({ httpStatus: 429 })); const failed = await f.app.inject({ url: '/api/ai/similar-questions', method: 'POST', headers: { accept: 'text/event-stream' }, payload: { questionId: 'Q1', confirmed: true } });
  assert.match(failed.body, /"type":"error"/); assert.match(failed.body, /"auditId"/); assert.ok(!failed.body.includes('private-test-key'));
});
