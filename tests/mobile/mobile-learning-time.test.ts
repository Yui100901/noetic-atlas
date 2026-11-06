import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import initSqlJs from 'sql.js';
import { loadNativeRuntime } from '../helpers/native-runtime.js';
import { Store } from '../../server/core/store.js';
import { questionSchema } from '../../server/core/validation.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';
import { DEFAULT_LEARNING_TIME_BUDGET } from '../../shared/models/learning-time.js';
import { exportData } from '../../server/modules/transfer/migration.js';
import { learningResultSchema } from '../../server/modules/practice/learning-results.js';

test('native time plans and weekly targets survive rollback, restart, JSON migration and complete SQLite recovery', async (t) => {
  const source = new Store(':memory:');
  t.after(() => source.database.close());
  source.put('domains', 'D', { id: 'D', name: '时间学习', description: '', sortOrder: 0 });
  source.put('categories', 'C', {
    id: 'C',
    domainId: 'D',
    name: '基础',
    parentId: null,
    description: '',
    sortOrder: 0,
  });
  for (let index = 0; index < 5; index++) {
    const question = questionSchema.parse({
      id: `time-${index}`,
      title: `时间练习${index}`,
      type: 'true_false',
      stemMarkdown: `隔离陈述${index}`,
      correctAnswers: ['true'],
      status: 'published',
      categoryIds: ['C'],
    });
    source.put('questions', question.id, question);
  }
  const clock = new Date(),
    stamp = clock.toISOString();
  source.put('settings', 'system', {
    ...structuredClone(DEFAULT_SETTINGS),
    dailyPush: {
      ...DEFAULT_SETTINGS.dailyPush,
      enabled: true,
      domainId: 'D',
      categoryIds: ['C'],
      timeZone: 'UTC',
      timeBudget: {
        ...DEFAULT_LEARNING_TIME_BUDGET,
        enabled: true,
        weekdayMinutes: 1,
        weekendMinutes: 1,
        weeklyMinutes: 30,
      },
    },
  });
  source.put(
    'learning_results',
    'timed-history',
    learningResultSchema.parse({
      id: 'timed-history',
      source: 'quick',
      paperId: 'quick-practice',
      paperTitle: '计时自测',
      paperVersion: 1,
      status: 'submitted',
      startedAt: stamp,
      submittedAt: stamp,
      updatedAt: stamp,
      elapsedSeconds: 60,
      items: [],
      questions: [],
      historyIndexed: true,
    }),
  );
  const seed = exportData(source);
  const { createLocalRuntime } = await loadNativeRuntime(),
    sql = await initSqlJs({ locateFile: () => resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  let durable: Uint8Array | undefined,
    failSave = false;
  const backups = new Map<string, Uint8Array>();
  const storage = {
    async load() {
      return durable?.slice();
    },
    async save(bytes: Uint8Array) {
      if (failSave) throw new Error('isolated full disk');
      durable = bytes.slice();
    },
    async createRecoveryBackup(bytes: Uint8Array) {
      const id = `learning-time-${backups.size}`;
      backups.set(id, bytes.slice());
      return { id, createdAt: new Date().toISOString(), byteLength: bytes.length };
    },
    async loadRecoveryBackup(id: string) {
      return backups.get(id)!.slice();
    },
  };
  const options = { dailyPushNow: () => new Date(clock), dailyPushScheduler: false };
  let runtime = await createLocalRuntime(sql, seed, storage, options);
  t.after(() => runtime.close());
  const api = async (url: string, method = 'GET', body?: unknown, status = 200): Promise<any> => {
    const response = await runtime.fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  };
  assert.equal((await api('/api/settings')).dailyPush.timeBudget.weeklyMinutes, 30);
  const week = await api('/api/learning-plans/week');
  assert.equal(week.targetMinutes, 30);
  assert.equal(week.elapsedSeconds, 60);
  assert.equal(week.timedSessions, 1);
  const generated = await api('/api/daily-push/check', 'POST', {});
  assert.equal(generated.generated, true);
  const day = (await api('/api/daily-push')).plan;
  assert.equal(day.timeBudget.targetSeconds, 60);
  assert.equal(day.timeBudget.estimatedSeconds, 45);
  assert.equal(
    day.tasks,
    undefined,
    'overview keeps the bounded summary rather than returning every task',
  );
  const fullDay = await api(`/api/learning-plans/${day.id}`);
  assert.equal(fullDay.tasks.length, 1);
  assert.equal(fullDay.tasks[0].estimateSource, 'default');
  const before = durable!.slice(),
    settings = await api('/api/settings');
  failSave = true;
  await api(
    '/api/settings',
    'PUT',
    {
      settings: {
        ...settings,
        dailyPush: {
          ...settings.dailyPush,
          timeBudget: { ...settings.dailyPush.timeBudget, weeklyMinutes: 99 },
        },
      },
    },
    507,
  );
  failSave = false;
  assert.deepEqual(durable, before);
  assert.equal((await api('/api/learning-plans/week')).targetMinutes, 30);

  await runtime.close();
  runtime = await createLocalRuntime(sql, seed, storage, options);
  assert.equal((await api('/api/learning-plans/week')).elapsedSeconds, 60);
  assert.deepEqual((await api(`/api/learning-plans/${day.id}`)).timeBudget, fullDay.timeBudget);
  const backup = await runtime.fetch('/api/backup.sqlite'),
    bytes = new Uint8Array(await backup.arrayBuffer());
  const preview = await runtime.previewRestore(bytes, 'learning-time.sqlite');
  await runtime.restore(preview.token);
  await runtime.close();
  runtime = await createLocalRuntime(sql, seed, storage, options);
  assert.equal((await api('/api/learning-plans/week')).targetMinutes, 30);
  assert.equal((await api('/api/learning-plans/week')).elapsedSeconds, 60);
  const exported = await api('/api/export');
  await runtime.close();
  durable = undefined;
  runtime = await createLocalRuntime(sql, exported, storage, options);
  assert.equal((await api('/api/settings')).dailyPush.timeBudget.weekdayMinutes, 1);
  assert.deepEqual((await api(`/api/learning-plans/${day.id}`)).timeBudget, fullDay.timeBudget);
  assert.equal((await api('/api/learning-plans/week')).elapsedSeconds, 60);
});
