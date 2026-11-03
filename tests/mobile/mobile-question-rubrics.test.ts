import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import initSqlJs from 'sql.js';
import { loadNativeRuntime } from '../helpers/native-runtime.js';

test('native question standards, paged set preview and local overrides survive persisted SQLite validation', async (t) => {
  const { createLocalRuntime } = await loadNativeRuntime(),
    sql = await initSqlJs({ locateFile: () => resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  let durable: Uint8Array | undefined;
  const storage = {
    async load() {
      return durable?.slice();
    },
    async save(bytes: Uint8Array) {
      durable = bytes.slice();
    },
  };
  const seed = {
    schemaVersion: 1,
    domains: [],
    categories: [],
    tags: [],
    questions: [],
    documents: [],
    papers: [],
  };
  let runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false });
  t.after(() => runtime.close());
  const api = async (path: string, method = 'GET', payload?: unknown, status = 200) => {
    const response = await runtime.fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value as any;
  };
  const base = '必须说明全有或全无、失败回滚；接受等价表达。',
    override = '允许只解释关键含义；遗漏非关键机制可部分正确。';
  const question = await api(
    '/api/questions',
    'POST',
    {
      title: '移动端原子性',
      type: 'short_answer',
      stemMarkdown: '解释事务原子性。',
      answerMarkdown: '全部成功或全部回滚。',
      gradingRequirements: base,
    },
    201,
  );
  await api('/api/questions/review', 'POST', {
    confirmed: true,
    ids: [question.id],
    action: 'approve',
    expectedUpdatedAt: { [question.id]: question.updatedAt },
  });
  const input = {
    title: '移动端预览',
    mode: 'manual',
    questionIds: [question.id],
    questionGradingRequirements: { [question.id]: override },
    scoring: { enabled: false },
  };
  const preview = await api('/api/papers/preview', 'POST', {
    ...input,
    previewPage: 1,
    previewPageSize: 5,
  });
  assert.equal(preview.previewQuestions[0].gradingRequirements, override);
  assert.equal(preview.inheritedGradingRequirements[question.id], base);
  assert.equal(preview.questions[0].stemMarkdown, '');
  const paper = await api(
      '/api/papers',
      'POST',
      { ...input, expectedQuestionVersions: preview.questionVersions },
      201,
    ),
    attempt = await api(`/api/papers/${paper.id}/attempts`, 'POST', undefined, 201);
  assert.equal(Object.hasOwn(attempt.questions[0], 'gradingRequirements'), false);
  const submitted = await api(`/api/attempts/${attempt.id}/submit`, 'POST', {
    answers: { [question.id]: { value: '整体成功或回滚' } },
  });
  assert.equal(submitted.questions[0].gradingRequirements, override);
  await runtime.close();
  runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false });
  assert.equal((await api(`/api/questions/${question.id}`)).gradingRequirements, base);
  assert.equal(
    (await api(`/api/papers/${paper.id}/preview?pageSize=5`)).previewQuestions[0]
      .gradingRequirements,
    override,
  );
  const exported = await api('/api/export');
  assert.equal(exported.papers[0].questionGradingRequirements[question.id], override);
  const response = await runtime.fetch('/api/backup.sqlite'),
    bytes = new Uint8Array(await response.arrayBuffer());
  const validated = await runtime.previewRestore(bytes, 'question-rubric-native.sqlite');
  assert.equal(validated.counts.papers, 1);
});
