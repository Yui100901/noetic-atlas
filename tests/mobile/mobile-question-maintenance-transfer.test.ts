import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import initSqlJs from 'sql.js';
import { loadNativeRuntime } from '../helpers/native-runtime.js';
import { fixtureQuestion } from '../fixtures/learning-seed.js';

test('offline editing drafts and revisions survive restart and full restore, protect their files and roll back failed persistence', async (t) => {
  const { createLocalRuntime } = await loadNativeRuntime();
  const sql = await initSqlJs({
    locateFile: () => resolve('node_modules/sql.js/dist/sql-wasm.wasm'),
  });
  const seed = {
    schemaVersion: 1,
    domains: [],
    categories: [],
    tags: [],
    questions: [],
    documents: [],
    papers: [],
  };
  let durable: Uint8Array | undefined,
    failSave = false;
  const recovery = new Map<string, Uint8Array>();
  const storage = {
    async load() {
      return durable?.slice();
    },
    async save(bytes: Uint8Array) {
      if (failSave) throw Error('test persistence failure');
      durable = bytes.slice();
    },
    async createRecoveryBackup(bytes: Uint8Array) {
      const id = 'maintenance-recovery-' + recovery.size;
      recovery.set(id, bytes.slice());
      return { id, byteLength: bytes.length, createdAt: new Date().toISOString() };
    },
    async loadRecoveryBackup(id: string) {
      return recovery.get(id)!.slice();
    },
  };
  let runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false });
  t.after(() => runtime.close());
  const api = async (path: string, method = 'GET', payload?: unknown, expected = 200) => {
    const response = await runtime.fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const body = await response.json();
    assert.equal(response.status, expected, JSON.stringify(body));
    return body as any;
  };
  const question = fixtureQuestion('OFFLINE-MAINTENANCE', 'short_answer', {
    categoryIds: [],
    tagIds: [],
    sourceRefs: [],
  });
  const {
    id: _id,
    status: _status,
    createdAt: _created,
    updatedAt: _updated,
    ...content
  } = question;
  const asset = await api(
    '/api/assets',
    'POST',
    {
      filename: 'maintenance.png',
      mimeType: 'image/png',
      dataBase64:
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    },
    201,
  );
  const timestamp = '2026-11-01T00:00:00.000Z';
  const draft = {
    id: 'offline-edit-draft',
    questionId: question.id,
    baseUpdatedAt: question.updatedAt,
    state: {
      form: {
        ...content,
        title: '',
        stemMarkdown: `![未完成图片](/api/assets/${asset.id}/content)`,
        status: 'published',
        categoryIds: ['removed-category'],
      },
      sources: '未完成的来源 |',
      reason: '编辑尚未提交',
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const revision = {
    id: 'offline-edit-revision',
    questionId: question.id,
    sequence: 1,
    content: { ...content, answerMarkdown: `![历史图片](/api/assets/${asset.id}/content)` },
    origin: 'manual',
    reason: '既有修订',
    changedFields: ['answerMarkdown'],
    createdAt: timestamp,
    sourceUpdatedAt: timestamp,
  };
  const baseline = {
    ...revision,
    id: 'offline-damaged-baseline',
    sequence: 2,
    origin: 'baseline',
    content: {
      ...content,
      answerMarkdown: '只读损坏证据 ![](/api/assets/missing-baseline/content)',
    },
  };
  await api('/api/import', 'POST', {
    mode: 'merge',
    data: {
      ...seed,
      questions: [question],
      questionDrafts: [draft],
      questionRevisions: [revision, baseline],
    },
  });
  await api('/api/assets/' + asset.id, 'DELETE', undefined, 409);
  const original = durable!.slice();
  await runtime.close();
  runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false });
  const recovered = await api('/api/export');
  assert.deepEqual(recovered.questionDrafts, [draft]);
  assert.deepEqual(recovered.questionRevisions, [revision, baseline]);
  assert.equal(recovered.questions[0].title, question.title);
  failSave = true;
  const second = { ...draft, id: 'another-offline-draft' };
  await api(
    '/api/import',
    'POST',
    { mode: 'merge', data: { ...seed, questionDrafts: [second] } },
    507,
  );
  assert.deepEqual(durable, original);
  assert.equal((await api('/api/export')).questionDrafts.length, 1);
  failSave = false;
  await api('/api/import', 'POST', { mode: 'merge', data: { ...seed, questionDrafts: [second] } });
  const preview = await runtime.previewRestore(original, 'question-maintenance.sqlite');
  assert.equal(preview.currentCounts.question_drafts, 2);
  assert.equal(preview.counts.question_drafts, 1);
  assert.equal(preview.counts.question_revisions, 2);
  await runtime.restore(preview.token);
  assert.equal(recovery.size, 1);
  await runtime.close();
  runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false });
  const restored = await api('/api/export');
  assert.deepEqual(restored.questionDrafts, [draft]);
  assert.deepEqual(restored.questionRevisions, [revision, baseline]);
  assert.equal(restored.questions[0].answerMarkdown, question.answerMarkdown);
  await api('/api/assets/' + asset.id, 'DELETE', undefined, 409);
  const beforeBadRestore = durable!.slice();
  await api(
    `/api/questions/${question.id}/revisions/${baseline.id}/restore`,
    'POST',
    { expectedUpdatedAt: question.updatedAt, confirmed: true },
    400,
  );
  assert.deepEqual(durable, beforeBadRestore);
  const invalid = {
    ...seed,
    questionRevisions: [{ ...revision, id: 'orphan-revision', questionId: 'missing-original' }],
  };
  const before = durable!.slice();
  await api('/api/import', 'POST', { mode: 'merge', data: invalid }, 404);
  assert.deepEqual(durable, before);
});
