import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import initSqlJs from 'sql.js';
import { loadNativeRuntime } from '../helpers/native-runtime.js';
import { learningSeed } from '../fixtures/learning-seed.js';

test('offline maintenance/reset persists, previews do not write and failed commits restore learning data', async (t) => {
  const { createLocalRuntime } = await loadNativeRuntime();
  const sql = await initSqlJs({
    locateFile: () => resolve('node_modules/sql.js/dist/sql-wasm.wasm'),
  });
  let durable: Uint8Array | undefined,
    fail = false,
    writes = 0;
  const storage = {
    async load() {
      return durable?.slice();
    },
    async save(bytes: Uint8Array) {
      if (fail) throw new Error('模拟磁盘写入失败');
      writes++;
      durable = bytes.slice();
    },
  };
  let runtime = await createLocalRuntime(sql, learningSeed(), storage);
  t.after(() => runtime.close());
  const api = async (path: string, method = 'GET', body?: unknown, status = 200) => {
    const response = await runtime.fetch(path, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value: any = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  };
  const paper = await api(
    '/api/papers',
    'POST',
    { title: '离线维护', mode: 'manual', questionIds: ['FIXTURE-BOOL'] },
    201,
  );
  const attempt = await api(`/api/papers/${paper.id}/attempts`, 'POST', undefined, 201);
  await api(`/api/attempts/${attempt.id}/submit`, 'POST', {
    answers: { 'FIXTURE-BOOL': { value: 'false' } },
  });
  const baseline = writes,
    selection = { scope: 'paper', paperId: paper.id, mode: 'progress' };
  let preview = await api('/api/maintenance/reset-preview', 'POST', selection);
  await api('/api/maintenance/health?integrity=true');
  await api('/api/maintenance/cleanup-preview', 'POST', {
    kinds: ['unused_assets'],
    olderThanDays: 30,
  });
  assert.equal(writes, baseline, 'read-only previews must not rewrite a SQLite file');
  fail = true;
  const response = await runtime.fetch('/api/maintenance/reset', {
    method: 'POST',
    body: JSON.stringify({ selection, fingerprint: preview.fingerprint, confirmed: true }),
  });
  assert.ok(response.status >= 500);
  fail = false;
  assert.equal((await api('/api/questions/FIXTURE-BOOL')).study.wrongCount, 1);
  preview = await api('/api/maintenance/reset-preview', 'POST', selection);
  await api('/api/maintenance/reset', 'POST', {
    selection,
    fingerprint: preview.fingerprint,
    confirmed: true,
  });
  for (const action of ['reindex', 'compact'])
    await api(`/api/maintenance/${action}`, 'POST', { confirmed: true });
  await runtime.close();
  runtime = await createLocalRuntime(
    sql,
    {
      schemaVersion: 1,
      domains: [],
      categories: [],
      tags: [],
      questions: [],
      documents: [],
      papers: [],
    },
    storage,
  );
  assert.equal((await api('/api/questions/FIXTURE-BOOL')).study.wrongCount, 0);
  assert.equal((await api('/api/maintenance/health')).operations.length, 3);
  assert.equal((await api(`/api/attempts/${attempt.id}`)).status, 'submitted');
  const settings = await api('/api/settings'),
    complete = { scope: 'all', mode: 'complete' };
  const finalPreview = await api('/api/maintenance/reset-preview', 'POST', complete);
  await api('/api/maintenance/reset', 'POST', {
    selection: complete,
    fingerprint: finalPreview.fingerprint,
    confirmed: true,
  });
  const cleared = await api('/api/maintenance/health?integrity=true');
  for (const table of [
    'attempts',
    'study',
    'question_history',
    'learning_results',
    'reviews',
    'review_events',
  ])
    assert.equal(cleared.counts[table], 0, table);
  assert.equal(cleared.counts.questions, 6);
  assert.equal(cleared.counts.papers, 1);
  assert.deepEqual(await api('/api/settings'), settings);
  await runtime.close();
  runtime = await createLocalRuntime(
    sql,
    {
      schemaVersion: 1,
      domains: [],
      categories: [],
      tags: [],
      questions: [],
      documents: [],
      papers: [],
    },
    storage,
  );
  assert.equal((await api('/api/maintenance/health')).counts.attempts, 0);
});
