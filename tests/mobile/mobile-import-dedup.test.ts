import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import initSqlJs from 'sql.js';
import { loadNativeRuntime } from '../helpers/native-runtime.js';
import { learningSeed } from '../fixtures/learning-seed.js';

test('offline import preview does not persist, exact import commits once and reuse survives restart', async () => {
  const { createLocalRuntime } = await loadNativeRuntime();
  const sql = await initSqlJs({
    locateFile: () => resolve('node_modules/sql.js/dist/sql-wasm.wasm'),
  });
  let bytes: Uint8Array | undefined,
    saves = 0;
  const storage = {
    load: async () => bytes?.slice(),
    save: async (value: Uint8Array) => {
      bytes = value.slice();
      saves++;
    },
  };
  const seed = learningSeed();
  let runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false });
  const baselineSaves = saves;
  const data = {
    format: 'learning-new-questions',
    schemaVersion: 1,
    questions: [seed.questions[0]],
  };
  const inspected = await runtime.fetch('/api/questions/import-preview', {
    method: 'POST',
    body: JSON.stringify({ data }),
  });
  assert.equal(inspected.status, 200, await inspected.clone().text());
  const preview = await inspected.json();
  assert.equal(preview.counts.exact, 1);
  assert.equal(saves, baselineSaves);
  const imported = await runtime.fetch('/api/questions/bulk-import', {
    method: 'POST',
    body: JSON.stringify({
      data,
      confirmed: true,
      dedup: { expectedFingerprint: preview.fingerprint, decisions: [] },
    }),
  });
  assert.equal(imported.status, 201, await imported.clone().text());
  const result = await imported.json();
  assert.equal(result.added, 0);
  assert.equal(result.items[0].id, seed.questions[0]!.id);
  assert.equal(saves, baselineSaves + 1);
  await runtime.close();
  runtime = await createLocalRuntime(sql, undefined, storage, { dailyPushScheduler: false });
  try {
    const repeated = await runtime.fetch('/api/questions/import-preview', {
      method: 'POST',
      body: JSON.stringify({ data }),
    });
    assert.equal(repeated.status, 200, await repeated.clone().text());
    assert.equal((await repeated.json()).counts.exact, 1);
    assert.equal(saves, baselineSaves + 1);
  } finally {
    await runtime.close();
  }
});

test('offline import can explicitly skip dedup without overwriting an existing question', async (t) => {
  const { createLocalRuntime } = await loadNativeRuntime();
  const sql = await initSqlJs({
    locateFile: () => resolve('node_modules/sql.js/dist/sql-wasm.wasm'),
  });
  let bytes: Uint8Array | undefined;
  const seed = learningSeed();
  const runtime = await createLocalRuntime(
    sql,
    seed,
    {
      load: async () => bytes?.slice(),
      save: async (value) => {
        bytes = value.slice();
      },
    },
    { dailyPushScheduler: false },
  );
  t.after(() => runtime.close());
  const data = {
    format: 'learning-new-questions',
    schemaVersion: 1,
    questions: [seed.questions[0]],
  };
  const inspected = await runtime.fetch('/api/questions/import-preview', {
    method: 'POST',
    body: JSON.stringify({ data, dedup: { enabled: false } }),
  });
  assert.equal(inspected.status, 200, await inspected.clone().text());
  const preview = await inspected.json();
  assert.equal(preview.enabled, false);
  assert.equal(preview.counts.new, 1);
  assert.equal(preview.metrics.indexed, 0);
  const imported = await runtime.fetch('/api/questions/bulk-import', {
    method: 'POST',
    body: JSON.stringify({
      data,
      confirmed: true,
      dedup: { enabled: false, expectedFingerprint: preview.fingerprint },
    }),
  });
  assert.equal(imported.status, 201, await imported.clone().text());
  const result = await imported.json();
  assert.equal(result.added, 1);
  assert.notEqual(result.items[0].id, seed.questions[0]!.id);
  assert.equal(result.items[0].status, 'pending');
  const original = await runtime.fetch(`/api/questions/${seed.questions[0]!.id}`);
  assert.equal(original.status, 200, await original.clone().text());
  assert.equal((await original.json()).status, 'published');
});
