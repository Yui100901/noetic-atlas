import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import initSqlJs from 'sql.js';
import { loadNativeRuntime } from '../helpers/native-runtime.js';
test('native formula metadata survives draft answers, SQLite recovery and portable JSON', async (t) => {
  const { createLocalRuntime } = await loadNativeRuntime(),
    sql = await initSqlJs({ locateFile: () => resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  let saved: Uint8Array | undefined;
  const backups = new Map<string, Uint8Array>();
  const storage = {
    async load() {
      return saved?.slice();
    },
    async save(bytes: Uint8Array) {
      saved = bytes.slice();
    },
    async createRecoveryBackup(bytes: Uint8Array) {
      const id = 'math-' + backups.size;
      backups.set(id, bytes.slice());
      return { id, byteLength: bytes.length, createdAt: new Date().toISOString() };
    },
    async loadRecoveryBackup(id: string) {
      return backups.get(id)!.slice();
    },
  };
  const empty = {
    schemaVersion: 1 as const,
    domains: [],
    categories: [],
    tags: [],
    questions: [],
    documents: [],
    papers: [],
  };
  let runtime = await createLocalRuntime(sql, empty, storage, { dailyPushScheduler: false });
  t.after(() => runtime.close());
  const api = async (path: string, method = 'GET', body?: unknown, status = 200) => {
    const response = await runtime.fetch(path, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  };
  const q = await api(
    '/api/questions',
    'POST',
    {
      id: 'M',
      title: '手机化学式',
      type: 'short_answer',
      mathEnabled: true,
      stemMarkdown: '$\\ce{SO4^2-}$ 是什么离子？',
      answerMarkdown: '硫酸根离子',
    },
    201,
  );
  await api('/api/questions/review', 'POST', {
    ids: ['M'],
    action: 'approve',
    confirmed: true,
    expectedUpdatedAt: { M: q.updatedAt },
  });
  await api(
    '/api/documents',
    'POST',
    { id: 'D', title: '公式原文', bodyMarkdown: '$x_i^2$', mathEnabled: true },
    201,
  );
  await api('/api/study/M', 'PUT', { notes: '$\\ce{H2O}$', notesMathEnabled: true });
  const paper = await api(
      '/api/papers',
      'POST',
      { title: '移动公式', mode: 'manual', questionIds: ['M'], scoring: { enabled: false } },
      201,
    ),
    attempt = await api(`/api/papers/${paper.id}/attempts`, 'POST', {}, 201);
  await api(`/api/attempts/${attempt.id}`, 'PUT', {
    answers: { M: { value: '$\\ce{SO4^2-}$', mathEnabled: true } },
  });
  assert.equal((await api(`/api/attempts/${attempt.id}`)).answers.M.mathEnabled, true);
  const exported = await api('/api/export'),
    backup = await runtime.fetch('/api/backup.sqlite'),
    bytes = new Uint8Array(await backup.arrayBuffer()),
    preview = await runtime.previewRestore(bytes, 'math.sqlite');
  await runtime.restore(preview.token);
  assert.equal((await api('/api/documents/D')).mathEnabled, true);
  await runtime.close();
  saved = undefined;
  runtime = await createLocalRuntime(sql, empty, storage, { dailyPushScheduler: false });
  await api('/api/import', 'POST', { mode: 'merge', data: exported });
  assert.equal((await api('/api/questions/M')).study.notesMathEnabled, true);
  assert.equal((await api(`/api/attempts/${attempt.id}`)).answers.M.mathEnabled, true);
});
