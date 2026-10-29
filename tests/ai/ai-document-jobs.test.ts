import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import Fastify from 'fastify';
import { Store } from '../../server/core/store.js';
import { ApiError } from '../../server/core/validation.js';
import { registerAiRoutes } from '../../server/modules/ai/routes.js';
import { registerAiDocumentRoutes } from '../../server/modules/ai/document-routes.js';
import { documentJob, processDocumentJob } from '../../server/modules/ai/document-service.js';
import { validateStoredAiDocumentJob } from '../../server/modules/ai/document-schema.js';
import { registerAssetRoutes } from '../../server/modules/assets/routes.js';
import { assetIsReferenced, validateAllAssetReferences } from '../../server/modules/assets/service.js';

async function fixture(t: test.TestContext) {
  const store = new Store(':memory:');
  store.put('domains', 'computer', { id: 'computer', name: '计算机', description: '', sortOrder: 0 });
  store.put('categories', 'python', { id: 'python', domainId: 'computer', parentId: null, name: 'Python', description: '', sortOrder: 0 });
  const requests: Array<{ stage: string; label: string; text: string; path: string; stream: boolean }> = [];
  const failing = new Map<string, 'http' | 'json' | 'empty'>();
  const gates = new Map<string, { wait: Promise<void>; release(): void }>();
  let duplicate = false, invalidImage = false, managedImageId = '';
  const provider = createServer(async (request, response) => {
    const body: Buffer[] = []; for await (const chunk of request) body.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(body).toString('utf8'));
    const material = JSON.parse(input.messages[1].content);
    const stage = material.task.includes('总结本次资料块') ? 'plan' : 'generate';
    const label = material.untrustedMaterial.label;
    requests.push({ stage, label, text: material.untrustedMaterial.text, path: request.url!, stream: input.stream });
    await gates.get(label)?.wait;
    const problem = failing.get(`${stage}:${label}`);
    if (problem === 'http') { response.writeHead(429, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: 'secret-provider-detail DO_NOT_LEAK test-key' })); return; }
    const question = { title: `练习${label}`, type: 'short_answer', stemMarkdown: managedImageId ? `根据图片回答 ![托管图](/api/assets/${managedImageId}/content)` : invalidImage ? '根据图片回答 ![虚构图](/api/assets/missing-book-diagram/content)' : duplicate ? '重复的变量问题？' : `${label}：变量绑定的含义是什么？`, answerMarkdown: '名称引用一个值。', explanationMarkdown: '根据本块关于变量与赋值的说明。', difficulty: 2, categoryIds: [], tagIds: [] };
    const value = stage === 'plan' ? { title: `主题${label}`, summary: '本块讲解变量名称和值的绑定关系。', topics: ['变量', '赋值'] } : { questions: [question], taxonomySuggestions: { domains: ['计算机'], categories: ['Python'], tags: ['变量'] } };
    const content = problem === 'json' ? '{"questions": [BROKEN' : problem === 'empty' ? '' : JSON.stringify(value);
    if (input.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: content.slice(0, 20) } }] }) + '\n\n');
      response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: content.slice(20) }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }));
    }
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
  const app = Fastify({ bodyLimit: 16_000_000 });
  app.setErrorHandler((reason, _request, reply) => reason instanceof ApiError ? reply.code(reason.status).send({ error: { code: reason.code, message: reason.message, details: reason.details } }) : reply.code(500).send({ error: { code: 'INTERNAL', message: reason.message } }));
  registerAiRoutes(app, store); registerAiDocumentRoutes(app, store); registerAssetRoutes(app, store);
  const api = async (path: string, payload?: unknown, expected = 200, method?: 'GET' | 'POST' | 'DELETE') => {
    const response = await app.inject({ url: path, method: method || (payload === undefined ? 'GET' : 'POST'), ...(payload === undefined ? {} : { payload }) });
    assert.equal(response.statusCode, expected, response.body); return response.json();
  };
  await app.inject({ url: '/api/ai/settings', method: 'PUT', payload: { enabled: true, baseUrl: address, model: 'isolated-document-model', key: 'test-key', supportsImages: false, sendImages: false, timeoutSeconds: 10, maxTokens: 4096 } });
  t.after(async () => { gates.forEach(gate => gate.release()); await app.close(); store.db.close(); await new Promise<void>(resolve => provider.close(() => resolve())); });
  const create = (changes = {}) => api('/api/ai/document-jobs', { confirmed: true, sourceName: '教材.pdf', sourceUrl: address + '/never-fetch.pdf', sections: [{ label: 'A', text: 'SOURCE_CANARY_A：变量名称引用值。', pageStart: 1, pageEnd: 3 }, { label: 'B', text: 'SOURCE_CANARY_B：赋值更新绑定。', pageStart: 4, pageEnd: 6 }], categoryIds: ['python'], mode: 'generate', questionsPerBlock: 2, maxQuestions: 20, questionTypes: ['short_answer'], difficulty: 2, ...changes }, 201);
  return { app, store, api, requests, failing, create, managedImage: (value: string) => { managedImageId = value; }, duplicate: (value: boolean) => { duplicate = value; }, invalidImage: (value: boolean) => { invalidImage = value; }, hold(label: string) { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); gates.set(label, { wait, release }); return release; } };
}
const ids = (job: any) => job.blocks.map((block: any) => block.id);
const path = (job: any, action = '') => `/api/ai/document-jobs/${job.id}${action ? '/' + action : ''}`;

test('generated textbook candidates protect managed images before import and release references on edits, rollback and deletion', async t => {
  const f = await fixture(t);
  const image = await f.api('/api/assets', { filename: '教材示意图.png', mimeType: 'image/png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=' }, 201);
  f.managedImage(image.id);
  const job = await f.create({ sections: [{ label: 'A', text: '仅供测试的图解教材。' }], maxQuestions: 2 });
  await f.api(path(job, 'plan'), { blockIds: ids(job) });
  const generated = await f.api(path(job, 'generate'), { blockIds: ids(job) });
  assert.equal(generated.questionCount, 1); assert.equal(f.store.all('questions').length, 0);
  const original = documentJob(f.store, job.id); validateStoredAiDocumentJob(original); validateAllAssetReferences(f.store);
  assert.equal((await f.api('/api/assets'))[0].referenced, true);
  await f.api('/api/assets/' + image.id, undefined, 409, 'DELETE');
  assert.throws(() => f.store.transaction(() => {
    const changed = structuredClone(original); changed.blocks[0]!.questions = [];
    f.store.database.putRecord('ai_import_jobs', job.id, changed);
    assert.equal(assetIsReferenced(f.store, image.id), false);
    throw Error('rollback candidate removal');
  }), /rollback candidate removal/);
  assert.equal(assetIsReferenced(f.store, image.id), true);
  const edited = structuredClone(original); edited.blocks[0]!.questions![0]!.stemMarkdown = '移除图片后的教材候选题';
  f.store.database.putRecord('ai_import_jobs', job.id, edited);
  assert.equal((await f.api('/api/assets'))[0].referenced, false);
  f.store.database.putRecord('ai_import_jobs', job.id, original);
  assert.equal(assetIsReferenced(f.store, image.id), true);
  await f.api(path(job), undefined, 200, 'DELETE');
  assert.equal((await f.api('/api/assets'))[0].referenced, false);
  await f.api('/api/assets/' + image.id, undefined, 200, 'DELETE');
});

test('document tasks retain confirmed private source chunks, bounded Unicode and pure public summaries', async t => {
  const f = await fixture(t);
  const source = '变量🙂'.repeat(4000);
  const job = await f.create({ sections: [{ label: '长章', text: source, pageStart: 31, pageEnd: 35 }] });
  assert.equal(f.requests.length, 0); assert.ok(job.blocks.length > 1);
  assert.ok(job.blocks.every((block: any) => block.characters <= 12000 && !Object.hasOwn(block, 'text')));
  const privateJob = documentJob(f.store, job.id);
  assert.equal(privateJob.blocks.map(block => block.text).join(''), source);
  assert.ok(privateJob.blocks.every(block => !/[\uD800-\uDBFF]$/.test(block.text)));
  assert.deepEqual(validateStoredAiDocumentJob(privateJob), privateJob);
  const originalRecords = f.store.database.records.bind(f.store.database);
  f.store.database.records = ((table: any) => { assert.notEqual(table, 'ai_import_jobs', 'list must not deserialize all private source bodies'); return originalRecords(table); }) as typeof f.store.database.records;
  const before = JSON.stringify(privateJob), detail = await f.api(path(job)), list = await f.api('/api/ai/document-jobs?page=1&pageSize=10');
  f.store.database.records = originalRecords;
  assert.equal(list.total, 1); assert.ok(!Object.hasOwn(list.items[0], 'blocks'));
  assert.doesNotMatch(JSON.stringify(detail), /变量🙂/); assert.equal(JSON.stringify(documentJob(f.store, job.id)), before);
  assert.equal(f.store.all('questions').length, 0);
  await f.api('/api/ai/document-jobs', { confirmed: false, sourceName: 'x', sections: [{ text: '正文' }] }, 400);
  await f.api('/api/ai/document-jobs', { confirmed: true, sourceName: 'x', sourceUrl: 'file:///secret', sections: [{ text: '正文' }] }, 400);
  await f.api('/api/ai/document-jobs', { confirmed: true, sourceName: 'x', sections: [{ text: '正文', pageStart: 5, pageEnd: 2 }] }, 400);
  await f.api('/api/ai/document-jobs', { confirmed: true, sourceName: 'x', sections: [{ text: ' ' }] }, 400);
  await f.api('/api/ai/document-jobs', { confirmed: true, sourceName: 'x', sections: [{ text: '正文' }], questionsPerBlock: 10, maxQuestions: 2 }, 400);
});

test('planning targets selected material only and generated previews require a completed plan', async t => {
  const f = await fixture(t), job = await f.create(), [a, b] = ids(job);
  await f.api(path(job, 'generate'), { blockIds: [a] }, 409); assert.equal(f.requests.length, 0);
  const planned = await f.api(path(job, 'plan'), { blockIds: [a] });
  assert.equal(planned.plannedBlocks, 1); assert.equal(planned.blocks[1].planStatus, 'pending');
  assert.match(f.requests[0]!.text, /SOURCE_CANARY_A/); assert.doesNotMatch(f.requests[0]!.text, /SOURCE_CANARY_B/);
  const generated = await f.api(path(job, 'generate'), { blockIds: [a] });
  assert.equal(generated.questionCount, 1); assert.equal(f.store.all('questions').length, 0);
  assert.deepEqual(generated.blocks[0].questions[0].categoryIds, ['python']);
  assert.equal(generated.blocks[0].questions[0].status, 'pending'); assert.match(generated.blocks[0].questions[0].sourceAnchor, /31|第?1|A/);
  assert.ok(f.requests.every(request => request.path === '/chat/completions'));
  assert.doesNotMatch(JSON.stringify(f.store.database.records('ai_runs')), /SOURCE_CANARY_A|SOURCE_CANARY_B|test-key/);
  const count = f.requests.length;
  await f.api(path(job, 'plan'), { blockIds: [a] }); await f.api(path(job, 'generate'), { blockIds: [a] });
  assert.equal(f.requests.length, count, 'successful blocks must not be resubmitted');
  await f.api(path(job, 'plan'), { blockIds: [b, 'foreign-block'] }, 400); assert.equal(f.requests.length, count);
});

test('partial plan failure preserves successful blocks and audited reasons; retry submits failed block only', async t => {
  const f = await fixture(t), job = await f.create();
  f.failing.set('plan:B', 'http');
  const partial = await f.api(path(job, 'plan'), { blockIds: ids(job) });
  assert.equal(partial.status, 'partial'); assert.equal(partial.plannedBlocks, 1); assert.equal(partial.failedBlocks, 1);
  const failure = partial.blocks[1].planFailure;
  assert.equal(failure.code, 'AI_PROVIDER_ERROR'); assert.match(failure.message, /429/); assert.ok(failure.auditId);
  const run = await f.api('/api/ai/runs/' + failure.auditId);
  assert.equal(run.status, 'failed'); assert.equal(run.jobId, job.id); assert.equal(run.batchId, job.blocks[1].id); assert.equal(run.diagnostics.httpStatus, 429); assert.ok(!Object.hasOwn(run, 'result'));
  assert.doesNotMatch(JSON.stringify([partial, run]), /secret-provider-detail|DO_NOT_LEAK|test-key|SOURCE_CANARY/);
  await f.api(path(job, 'plan'), { blockIds: ids(job) }); assert.equal(f.requests.length, 2);
  f.failing.delete('plan:B');
  const retried = await f.api(path(job, 'plan'), { blockIds: ids(job), retryFailed: true });
  assert.equal(f.requests.length, 3); assert.equal(retried.plannedBlocks, 2); assert.equal(retried.failedBlocks, 0);
  assert.equal(retried.blocks[0].planAttempts, 1); assert.equal(retried.blocks[1].planAttempts, 2);
  assert.equal((await f.api('/api/ai/runs/' + failure.auditId)).status, 'failed', 'retry must retain earlier failure');
});

test('generation failures retain other previews, explicit retry and atomic pending import', async t => {
  const f = await fixture(t), job = await f.create();
  await f.api(path(job, 'plan'), { blockIds: ids(job) }); f.failing.set('generate:B', 'json');
  const partial = await f.api(path(job, 'generate'), { blockIds: ids(job) });
  assert.equal(partial.generatedBlocks, 1); assert.equal(partial.questionCount, 1); assert.equal(partial.blocks[1].generationFailure.code, 'AI_INVALID_JSON');
  const oldPreview = partial.blocks[0].questions, before = f.requests.length;
  await f.api(path(job, 'generate'), { blockIds: ids(job) }); assert.equal(f.requests.length, before);
  f.failing.delete('generate:B');
  const complete = await f.api(path(job, 'generate'), { blockIds: ids(job), retryFailed: true });
  assert.equal(f.requests.length, before + 1); assert.deepEqual(complete.blocks[0].questions, oldPreview); assert.equal(complete.questionCount, 2);
  assert.equal(f.store.all('questions').length, 0);
  await f.api(path(job, 'import'), { confirmed: false, blockIds: ids(job) }, 400);
  const invalid = { ...complete.blocks[1].questions[0], type: 'single_choice', options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }], correctAnswers: ['C'] };
  await f.api(path(job, 'import'), { confirmed: true, blockIds: ids(job), questions: [{ blockId: job.blocks[1].id, questions: [invalid] }] }, 400);
  assert.equal(f.store.all('questions').length, 0);
  const imported = await f.api(path(job, 'import'), { confirmed: true, blockIds: ids(job), questions: [{ blockId: job.blocks[0].id, questions: [{ ...complete.blocks[0].questions[0], title: '人工修改标题' }] }] });
  assert.equal(imported.added, 2); assert.equal(imported.items[0].title, '人工修改标题'); assert.ok(imported.items.every((question: any) => question.status === 'pending'));
  assert.match(imported.items[0].sourceAnchor, /PDF文件页1—3/);
  assert.equal(imported.job.status, 'completed'); assert.deepEqual(validateStoredAiDocumentJob(documentJob(f.store, job.id)), documentJob(f.store, job.id));
  await f.api(path(job, 'import'), { confirmed: true, blockIds: ids(job) }, 409); assert.equal(f.store.all('questions').length, 2);
});

test('concurrent operations conflict, GET never changes running work, and interrupted blocks can resume', async t => {
  const f = await fixture(t), job = await f.create(), release = f.hold('A');
  const first = f.api(path(job, 'plan'), { blockIds: [job.blocks[0].id] });
  while (!f.requests.length) await new Promise(resolve => setTimeout(resolve, 5));
  await f.api(path(job, 'plan'), { blockIds: [job.blocks[1].id] }, 409);
  await f.api(path(job), undefined, 409, 'DELETE');
  const running = JSON.stringify(documentJob(f.store, job.id)); await f.api(path(job)); assert.equal(JSON.stringify(documentJob(f.store, job.id)), running);
  release(); await first;
  const interrupted = documentJob(f.store, job.id); interrupted.blocks[1]!.planStatus = 'running'; interrupted.status = 'running'; f.store.database.putRecord('ai_import_jobs', job.id, interrupted);
  const resumed = await f.api(path(job, 'plan'), { blockIds: [job.blocks[1].id] });
  assert.equal(resumed.plannedBlocks, 2); assert.equal(resumed.blocks[1].planStatus, 'completed');
});

test('whole-batch failures remain in SSE job results and history, without private provider bodies', async t => {
  const f = await fixture(t), job = await f.create();
  f.failing.set('plan:A', 'http'); f.failing.set('plan:B', 'http');
  const response = await f.app.inject({ method: 'POST', url: path(job, 'plan'), headers: { accept: 'text/event-stream' }, payload: { blockIds: ids(job) } });
  assert.equal(response.statusCode, 200);
  const events = response.body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  const result = events.find(event => event.type === 'result').result;
  assert.equal(result.status, 'failed'); assert.equal(result.failedBlocks, 2);
  const runs = await f.api('/api/ai/runs?kind=document_plan'); assert.equal(runs.length, 2); assert.ok(runs.every((run: any) => run.status === 'failed'));
  assert.doesNotMatch(response.body + JSON.stringify(runs), /secret-provider-detail|DO_NOT_LEAK|test-key|SOURCE_CANARY/);
  assert.equal(f.store.all('questions').length, 0);
});

test('question budgets, cross-block duplicates and corrupt restored job states fail closed', async t => {
  const f = await fixture(t), job = await f.create({ maxQuestions: 3 });
  await f.api(path(job, 'plan'), { blockIds: ids(job) });
  const before = f.requests.length;
  await f.api(path(job, 'generate'), { blockIds: ids(job) }, 400); assert.equal(f.requests.length, before);
  const covered = await f.api(path(job, 'generate'), { blockIds: ids(job), questionsPerBlock: 1 });
  assert.equal(covered.generatedBlocks, 2); assert.equal(covered.questionCount, 2); assert.ok(covered.blocks.every((block: any) => block.generationQuestionLimit === 1));
  const other = await f.create(); await f.api(path(other, 'plan'), { blockIds: ids(other) }); f.duplicate(true);
  const partial = await f.api(path(other, 'generate'), { blockIds: ids(other) });
  assert.equal(partial.questionCount, 1); assert.equal(partial.failedBlocks, 1); assert.equal(partial.blocks[1].generationFailure.code, 'AI_DOCUMENT_DUPLICATE');
  const saved = documentJob(f.store, other.id); validateStoredAiDocumentJob(saved);
  for (const mutate of [
    (value: any) => { value.blocks[0].characters++; }, (value: any) => { value.blocks[1].id = value.blocks[0].id; },
    (value: any) => { value.questionCount++; }, (value: any) => { value.status = 'completed'; },
    (value: any) => { value.blocks[0].questions[0].status = 'published'; },
  ]) { const value = structuredClone(saved); mutate(value); assert.throws(() => validateStoredAiDocumentJob(value)); }
  f.invalidImage(true); const bad = await f.create();
  await f.api(path(bad, 'plan'), { blockIds: ids(bad) });
  const rejected = await f.api(path(bad, 'generate'), { blockIds: ids(bad) });
  assert.equal(rejected.questionCount, 0); assert.ok(rejected.blocks.every((block: any) => block.generationFailure.code === 'AI_DOCUMENT_INVALID_ASSET'));
  assert.ok(rejected.blocks.every((block: any) => block.generationFailure.auditId)); validateStoredAiDocumentJob(documentJob(f.store, bad.id));
});

test('explicit cancellation stops the current provider, preserves earlier complete summaries and audits cancelled batch', async t => {
  const f = await fixture(t), job = await f.create();
  await f.api(path(job, 'plan'), { blockIds: [job.blocks[0].id] });
  const release = f.hold('B'), controller = new AbortController();
  const response = processDocumentJob(f.store, job.id, 'plan', { blockIds: ids(job) }, { emit() {}, signal: controller.signal });
  while (!f.requests.some(request => request.label === 'B')) await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort(); release(); const stopped = await response;
  assert.equal(stopped.plannedBlocks, 1); assert.equal(stopped.blocks[0].planStatus, 'completed'); assert.equal(stopped.blocks[1].planStatus, 'cancelled');
  const run = f.store.database.getRecord<any>('ai_runs', stopped.blocks[1].planFailure!.auditId!);
  assert.equal(run.status, 'cancelled'); assert.ok(!Object.hasOwn(run, 'result'));
});
