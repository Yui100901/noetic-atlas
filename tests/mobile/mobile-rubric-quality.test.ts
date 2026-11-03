import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import initSqlJs from 'sql.js';
import { loadNativeRuntime } from '../helpers/native-runtime.js';

test('offline rubric findings and independent states persist through restart, portable migration and validated SQLite restore', async (t) => {
  const { createLocalRuntime } = await loadNativeRuntime();
  const sql = await initSqlJs({
    locateFile: () => resolve('node_modules/sql.js/dist/sql-wasm.wasm'),
  });
  let durable: Uint8Array | undefined,
    writes = 0;
  const backups = new Map<string, Uint8Array>();
  const storage = {
    async load() {
      return durable?.slice();
    },
    async save(bytes: Uint8Array) {
      durable = bytes.slice();
      writes++;
    },
    async createRecoveryBackup(bytes: Uint8Array) {
      const id = 'rubric-quality-recovery-' + backups.size;
      backups.set(id, bytes.slice());
      return { id, byteLength: bytes.length, createdAt: new Date().toISOString() };
    },
    async loadRecoveryBackup(id: string) {
      return backups.get(id)!.slice();
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
  const api = async (path: string, method = 'GET', payload?: unknown, expected = 200) => {
    const response = await runtime.fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    return value as any;
  };
  const question = await api(
    '/api/questions',
    'POST',
    {
      id: 'NATIVE-RUBRIC',
      title: '离线组合标准',
      type: 'group',
      stemMarkdown: '阅读共同材料，回答两问。',
      mathEnabled: true,
      parts: [
        {
          id: 'format',
          title: '格式',
          type: 'short_answer',
          stemMarkdown: '解释整体性。',
          answerMarkdown: '整体成功或整体回滚。',
          gradingRequirements: '1. 说明整体提交。\n2.',
        },
        {
          id: 'math',
          title: '公式',
          type: 'essay',
          stemMarkdown: '解释表达式。',
          answerMarkdown: '说明表达式含义。',
          gradingRequirements: '$\\notAnAtlasCommand{x}$',
        },
      ],
    },
    201,
  );
  let run = await api(
    '/api/content-quality/scans',
    'POST',
    { filters: { questionId: question.id } },
    201,
  );
  run = await api(`/api/content-quality/scans/${run.id}/process`, 'POST', { batchSize: 1 });
  assert.equal(run.status, 'completed');
  assert.equal(run.ruleCounts.rubric_format, 1);
  assert.equal(run.ruleCounts.math_syntax, 1);
  const list = await api('/api/content-quality/issues?status=all&pageSize=100');
  const format = list.items.find((issue: any) => issue.rule === 'rubric_format'),
    math = list.items.find((issue: any) => issue.rule === 'math_syntax');
  assert.equal(format.partId, 'format');
  assert.equal(math.partId, 'math');
  assert.match(format.evidence, /gradingRequirements.*第2行/);
  assert.match(math.evidence, /gradingRequirements/);
  await api(`/api/content-quality/issues/${format.id}/resolve`, 'POST', {
    status: 'dismissed',
    note: '只忽略本条格式示例，公式问题保留。',
    expectedUpdatedAt: format.updatedAt,
  });
  const before = await api('/api/export'),
    savesBeforeRead = writes;
  await api('/api/content-quality/overview');
  await api('/api/content-quality/issues?rule=rubric_format');
  assert.equal(writes, savesBeforeRead);
  await runtime.close();
  runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false });
  assert.equal((await api('/api/content-quality/issues/' + format.id)).issue.status, 'dismissed');
  assert.equal((await api('/api/content-quality/issues/' + math.id)).issue.status, 'open');
  assert.deepEqual((await api('/api/export')).questions, before.questions);
  const backupResponse = await runtime.fetch('/api/backup.sqlite');
  assert.equal(backupResponse.status, 200);
  const preview = await runtime.previewRestore(
    new Uint8Array(await backupResponse.arrayBuffer()),
    'rubric-quality.sqlite',
  );
  assert.equal(preview.counts.quality_issues, 2);
  await runtime.restore(preview.token);
  assert.equal((await api('/api/content-quality/issues/' + format.id)).issue.status, 'dismissed');
  assert.equal((await api('/api/content-quality/issues/' + math.id)).issue.status, 'open');
  const portable = await api('/api/export');
  await runtime.close();
  durable = undefined;
  runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false });
  await api('/api/import', 'POST', { mode: 'merge', data: portable });
  const imported = await api('/api/export');
  assert.deepEqual(imported.questions, portable.questions);
  assert.deepEqual(imported.qualityIssues, portable.qualityIssues);
  assert.equal((await api('/api/content-quality/issues?rule=rubric_format&status=all')).total, 1);
  assert.equal((await api('/api/content-quality/issues?rule=math_syntax&status=open')).total, 1);
});
