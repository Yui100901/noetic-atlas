import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import initSqlJs from 'sql.js';
import { loadNativeRuntime } from '../helpers/native-runtime.js';

test('native focus drafts, pauses and FSRS ratings survive SQLite restore without duplicate answers', async (t) => {
  const { createLocalRuntime } = await loadNativeRuntime();
  const sql = await initSqlJs({
    locateFile: () => resolve('node_modules/sql.js/dist/sql-wasm.wasm'),
  });
  let durable: Uint8Array | undefined;
  const backups = new Map<string, Uint8Array>();
  const storage = {
    async load() {
      return durable?.slice();
    },
    async save(bytes: Uint8Array) {
      durable = bytes.slice();
    },
    async createRecoveryBackup(bytes: Uint8Array) {
      const id = `focus-${backups.size}`;
      backups.set(id, bytes.slice());
      return { id, byteLength: bytes.length, createdAt: new Date().toISOString() };
    },
    async loadRecoveryBackup(id: string) {
      return backups.get(id)!.slice();
    },
  };
  let runtime = await createLocalRuntime(
    sql,
    {
      schemaVersion: 1,
      domains: [],
      categories: [],
      tags: [],
      documents: [],
      papers: [],
      questions: [
        {
          id: 'NATIVE-TF',
          title: '判断',
          type: 'true_false',
          stemMarkdown: '进程有独立地址空间。',
          correctAnswers: ['true'],
          status: 'published',
        },
      ],
    },
    storage,
    { dailyPushScheduler: false },
  );
  t.after(() => runtime.close());
  const api = async (path: string, method = 'GET', body?: unknown, status = 200) => {
    const response = await runtime.fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    assert.equal(response.status, status, JSON.stringify(data));
    return data as any;
  };
  const paper = await api(
    '/api/papers',
    'POST',
    { title: '移动专注复习', mode: 'manual', questionIds: ['NATIVE-TF'] },
    201,
  );
  let session = await api(
    '/api/focus-sessions',
    'POST',
    { paperId: paper.id, scope: 'all', count: 1 },
    201,
  );
  session = await api(`/api/focus-sessions/${session.id}/current`, 'PUT', {
    index: 0,
    revision: session.revision,
    action: 'save',
    mode: 'written',
    answer: 'true',
  });
  await api(`/api/focus-sessions/${session.id}/timing`, 'POST', {
    action: 'resume',
    sessionId: 'native-focus-clock',
    expectedSessionId: null,
  });
  await api(`/api/focus-sessions/${session.id}/timing`, 'POST', {
    action: 'pause',
    sessionId: 'native-focus-clock',
    elapsedMilliseconds: 5200,
  });
  const seed = await api('/api/export');
  const backup = await runtime.fetch('/api/backup.sqlite');
  assert.equal(backup.status, 200);
  const bytes = new Uint8Array(await backup.arrayBuffer());
  assert.ok(bytes.length > 0);
  const preview = await runtime.previewRestore(bytes, 'native-focus.sqlite');
  await runtime.restore(preview.token);
  await runtime.close();
  runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false });
  session = await api(`/api/focus-sessions/${session.id}`);
  assert.equal(session.current.answer.value, 'true');
  assert.equal(session.elapsedSeconds, 5);
  assert.equal(session.practiceTiming.running, false);
  session = await api(`/api/focus-sessions/${session.id}/current`, 'PUT', {
    index: 0,
    revision: session.revision,
    action: 'reveal',
    mode: 'written',
    answer: 'true',
  });
  const rating = { index: 0, revision: session.revision, action: 'rate', rating: 'good' };
  session = await api(`/api/focus-sessions/${session.id}/current`, 'PUT', rating);
  await api(`/api/focus-sessions/${session.id}/current`, 'PUT', rating);
  assert.equal(session.status, 'submitted');
  const history = await api('/api/questions/NATIVE-TF/history');
  assert.equal(history.summary.answered, 1);
  assert.equal(history.summary.correct, 1);
  const data = await api('/api/export');
  assert.equal(data.focusSessions.length, 1);
  assert.equal(data.reviewEvents.length, 1);
});
