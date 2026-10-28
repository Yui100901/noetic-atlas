import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, now } from '../../server/core/store.js';
import { ApiError, parse, questionSchema } from '../../server/core/validation.js';
import { registerAiRoutes } from '../../server/modules/ai/routes.js';
import { registerApiDocs } from '../../server/http/openapi.js';
import { buildApp } from '../../server/index.js';
import { buildPaper, createAttempt, submitAttempt } from '../../server/modules/practice/service.js';
import { subscribeNativeAiProgress, type AiProgressUpdate, type AiStreamEvent } from '../../shared/ai/ai-progress.js';

const explanation = { explanationMarkdown: '事务原子性：全部提交或全部回滚。', followUpsMarkdown: '日志用于故障恢复。', pitfallsMarkdown: '原子性不等于隔离性。' };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function deadline<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Timed out waiting for a real HTTP progress event')), 8000); })]); }
  finally { clearTimeout(timer); }
}

async function fixture(t: test.TestContext, options: { native?: boolean; fullApp?: boolean; result?: unknown; providerStatus?: number } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'noetic-ai-stream-'));
  const store = new Store(join(folder, 'test.sqlite'));
  store.put('domains', 'computer', { id: 'computer', name: '计算机', description: '', sortOrder: 0 });
  store.put('categories', 'transactions', { id: 'transactions', name: '事务', description: '', sortOrder: 0, parentId: null, domainId: 'computer' });
  const question = parse(questionSchema, { id: 'S1', title: '事务原子性', type: 'short_answer', stemMarkdown: '什么是事务原子性？', answerMarkdown: '全部成功或全部失败', categoryIds: ['transactions'], status: 'published', createdAt: now(), updatedAt: now() });
  store.put('questions', 'S1', question);
  store.put('questions', 'P1', { ...question, id: 'P1', status: 'pending' });
  const app = options.fullApp
    ? await buildApp({ databasePath: join(folder, 'test.sqlite'), seedPath: join(folder, 'no-seed.json'), staticRoot: join(folder, 'no-static') })
    : Fastify();
  if (!options.fullApp) {
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ApiError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
      return reply.code(500).send({ error: { code: 'TEST_INTERNAL_ERROR', message: 'Unexpected test handler failure' } });
    });
    await registerApiDocs(app, { native: options.native });
    registerAiRoutes(app, store, { native: options.native });
  }
  const started = deferred(), release = deferred(), closed = deferred();
  const requests: any[] = [];
  const provider = createServer(async (request, response) => {
    response.on('close', closed.resolve);
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    const payload = JSON.stringify(options.result ?? explanation);
    if (options.providerStatus) {
      started.resolve(); await release.promise;
      response.writeHead(options.providerStatus, { 'Content-Type': 'application/json', Connection: 'close' });
      response.end('{"provider_diagnostic":"secret-provider-detail-sk-private"}'); return;
    }
    if (body.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
      const frame = (delta: unknown, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      frame({ reasoning_content: 'PRIVATE_REASONING_MUST_NEVER_REACH_USER' });
      frame({ content: payload.slice(0, 30) });
      started.resolve(); await release.promise;
      if (!response.destroyed) { frame({ content: payload.slice(30) }); frame({}, 'stop'); response.end('data: [DONE]\n\n'); }
    } else {
      started.resolve(); await release.promise;
      response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: payload } }] }));
    }
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    release.resolve(); provider.closeAllConnections(); await app.close(); store.db.close();
    await new Promise<void>(resolve => provider.close(() => resolve()));
    await rm(folder, { recursive: true, force: true });
  });
  const providerPort = (provider.address() as { port: number }).port;
  const enabled = await app.inject({ method: 'PUT', url: '/api/ai/settings', payload: { enabled: true, baseUrl: `http://127.0.0.1:${providerPort}/v1`, model: 'local-stream-test', key: 'secret-local-test-key', supportsImages: false, sendImages: false, timeoutSeconds: 60, maxTokens: 4096 } });
  assert.equal(enabled.statusCode, 200, enabled.body);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const post = (path: string, body: unknown, extra: RequestInit = {}) => fetch(`${origin}${path}`, { method: 'POST', ...extra, headers: { 'Content-Type': 'application/json', ...Object.fromEntries(new Headers(extra.headers)) }, body: JSON.stringify(body) });
  return { store, app, origin, post, requests, started: started.promise, release: release.resolve, closed: closed.promise };
}

function events(response: Response) {
  const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = '';
  async function* read() {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const boundary = buffer.indexOf('\n\n'); if (boundary < 0) break;
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data) yield JSON.parse(data) as AiStreamEvent<any>;
      }
    }
  }
  return read();
}

test('HTTP AI SSE sends status and answer chunks before the provider completes, saves only the final validated result', async t => {
  const f = await fixture(t);
  const response = await deadline(f.post('/api/ai/explain', { questionId: 'S1' }, { headers: { Accept: 'text/event-stream' } }));
  assert.equal(response.status, 200); assert.match(response.headers.get('Content-Type')!, /text\/event-stream/);
  assert.match(response.headers.get('Cache-Control')!, /no-cache/); assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  const iterator = events(response); const first = await deadline(iterator.next());
  assert.equal(first.value.type, 'status'); assert.equal(f.store.database.records('ai_runs').length, 0);
  await deadline(f.started); const received: AiStreamEvent<any>[] = [first.value];
  while (!received.some(event => event.type === 'delta')) { const next = await deadline(iterator.next()); assert.equal(next.done, false); received.push(next.value); }
  assert.equal(f.requests[0].stream, true); assert.equal(f.store.database.records('ai_runs').length, 0);
  f.release(); for await (const event of iterator) received.push(event);
  assert.equal(received.at(-1)!.type, 'result'); const terminal = received.at(-1)!;
  assert.equal(terminal.type, 'result'); if (terminal.type !== 'result') throw new Error('Missing result');
  assert.deepEqual(terminal.result.result, explanation); assert.equal(terminal.result._context, undefined);
  assert.equal(f.store.database.records('ai_runs').length, 1);
  assert.ok(!JSON.stringify(received).includes('PRIVATE_REASONING')); assert.ok(!JSON.stringify(received).includes('secret-local-test-key'));
  assert.equal(received.filter(event => event.type === 'error').length, 0);
});

test('HTTP AI SSE reports schema errors and sanitized provider failures with metadata-only failure history', async t => {
  for (const options of [{ result: { unexpected: true } }, { providerStatus: 429 }]) {
    const f = await fixture(t, options); f.release();
    const response = await f.post('/api/ai/explain', { questionId: 'S1' }, { headers: { Accept: 'text/event-stream' } });
    const received: AiStreamEvent<any>[] = []; for await (const event of events(response)) received.push(event);
    const terminal = received.at(-1)!; assert.equal(terminal.type, 'error');
    if (terminal.type !== 'error') throw new Error('Missing error');
    assert.equal(terminal.error.statusCode, 502); assert.equal(terminal.error.code, 'providerStatus' in options ? 'AI_PROVIDER_ERROR' : 'AI_INVALID_OUTPUT');
    assert.ok(!JSON.stringify(received).includes('secret-provider-detail')); const failures = f.store.database.records<any>('ai_runs'); assert.equal(failures.length, 1); assert.equal(failures[0].status, 'failed'); assert.equal(failures[0].result, undefined);
  }
});

test('disconnecting AI SSE aborts the provider and cannot publish pending questions or save a run', async t => {
  const result = { items: [{ questionId: 'P1', verdict: 'valid', issues: [] }] }, f = await fixture(t, { result });
  const controller = new AbortController();
  const response = await f.post('/api/ai/review', { questionIds: ['P1'], autoApprove: true, expectedUpdatedAt: { P1: f.store.require<any>('questions', 'P1').updatedAt } }, { signal: controller.signal, headers: { Accept: 'text/event-stream' } });
  const iterator = events(response); await deadline(iterator.next()); await deadline(f.started);
  controller.abort(); await deadline(f.closed); f.release();
  // A subsequent HTTP read observes the state only after the abort callback has
  // had a full event-loop turn, rather than relying on a fixed sleep duration.
  const records = await fetch(`${f.origin}/api/ai/runs?status=completed`); assert.deepEqual(await records.json(), []);
  assert.equal(f.store.require<any>('questions', 'P1').status, 'pending');
  await iterator.return(undefined);
});

test('cancelling a rubric-based AI grade aborts the provider without persisting judgments', async t => {
  const result = { items: [{ questionId: 'S1', verdict: 'correct', score: null, maxPoints: null, comment: '回答完整', strengths: [], improvements: [] }] };
  const f = await fixture(t, { result }), controller = new AbortController();
  const response = await f.post('/api/ai/grade', { questionId: 'S1', answer: '整体提交或回滚', gradingRequirements: '允许等价表达；即使取消也请完成判题' }, { signal: controller.signal, headers: { Accept: 'text/event-stream' } });
  const iterator = events(response); await deadline(iterator.next()); await deadline(f.started);
  controller.abort(); await deadline(f.closed); f.release();
  const records = await fetch(`${f.origin}/api/ai/runs?status=completed`); assert.deepEqual(await records.json(), []);
  await iterator.return(undefined);
});

test('legacy JSON AI keeps HTTP error codes and stream:false; q=0 does not opt into SSE', async t => {
  const f = await fixture(t); f.release();
  const response = await f.post('/api/ai/explain', { questionId: 'S1' }, { headers: { Accept: 'text/event-stream;q=0, application/json' } });
  assert.match(response.headers.get('Content-Type')!, /application\/json/); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).result, explanation); assert.equal(f.requests[0].stream, false);
  const invalid = await f.post('/api/ai/explain', { questionId: 'not-found' }); assert.equal(invalid.status, 404);
  assert.equal((await invalid.json()).error.code, 'NOT_FOUND');
});

test('native AI emits live progress but waits for full JSON completion and permits cancellation without writes', async t => {
  const f = await fixture(t, { native: true }); const progress: AiProgressUpdate[] = [];
  const unsubscribe = subscribeNativeAiProgress('native-progress-test', event => progress.push(event)); t.after(unsubscribe);
  let complete = false;
  const pending = f.post('/api/ai/explain', { questionId: 'S1' }, { headers: { Accept: 'text/event-stream', 'x-atlas-ai-progress': 'native-progress-test' } }).then(response => { complete = true; return response; });
  await deadline(f.started); assert.equal(complete, false); assert.equal(progress[0]?.type, 'status'); assert.equal(f.store.database.records('ai_runs').length, 0);
  f.release(); const response = await pending; assert.match(response.headers.get('Content-Type')!, /application\/json/);
  assert.deepEqual((await response.json()).result, explanation); assert.equal(f.store.database.records('ai_runs').length, 1);
  assert.ok(progress.every(event => event.type === 'status' || event.type === 'delta'), 'native success must wait for the JSON response and runtime persistence');

  const cancelled = new AbortController(); cancelled.abort(); const stop = subscribeNativeAiProgress('native-cancelled', () => {}, cancelled.signal); t.after(stop);
  const failed = await f.post('/api/ai/explain', { questionId: 'S1' }, { headers: { 'x-atlas-ai-progress': 'native-cancelled' } });
  assert.equal(failed.status, 499); assert.equal((await failed.json()).error.code, 'AI_CANCELLED'); assert.equal(f.requests.length, 1);

  const during = await fixture(t, { native: true }); const activeController = new AbortController();
  const stopActive = subscribeNativeAiProgress('native-cancel-in-progress', () => {}, activeController.signal); t.after(stopActive);
  const activeRequest = during.post('/api/ai/explain', { questionId: 'S1' }, { headers: { 'x-atlas-ai-progress': 'native-cancel-in-progress' } });
  await deadline(during.started); activeController.abort(); await deadline(during.closed); during.release();
  const interrupted = await activeRequest; assert.equal(interrupted.status, 499); assert.equal((await interrupted.json()).error.code, 'AI_CANCELLED');
  assert.equal(during.store.database.records<any>('ai_runs').filter(run => run.status === 'completed').length, 0); assert.equal(during.store.database.records<any>('ai_runs')[0]?.status, 'cancelled');
});

test('SSE still respects same-origin and active-exam guards; OpenAPI declares JSON and event-stream', async t => {
  const f = await fixture(t, { fullApp: true });
  const forbidden = await f.post('/api/ai/explain', { questionId: 'S1' }, { headers: { Origin: 'https://attacker.invalid', Accept: 'text/event-stream' } });
  assert.equal(forbidden.status, 403); assert.equal((await forbidden.json()).error.code, 'CROSS_ORIGIN_REJECTED'); assert.equal(f.requests.length, 0);
  const doc: any = await (await fetch(`${f.origin}/api/openapi.json`)).json();
  for (const path of ['/api/ai/test','/api/ai/explain','/api/ai/grade','/api/ai/import','/api/ai/review','/api/ai/paper-plan','/api/attempts/{id}/ai-review']) {
    assert.ok(doc.paths[path].post.responses[200].content['text/event-stream'], path);
    assert.ok(doc.paths[path].post.responses[200].content['application/json'], path);
  }
  assert.ok(doc.components.schemas.AiProgressEvent);
  const paper = await f.app.inject({ method: 'POST', url: '/api/papers', payload: { title: '考试锁校验', mode: 'manual', questionIds: ['S1'] } }); assert.equal(paper.statusCode, 201, paper.body);
  const attempt = await f.app.inject({ method: 'POST', url: `/api/papers/${paper.json().id}/attempts`, payload: { mode: 'exam' } }); assert.equal(attempt.statusCode, 201, attempt.body);
  const locked = await f.post('/api/ai/explain', { questionId: 'S1' }, { headers: { Accept: 'text/event-stream' } });
  assert.equal(locked.status, 409); assert.equal((await locked.json()).error.code, 'EXAM_ACTIVE'); assert.equal(f.requests.length, 0);
});

test('connection, import, review and both grading endpoints deliver structured validated results over SSE', async t => {
  const gradeResult = { extraMetadata:'PRIVATE_GRADE_EXTRA',items: [{ questionId: 'S1',verdict:'partial', score: null, maxPoints: null, comment: '解释基本正确，可补充故障恢复的例子。', strengths: ['核心定义正确'], improvements: ['补充例子'],requiresRegrade:false,answer:'PRIVATE_GRADE_EXTRA' }] };
  const cases = [
    { path: '/api/ai/test', body: {}, result: { ok: true, message: '连接成功' }, kind: undefined },
    { path: '/api/ai/import', body: { text: '事务保证操作全部成功或全部失败。', count: 1 }, result: { questions: [{ title: '原子性', type: 'short_answer', stemMarkdown: '什么是原子性？', answerMarkdown: '全部成功或全部失败', categoryIds: ['transactions'] }], taxonomySuggestions: { domains: [], categories: [], tags: [] } }, kind: 'import' },
    { path: '/api/ai/review', body: { questionIds: ['P1'], autoApprove: true }, result: { items: [{ questionId: 'P1', verdict: 'valid', issues: [] }] }, kind: 'review' },
    { path: '/api/ai/grade', body: { questionId: 'S1', answer: '全部成功或全部失败' }, result: gradeResult, kind: 'grade' },
    { path: '/api/attempts/:id/ai-review', body: {}, result: gradeResult, kind: 'grade' },
  ];
  for (const item of cases) {
    const f = await fixture(t, { result: item.result }); let path = item.path; let body: any = item.body;
    if (item.kind === 'review') body = { ...body, expectedUpdatedAt: { P1: f.store.require<any>('questions', 'P1').updatedAt } };
    if (path.includes('/:id/')) {
      const paper = buildPaper(f.store, { title: 'AI 流式阅卷', mode: 'manual', questionIds: ['S1'], scoring: { enabled: false } });
      f.store.put('papers', paper.id, paper); const attempt = createAttempt(f.store, paper);
      submitAttempt(f.store, attempt, { S1: { value: '全部成功或全部失败' } }); path = path.replace(':id', attempt.id);
    }
    f.release(); const response = await f.post(path, body, { headers: { Accept: 'text/event-stream' } });
    const received: AiStreamEvent<any>[] = []; for await (const event of events(response)) received.push(event);
    const terminal = received.at(-1)!; assert.equal(terminal.type, 'result', `${path}: ${JSON.stringify(received)}`);
    if (terminal.type !== 'result') throw new Error('Missing result');
    if (item.kind) { assert.equal(terminal.result.kind, item.kind); assert.equal(f.store.database.records('ai_runs').length, 1); }
    else { assert.equal(terminal.result.ok, true); assert.equal(f.store.database.records('ai_runs').length, 0); }
    if (item.kind === 'import') { assert.equal(terminal.result.result.questions[0].status, 'pending'); assert.equal(f.store.database.records('questions').length, 2, 'conversion must still await explicit import'); }
    if (item.kind === 'review') assert.equal(f.store.require<any>('questions', 'P1').status, 'published');
    if (item.kind === 'grade') {assert.equal(terminal.result.result.items[0].verdict,'partial');assert.equal(terminal.result.result.items[0].requiresRegrade,undefined);assert.ok(terminal.result.warnings.some((value:string)=>value.includes('非判题字段')));assert.doesNotMatch(JSON.stringify(terminal.result),/PRIVATE_GRADE_EXTRA/);}
  }
});
