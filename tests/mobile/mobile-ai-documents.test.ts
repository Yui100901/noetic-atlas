import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import initSqlJs from 'sql.js';
import { loadNativeRuntime } from '../helpers/native-runtime.js';

test('native textbook jobs preserve partial results, audit failures, and restore validated private task state', async t => {


  const { createLocalRuntime } = await loadNativeRuntime();
  const sql = await initSqlJs({ locateFile: () => resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  let durable: Uint8Array | undefined, failSave = false, failSecondPlan = true, calls = 0;
  const storage = { async load() { return durable?.slice(); }, async save(bytes: Uint8Array) { if (failSave) throw new Error('simulated storage full'); durable = bytes.slice(); } };
  const seed = { schemaVersion: 1, generatedAt: new Date().toISOString(), domains: [], categories: [], tags: [], questions: [], documents: [], papers: [] };
  let runtime = await createLocalRuntime(sql, seed, storage);
  const provider = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw), input = JSON.parse(body.messages[1].content), material = input.untrustedMaterial;
    assert.equal(request.headers.authorization, 'Bearer native-document-test-key'); calls++;
    if (input.task.startsWith('总结') && material.label === '第二节' && failSecondPlan) { response.writeHead(429, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'private-provider-body' } })); return; }
    const content = input.task.startsWith('复核用户') ? { verdict: 'valid', reason: '反馈指出了解析需要补充适用条件。', suggestion: '核对并补充解析条件。', comparisons: [] } : input.task.startsWith('总结')
      ? { title: material.label, summary: '本节介绍概念及其适用边界。', topics: ['基础概念'] }
      : { questions: [{ title: material.label + '练习', type: 'short_answer', stemMarkdown: material.label + '：说明本节概念。', answerMarkdown: '说明概念及适用边界。', explanationMarkdown: '根据提供材料整理。' }], taxonomySuggestions: { domains: [], categories: [], tags: [] } };
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] }));
  });
  await new Promise<void>(done => provider.listen(0, '127.0.0.1', done));
  t.after(async () => { await runtime.close(); await new Promise<void>(done => provider.close(() => done())); });
  const api = async (path: string, method = 'GET', payload?: unknown, status = 200) => {
    const response = await runtime.fetch(path, { method, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    const result = await response.json() as any; assert.equal(response.status, status, JSON.stringify(result)); return result;
  };
  const { hasKey: _key, ...settings } = await api('/api/ai/settings');
  await api('/api/ai/settings', 'PUT', { ...settings, enabled: true, key: 'native-document-test-key', model: 'native-document-model', baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}` });
  const privateText = 'PRIVATE_TEXT_ONLY_IN_TASK：概念是明确的，需说明适用边界。 /api/assets/untrusted-source-mention/content';
  let job = await api('/api/ai/document-jobs', 'POST', { confirmed: true, sourceName: '本地分章节教材', sections: [{ label: '第一节', text: privateText, pageStart: 1, pageEnd: 1 }, { label: '第二节', text: privateText, pageStart: 2, pageEnd: 2 }], questionsPerBlock: 1, maxQuestions: 2 }, 201);
  const path = '/api/ai/document-jobs/' + job.id, ids = job.blocks.map((block: any) => block.id);

  await t.test('partial planning and safe 429 audit persist, and retry only calls the failed block', async () => {
    assert.ok(!JSON.stringify(job).includes('PRIVATE_TEXT_ONLY_IN_TASK'));
    job = await api(path + '/plan', 'POST', { blockIds: ids });
    assert.equal(job.status, 'partial'); assert.equal(job.plannedBlocks, 1); assert.equal(job.failedBlocks, 1);
    assert.match(job.blocks[1].planFailure.message, /429/); assert.ok(job.blocks[1].planFailure.auditId);
    assert.ok(!JSON.stringify(await api('/api/ai/runs')).includes('private-provider-body'));
    await runtime.close(); runtime = await createLocalRuntime(sql, seed, storage);
    job = await api(path); assert.equal(job.plannedBlocks, 1); assert.equal(job.blocks[1].planStatus, 'failed');
    failSecondPlan = false; const before = calls;
    job = await api(path + '/plan', 'POST', { blockIds: ids, retryFailed: true });
    assert.equal(calls, before + 1); assert.equal(job.plannedBlocks, 2); assert.equal(job.blocks[0].planAttempts, 1); assert.equal(job.blocks[1].planAttempts, 2);
  });

  await t.test('disk failure rolls back all previews and runs; confirmation imports pending questions once', async () => {
    const runsBefore = (await api('/api/ai/runs')).length, before = durable!.slice(); failSave = true;
    await api(path + '/generate', 'POST', { blockIds: ids }, 507); failSave = false;
    assert.deepEqual(durable, before); assert.equal((await api(path)).generatedBlocks, 0); assert.equal((await api('/api/ai/runs')).length, runsBefore);
    job = await api(path + '/generate', 'POST', { blockIds: ids }); assert.equal(job.questionCount, 2);
    assert.equal((await api('/api/questions?status=all')).total, 0);
    await api(path + '/import', 'POST', { blockIds: ids, confirmed: false }, 400);
    const imported = await api(path + '/import', 'POST', { blockIds: ids, confirmed: true }); assert.equal(imported.added, 2);
    assert.ok(imported.items.every((question: any) => question.status === 'pending'));
    await api(path + '/import', 'POST', { blockIds: ids, confirmed: true }, 409);
  });

  await t.test('full SQLite preview validates task and failure audits, redacts keys and rejects corrupted budgets', async () => {
    const backup = await runtime.fetch('/api/backup.sqlite'); assert.equal(backup.status, 200);
    const bytes = new Uint8Array(await backup.arrayBuffer()); assert.equal(Buffer.from(bytes).includes(Buffer.from('native-document-test-key')), false);
    const preview = await runtime.previewRestore(bytes, 'native-document.sqlite'); assert.equal(preview.counts.ai_import_jobs, 1); assert.equal(preview.counts.questions, 2); assert.ok(preview.counts.ai_runs >= 5);
    const copy = new sql.Database(bytes);
    try {
      const record = JSON.parse(String(copy.exec('SELECT data FROM ai_import_jobs')[0].values[0][0])); record.questionCount++;
      copy.run('UPDATE ai_import_jobs SET data=? WHERE id=?', [JSON.stringify(record), record.id]);
      await assert.rejects(runtime.previewRestore(copy.export(), 'corrupt.sqlite'), /任务/);
    } finally { copy.close(); }
    assert.equal((await api(path)).importedCount, 2);
  });
  await t.test('feedback flags, AI suggestions and trusted backup survive native persistence without changing publication', async () => {
    const questions = (await api('/api/questions?status=all')).items;
    await api('/api/questions/review', 'POST', { ids: questions.map((question: any) => question.id), action: 'approve', confirmed: true, expectedUpdatedAt: Object.fromEntries(questions.map((question: any) => [question.id, question.updatedAt])) });
    const question = await api('/api/questions/' + questions[0].id);
    let feedback = await api('/api/question-feedback', 'POST', { questionId: question.id, kind: 'explanation', description: '解析缺少适用条件，请核对。', expectedUpdatedAt: question.updatedAt }, 201);
    assert.equal((await api('/api/questions/' + question.id)).feedbackSummary.openCount, 1);
    failSave = true; const before = durable!.slice();
    const summaries = await api('/api/question-feedback/summaries', 'POST', { questionIds: questions.map((item: any) => item.id) }); failSave = false;
    assert.equal(summaries.summaries[question.id].openCount, 1); assert.equal(summaries.summaries[questions[1].id].openCount, 0); assert.deepEqual(durable, before);
    const reviewed = await api('/api/question-feedback/ai-review', 'POST', { ids: [feedback.id], expectedUpdatedAt: { [feedback.id]: feedback.updatedAt } });
    assert.equal(reviewed.completed, 1); feedback = reviewed.items[0].feedback; assert.equal(feedback.review.verdict, 'valid'); assert.equal(feedback.status, 'pending');
    assert.equal((await api('/api/questions/' + question.id)).status, 'published');
    const json = await api('/api/export'); assert.equal(json.questionFeedback.length, 1); assert.equal(json.questionFeedback[0].id, feedback.id);
    const bytes = new Uint8Array(await (await runtime.fetch('/api/backup.sqlite')).arrayBuffer());
    assert.equal((await runtime.previewRestore(bytes, 'feedback.sqlite')).counts.question_feedback, 1);
    await runtime.close(); runtime = await createLocalRuntime(sql, seed, storage);
    feedback = await api('/api/question-feedback/' + feedback.id); assert.equal(feedback.review.verdict, 'valid');
    await api('/api/question-feedback/' + feedback.id + '/resolve', 'POST', { status: 'dismissed', note: '已核查并记录处理依据。', expectedUpdatedAt: feedback.updatedAt });
    assert.equal((await api('/api/questions/' + question.id)).feedbackSummary.openCount, 0);
  });
});
