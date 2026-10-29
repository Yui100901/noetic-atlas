import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import initSqlJs from 'sql.js';
import { loadNativeRuntime } from '../helpers/native-runtime.js';
import { LocalApp } from '../../mobile/shims/fastify.ts';
import { readOnlyOperation } from '../../server/http/operation.js';
import { learningSeed } from '../fixtures/learning-seed.js';

test('native persistence effects follow matched route declarations and undeclared mutations remain writes', async () => {
  const app = new LocalApp();
  app.post('/api/items/:id/preview', readOnlyOperation, request => request.params);
  app.post('/api/items/:id', () => ({ saved: true }));
  assert.equal(app.storageEffect('POST', '/api/items/a%20b/preview?extra=1'), 'read');
  assert.equal(app.storageEffect('PUT', '/api/items/a/preview'), undefined);
  assert.equal(app.storageEffect('POST', '/api/items/a'), undefined);
  assert.equal(app.storageEffect('POST', '/api/items/a/preview/extra'), undefined);
  assert.equal(app.storageEffect('POST', 'https://example.invalid/api/items/a/preview'), undefined);
  assert.equal(app.storageEffect('POST', '/api/items/%/preview'), undefined);
  assert.deepEqual(await (await app.inject('/api/items/a%20b/preview', { method: 'POST' })).json(), { id: 'a b' });
});

test('native read-only POSTs stay usable on read-only storage while mutations, exam locks and candidate image protection stay durable', async t => {


  const { createLocalRuntime } = await loadNativeRuntime();
  const sql = await initSqlJs({ locateFile: () => resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  let durable: Uint8Array | undefined, failSave = false, saves = 0;
  const storage = { async load() { return durable?.slice(); }, async save(bytes: Uint8Array) { saves++; if (failSave) throw Error('read-only storage fixture'); durable = bytes.slice(); } };
  const seed = learningSeed({ includeNonPublic: true });
  let runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false });
  t.after(() => runtime.close());
  const api = async (path: string, method = 'GET', payload?: unknown, expected = 200) => {
    const response = await runtime.fetch(path, { method, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value as any;
  };
  const input = { title: '只读预览', mode: 'manual', questionIds: ['FIXTURE-BOOL'], scoring: { enabled: false } };
  const paper = await api('/api/papers', 'POST', input, 201);
  const configuration = await api('/api/settings/export');
  const share = await api('/api/sharing/export', 'POST', { kind: 'questions', ids: ['FIXTURE-BOOL'] });
  const queries: Array<[string, unknown]> = [
    ['/api/questions/metadata', { ids: ['FIXTURE-BOOL'] }],
    ['/api/questions/pending/export', { ids: ['FIXTURE-PENDING'] }],
    ['/api/learning/card-summaries', { paperIds: [paper.id] }],
    ['/api/question-feedback/summaries', { questionIds: ['FIXTURE-BOOL'] }],
    ['/api/settings/import/preview', { data: configuration }],
    ['/api/sharing/export', { kind: 'questions', ids: ['FIXTURE-BOOL'] }],
    ['/api/sharing/preview', { data: share }],
    ['/api/sharing/export-document', { kind: 'questions', ids: ['FIXTURE-BOOL'] }],
    ['/api/papers/preview', input],
  ];
  await t.test('all declared JSON queries avoid storage saves, retain validation, and do not persist preview papers', async () => {
    const before = durable!.slice(), baseline = saves; failSave = true;
    for (const [path, payload] of queries) await api(path + '?audit=read', 'POST', payload);
    assert.equal(saves, baseline); assert.deepEqual(durable, before);
    assert.equal((await api('/api/papers')).length, 1);
    assert.equal((await api('/api/questions/FIXTURE-PENDING')).status, 'pending');
    await api('/api/questions/metadata', 'POST', { ids: [] }, 400);
    assert.equal(saves, baseline);
    const forbidden = await runtime.fetch('/api/sharing/export', { method: 'POST', headers: { origin: 'https://elsewhere.invalid' }, body: JSON.stringify({ kind: 'questions', ids: ['FIXTURE-BOOL'] }) });
    assert.equal(forbidden.status, 403); assert.equal(saves, baseline);
    await api('/api/documents', 'POST', { title: '不得确认未落盘修改', bodyMarkdown: 'not durable' }, 507);
    assert.equal(saves, baseline + 1); assert.equal((await api('/api/documents')).length, 0); assert.deepEqual(durable, before);
    failSave = false;
  });
  await t.test('read declarations never bypass application-wide exam locks', async () => {
    const attempt = await api('/api/papers/' + paper.id + '/attempts', 'POST', { mode: 'exam', durationMinutes: 120 }, 201);
    const baseline = saves, before = durable!.slice(); failSave = true;
    for (const [path, payload] of queries) assert.equal((await api(path, 'POST', payload, 409)).error.code, 'EXAM_ACTIVE');
    assert.equal(saves, baseline); assert.deepEqual(durable, before); failSave = false;
    await api('/api/attempts/' + attempt.id + '/submit', 'POST', { answers: {} });
  });
  await t.test('unimported textbook candidates retain image delete protection through rollback, restart and task deletion', async () => {
    let imageId = '';
    const provider = createServer(async (request, response) => {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const input = JSON.parse(raw), task = JSON.parse(input.messages[1].content).task;
      const result = task.startsWith('总结') ? { title: '图解概念', summary: '通过图片理解概念。', topics: ['图解'] }
        : { questions: [{ title: '看图解释', type: 'short_answer', stemMarkdown: `说明图片 ![图](/api/assets/${imageId}/content)`, answerMarkdown: '合成图解答案' }], taxonomySuggestions: { domains: [], categories: [], tags: [] } };
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }));
    });
    await new Promise<void>(done => provider.listen(0, '127.0.0.1', done));
    try {
      await api('/api/ai/settings', 'PUT', { enabled: true, baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}`, key: 'fixture-only', model: 'fixture', supportsImages: false, sendImages: false, timeoutSeconds: 10, maxTokens: 4096 });
      imageId = (await api('/api/assets', 'POST', { filename: '教材.png', mimeType: 'image/png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=' }, 201)).id;
      const job = await api('/api/ai/document-jobs', 'POST', { confirmed: true, sourceName: '合成教材', sections: [{ text: '用图片解释该概念。' }], questionsPerBlock: 1, maxQuestions: 1 }, 201);
      const path = '/api/ai/document-jobs/' + job.id, blockIds = job.blocks.map((block: any) => block.id);
      await api(path + '/plan', 'POST', { blockIds });
      const before = durable!.slice(); failSave = true;
      await api(path + '/generate', 'POST', { blockIds }, 507); failSave = false;
      assert.deepEqual(durable, before); assert.equal((await api('/api/assets'))[0].referenced, false);
      assert.equal((await api(path + '/generate', 'POST', { blockIds })).questionCount, 1);
      assert.equal((await api('/api/assets'))[0].referenced, true);
      assert.equal((await api('/api/assets/' + imageId, 'DELETE', undefined, 409)).error.code, 'ASSET_IN_USE');
      await runtime.close(); runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false });
      assert.equal((await api('/api/assets'))[0].referenced, true);
      await api('/api/assets/' + imageId, 'DELETE', undefined, 409);
      failSave = true; await api(path, 'DELETE', undefined, 507); failSave = false;
      assert.equal((await api('/api/assets'))[0].referenced, true);
      await api(path, 'DELETE'); assert.equal((await api('/api/assets'))[0].referenced, false);
      await api('/api/assets/' + imageId, 'DELETE');
    } finally { await new Promise<void>(done => provider.close(() => done())); }
  });
});
