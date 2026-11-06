import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Store } from '../../server/core/store.js';
import { ApiError, questionSchema } from '../../server/core/validation.js';
import { registerAiRoutes } from '../../server/modules/ai/routes.js';
import { putCompletedAiRun } from '../../server/modules/ai/run-storage.js';
import { registerAiDocumentRoutes } from '../../server/modules/ai/document-routes.js';
import { createDocumentJob, documentJob } from '../../server/modules/ai/document-service.js';

async function fixture(t: test.TestContext) {
  const store = new Store(':memory:'),
    app = Fastify();
  t.after(async () => {
    await app.close();
    store.database.close();
  });
  app.setErrorHandler((error, _request, reply) => {
    const e = error as ApiError;
    return reply.code(e.status || 500).send({ error: { code: e.code, message: e.message } });
  });
  registerAiRoutes(app, store);
  registerAiDocumentRoutes(app, store);
  const question = questionSchema.parse({
    id: 'tcp',
    title: 'TCP连接',
    type: 'short_answer',
    stemMarkdown: '为什么需要三次握手？',
    answerMarkdown: '双方确认收发能力及初始序号。',
    status: 'published',
  });
  store.put('questions', question.id!, question);
  const makeRun = (id: string, questions = [question]) =>
    putCompletedAiRun(store, {
      id,
      kind: 'import',
      status: 'completed',
      model: 'fixture',
      createdAt: new Date().toISOString(),
      warnings: [],
      questionIds: [],
      result: { questions, taxonomySuggestions: { domains: [], categories: [], tags: [] } },
      _context: { questionVersions: {}, sourceByItem: {} },
    });
  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload });
  return { store, app, question, makeRun, post };
}

test('AI import exact duplicates reuse one bank row and retain a unique completed-run reference', async (t) => {
  const { store, question, makeRun, post } = await fixture(t);
  makeRun('run-exact', [question, { ...question, id: 'other-source' }]);
  const inspected = await post('/api/ai/runs/run-exact/import-preview', {});
  assert.equal(inspected.statusCode, 200, inspected.body);
  const preview = inspected.json();
  assert.equal(preview.counts.exact, 2);
  assert.equal(store.all('questions').length, 1);
  const applied = await post('/api/ai/runs/run-exact/import', {
    confirmed: true,
    dedup: { expectedFingerprint: preview.fingerprint, decisions: [] },
  });
  assert.equal(applied.statusCode, 200, applied.body);
  assert.equal(applied.json().added, 0);
  assert.equal(applied.json().items.length, 2);
  assert.deepEqual(applied.json().run.importedQuestionIds, ['tcp']);
  assert.equal(store.all('questions').length, 1);
  assert.equal((await post('/api/ai/runs/run-exact/import', { confirmed: true })).statusCode, 409);
});

test('AI import similar decisions are explicit and replacement preserves identity, study and revision history', async (t) => {
  const { store, question, makeRun, post } = await fixture(t);
  const changed = {
    ...question,
    answerMarkdown: '确认双方收发能力、同步初始序号，避免旧连接请求造成资源分配。',
  };
  makeRun('run-change', [changed]);
  store.put('study', 'tcp', { questionId: 'tcp', favorite: true, notes: '私人笔记', mastery: 2 });
  const beforeStudy = store.get('study', 'tcp');
  const preview = (await post('/api/ai/runs/run-change/import-preview', {})).json();
  assert.equal(preview.counts.similar, 1);
  const unresolved = await post('/api/ai/runs/run-change/import', {
    confirmed: true,
    dedup: { expectedFingerprint: preview.fingerprint, decisions: [] },
  });
  assert.equal(unresolved.statusCode, 409, unresolved.body);
  const applied = await post('/api/ai/runs/run-change/import', {
    confirmed: true,
    dedup: {
      expectedFingerprint: preview.fingerprint,
      decisions: [{ key: 'i-0', action: 'replace', targetId: 'tcp' }],
    },
  });
  assert.equal(applied.statusCode, 200, applied.body);
  assert.equal(applied.json().updated, 1);
  assert.equal(applied.json().items[0].id, 'tcp');
  assert.deepEqual(store.get('study', 'tcp'), beforeStudy);
  assert.equal(store.get<any>('questions', 'tcp').answerMarkdown, changed.answerMarkdown);
  assert.ok(store.all('question_revisions').length >= 2);
});

test('an edited target invalidates AI import preview without applying any question or run changes', async (t) => {
  const { store, question, makeRun, post } = await fixture(t);
  makeRun('run-stale', [{ ...question, answerMarkdown: '新版解释。' }]);
  const preview = (await post('/api/ai/runs/run-stale/import-preview', {})).json();
  store.put('questions', 'tcp', {
    ...question,
    answerMarkdown: '预览后的本地编辑。',
    updatedAt: new Date().toISOString(),
  });
  const response = await post('/api/ai/runs/run-stale/import', {
    confirmed: true,
    dedup: {
      expectedFingerprint: preview.fingerprint,
      decisions: [{ key: 'i-0', action: 'replace', targetId: 'tcp' }],
    },
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(store.get<any>('questions', 'tcp').answerMarkdown, '预览后的本地编辑。');
  assert.equal(store.get<any>('ai_runs', 'run-stale').appliedAt, undefined);
});

test('textbook block imports share deduplication and preserve one-to-one block references for repeated questions', async (t) => {
  const { store, question, post } = await fixture(t);
  const created = createDocumentJob(store, {
    confirmed: true,
    sourceName: '公开教材测试',
    sections: [{ text: 'TCP通过握手确认双方的收发能力并协商初始序号。'.repeat(5), label: '握手' }],
    questionsPerBlock: 2,
    maxQuestions: 10,
  });
  const job = documentJob(store, created.id),
    block = job.blocks[0]!;
  block.planStatus = 'completed';
  block.generationStatus = 'completed';
  block.questions = [question, { ...question, id: 'duplicate-model-id' }];
  store.put('ai_import_jobs', job.id, job);
  const body = { confirmed: true, blockIds: [block.id] };
  const response = await post(`/api/ai/document-jobs/${job.id}/import-preview`, body);
  assert.equal(response.statusCode, 200, response.body);
  const preview = response.json();
  assert.equal(preview.counts.exact, 2);
  const applied = await post(`/api/ai/document-jobs/${job.id}/import`, {
    ...body,
    dedup: { expectedFingerprint: preview.fingerprint, decisions: [] },
  });
  assert.equal(applied.statusCode, 200, applied.body);
  assert.equal(applied.json().added, 0);
  assert.deepEqual(applied.json().job.blocks[0].importedQuestionIds, ['tcp', 'tcp']);
  assert.equal(store.all('questions').length, 1);
});
