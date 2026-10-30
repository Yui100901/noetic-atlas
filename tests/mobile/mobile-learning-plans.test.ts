import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import initSqlJs from 'sql.js';
import { loadNativeRuntime } from '../helpers/native-runtime.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';

test('native multi-domain plans preserve task progress through JSON and complete SQLite recovery', async (t) => {
  const { createLocalRuntime } = await loadNativeRuntime(),
    sql = await initSqlJs({ locateFile: () => resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const goals = ['A', 'B'].map((id) => ({
    id: 'G' + id,
    name: '目标' + id,
    enabled: true,
    domainId: id,
    categoryIds: ['C' + id],
    tagIds: [],
    tagMode: 'all',
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    priority: 3,
    weight: 1,
    reviewPoints: 0,
    newPoints: 1,
    mode: 'focus',
    direction: 'default',
  }));
  const seed = {
    schemaVersion: 1,
    domains: ['A', 'B'].map((id) => ({ id, name: id, description: '', sortOrder: 0 })),
    categories: ['A', 'B'].map((id) => ({
      id: 'C' + id,
      domainId: id,
      parentId: null,
      name: id,
      description: '',
      sortOrder: 0,
    })),
    tags: [],
    documents: [],
    papers: [],
    questions: ['A', 'B'].flatMap((id) =>
      [1, 2].map((i) => ({
        id: id + i,
        title: id + i,
        type: 'true_false',
        stemMarkdown: '判断知识陈述。',
        correctAnswers: ['true'],
        categoryIds: ['C' + id],
        status: 'published',
      })),
    ),
    settings: [
      {
        ...structuredClone(DEFAULT_SETTINGS),
        dailyPush: {
          ...DEFAULT_SETTINGS.dailyPush,
          enabled: true,
          allocationMode: 'fixed',
          timeZone: 'UTC',
          goals,
        },
      },
    ],
  };
  let durable: Uint8Array | undefined;
  const backups = new Map<string, Uint8Array>(),
    storage = {
      async load() {
        return durable?.slice();
      },
      async save(bytes: Uint8Array) {
        durable = bytes.slice();
      },
      async createRecoveryBackup(bytes: Uint8Array) {
        const id = `plan-${backups.size}`;
        backups.set(id, bytes.slice());
        return { id, byteLength: bytes.length, createdAt: new Date().toISOString() };
      },
      async loadRecoveryBackup(id: string) {
        return backups.get(id)!.slice();
      },
    };
  let runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false });
  t.after(() => runtime.close());
  const api = async (path: string, method = 'GET', body?: unknown, status = 200) => {
    const response = await runtime.fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value as any;
  };
  await api('/api/daily-push/check', 'POST', {});
  let overview = await api('/api/daily-push'),
    day = overview.plan;
  assert.equal(day.goals.length, 2);
  assert.equal(day.progress.total, 2);
  const start = await api(`/api/learning-plans/${day.id}/start`, 'POST', { mode: 'focus' }, 201);
  let session = await api(`/api/focus-sessions/${start.id}`);
  session = await api(`/api/focus-sessions/${session.id}/current`, 'PUT', {
    index: 0,
    revision: session.revision,
    action: 'reveal',
    mode: 'mental',
  });
  session = await api(`/api/focus-sessions/${session.id}/current`, 'PUT', {
    index: 0,
    revision: session.revision,
    action: 'rate',
    rating: 'good',
  });
  assert.equal((await api(`/api/learning-plans/${day.id}`)).progress.completed, 1);
  const exported = await api('/api/export');
  assert.equal(exported.learningDays.length, 1);
  assert.equal(exported.learningTaskResults.length, 1);
  const response = await runtime.fetch('/api/backup.sqlite'),
    bytes = new Uint8Array(await response.arrayBuffer()),
    preview = await runtime.previewRestore(bytes, 'multi-plan.sqlite');
  await runtime.restore(preview.token);
  await runtime.close();
  runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false });
  day = await api(`/api/learning-plans/${day.id}`);
  assert.equal(day.progress.completed, 1);
  assert.equal(day.focusDrafts[0].id, session.id);
  const resumed = await api(`/api/learning-plans/${day.id}/start`, 'POST', { mode: 'focus' }, 201);
  assert.equal(resumed.id, session.id);
  session = await api(`/api/focus-sessions/${session.id}`);
  session = await api(`/api/focus-sessions/${session.id}/current`, 'PUT', {
    index: session.current.index,
    revision: session.revision,
    action: 'reveal',
    mode: 'written',
    answer: 'true',
  });
  const taskQuestionId = session.current.question.sourceQuestionId;
  session = await api(`/api/focus-sessions/${session.id}/current`, 'PUT', {
    index: session.current.index,
    revision: session.revision,
    action: 'rate',
    rating: 'good',
  });
  assert.equal((await api(`/api/learning-plans/${day.id}`)).progress.completed, 2);
  assert.equal((await api(`/api/questions/${taskQuestionId}/history`)).summary.answered, 1);
  const after = await api('/api/export');
  await runtime.close();
  durable = undefined;
  runtime = await createLocalRuntime(sql, after, storage, { dailyPushScheduler: false });
  assert.equal((await api(`/api/learning-plans/${day.id}`)).progress.completed, 2);
});
