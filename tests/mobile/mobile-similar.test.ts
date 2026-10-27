import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import initSqlJs from 'sql.js';
import { build } from 'vite';
import { nativeAliases } from '../../mobile/vite-aliases.ts';

test('native similar-question discovery preserves learning state and durable AI audit history', async t => {
  const folder = resolve('test-results/native-similar'); await mkdir(folder, { recursive: true });
  await build({ configFile: false, logLevel: 'error', define: { 'process.env': '{}' }, resolve: { alias: nativeAliases }, build: { outDir: folder, emptyOutDir: false, minify: false, lib: { entry: resolve('mobile/runtime.ts'), formats: ['es'], fileName: () => 'runtime.mjs' } } });
  const { createLocalRuntime } = await import(pathToFileURL(resolve(folder, 'runtime.mjs')).href);
  const sql = await initSqlJs({ locateFile: () => resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  let durable: Uint8Array | undefined, failSave = false, saves = 0, failProvider = false, calls = 0;
  const storage = { async load() { return durable?.slice(); }, async save(bytes: Uint8Array) { if (failSave) throw new Error('simulated disk full'); durable = bytes.slice(); saves++; } };
  const seed = { schemaVersion: 1, generatedAt: new Date().toISOString(), domains: [], categories: [], tags: [], questions: [], documents: [], papers: [] };
  let runtime = await createLocalRuntime(sql, seed, storage), candidateId = '';
  const provider = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const payload = JSON.parse(raw), input = JSON.parse(payload.messages[1].content);
    assert.equal(request.headers.authorization, 'Bearer native-similar-test-key'); calls++;
    assert.ok(!raw.includes('PRIVATE_LEARNING_NOTE_CANARY'));
    assert.ok(input.untrustedMaterial.candidates.some((candidate: any) => candidate.questionId === candidateId));
    if (failProvider) { response.writeHead(429, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'PRIVATE_PROVIDER_FAILURE_CANARY' } })); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items: [{ questionId: candidateId, reason: '同为 TCP 拥塞窗口问题，可比较流量控制与拥塞控制。' }] }) } }] }));
  });
  await new Promise<void>(done => provider.listen(0, '127.0.0.1', done));
  t.after(async () => { await runtime.close(); await new Promise<void>(done => provider.close(() => done())); });
  const api = async (path: string, method = 'GET', payload?: unknown, status = 200) => {
    const response = await runtime.fetch(path, { method, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    const body = await response.json() as any; assert.equal(response.status, status, JSON.stringify(body)); return body;
  };
  const createQuestion = (title: string) => api('/api/questions', 'POST', { title, type: 'short_answer', stemMarkdown: '解释 TCP 拥塞控制和拥塞窗口的作用。', answerMarkdown: '拥塞控制通过调整拥塞窗口保护网络。', categoryIds: [], tagIds: [] }, 201);
  const source = await createQuestion('TCP 拥塞控制基础'), candidate = await createQuestion('TCP 拥塞控制与流量控制对比');
  candidateId = candidate.id;
  const pending = await createQuestion('TCP 拥塞控制待审核');
  await api('/api/questions/review', 'POST', { ids: [source.id, candidate.id], action: 'approve', confirmed: true, expectedUpdatedAt: { [source.id]: source.updatedAt, [candidate.id]: candidate.updatedAt } });
  await api(`/api/study/${source.id}`, 'PUT', { notes: 'PRIVATE_LEARNING_NOTE_CANARY', mastery: 2, favorite: true });
  const { hasKey: _key, ...settings } = await api('/api/ai/settings');
  await api('/api/ai/settings', 'PUT', { ...settings, enabled: true, key: 'native-similar-test-key', model: 'native-similar-model', baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}` });
  const learningSnapshot = () => {
    const database = new sql.Database(durable);
    try { return Object.fromEntries(['questions', 'study', 'study_parts', 'attempts', 'learning_results', 'question_history', 'reviews', 'review_cards', 'review_events'].map(table => [table, database.exec(`SELECT id, data FROM ${table} ORDER BY id`)])); }
    finally { database.close(); }
  };
  const learningBefore = learningSnapshot();
  let successRun: any;

  await t.test('read-only search works without disk writes and excludes source and unpublished questions', async () => {
    const bytesBefore = durable!.slice(), savesBefore = saves; failSave = true;
    try {
      const result = await api(`/api/questions/${source.id}/similar?q=TCP&page=1&pageSize=10`);
      assert.ok(result.items.some((item: any) => item.question.id === candidate.id));
      assert.ok(!result.items.some((item: any) => [source.id, pending.id].includes(item.question.id)));
      assert.equal(calls, 0); assert.equal(saves, savesBefore); assert.deepEqual(durable, bytesBefore);
    } finally { failSave = false; }
    assert.deepEqual(learningSnapshot(), learningBefore);
  });

  await t.test('confirmed AI recommendations persist across restart without adding notes or attempts', async () => {
    await api('/api/ai/similar-questions', 'POST', { questionId: source.id, confirmed: false }, 400); assert.equal(calls, 0);
    successRun = await api('/api/ai/similar-questions', 'POST', { questionId: source.id, confirmed: true });
    assert.equal(successRun.kind, 'similar_questions'); assert.equal(successRun.status, 'completed');
    assert.deepEqual(successRun.result.items.map((item: any) => item.questionId), [candidate.id]);
    assert.ok(!JSON.stringify(successRun).includes('PRIVATE_LEARNING_NOTE_CANARY'));
    assert.deepEqual(learningSnapshot(), learningBefore);
    await runtime.close(); runtime = await createLocalRuntime(sql, seed, storage);
    assert.deepEqual((await api(`/api/ai/runs/${successRun.id}`)).result, successRun.result);
    assert.deepEqual(learningSnapshot(), learningBefore);
  });

  await t.test('provider failures preserve sanitized audit while failed durable saves roll back the entire operation', async () => {
    failProvider = true;
    const response = await runtime.fetch('/api/ai/similar-questions', { method: 'POST', body: JSON.stringify({ questionId: source.id, confirmed: true }) });
    assert.equal(response.status, 502); const auditId = response.headers.get('x-atlas-ai-audit-id'); assert.ok(auditId);
    await runtime.close(); runtime = await createLocalRuntime(sql, seed, storage);
    const failure = await api(`/api/ai/runs/${auditId}`); assert.equal(failure.kind, 'similar_questions'); assert.equal(failure.status, 'failed'); assert.equal(failure.diagnostics.httpStatus, 429); assert.equal(failure.result, undefined);
    assert.ok(!JSON.stringify(failure).includes('PRIVATE_PROVIDER_FAILURE_CANARY')); assert.ok(!JSON.stringify(failure).includes('native-similar-test-key'));
    assert.deepEqual(learningSnapshot(), learningBefore);
    const bytesBefore = durable!.slice(), runsBefore = (await api('/api/ai/runs')).length;
    failSave = true; await api('/api/ai/similar-questions', 'POST', { questionId: source.id, confirmed: true }, 507); failSave = false; failProvider = false;
    assert.deepEqual(durable, bytesBefore); assert.equal((await api('/api/ai/runs')).length, runsBefore); assert.deepEqual(learningSnapshot(), learningBefore);
  });

  await t.test('portable SQLite restore accepts success and failure history and rejects fabricated recommendation references', async () => {
    const response = await runtime.fetch('/api/backup.sqlite'); assert.equal(response.status, 200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.ok(!Buffer.from(bytes).includes(Buffer.from('native-similar-test-key')));
    const preview = await runtime.previewRestore(bytes, 'similar.sqlite'); assert.equal(preview.counts.ai_runs, 2);
    const corrupt = new sql.Database(bytes);
    try {
      const statement = corrupt.prepare('SELECT data FROM ai_runs WHERE id=?'); statement.bind([successRun.id]); assert.ok(statement.step());
      const record = JSON.parse(String(statement.getAsObject().data)); statement.free();
      record.result.items[0].questionId = 'fabricated-candidate';
      corrupt.run('UPDATE ai_runs SET data=? WHERE id=?', [JSON.stringify(record), successRun.id]);
      await assert.rejects(runtime.previewRestore(corrupt.export(), 'invalid-similar.sqlite'), /引用|候选|推荐/);
    } finally { corrupt.close(); }
    assert.deepEqual(learningSnapshot(), learningBefore);
  });
});
