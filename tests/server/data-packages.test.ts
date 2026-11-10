import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../../server/index.js';
import { buildDataPackage, readDataPackage } from '../../shared/packages/data-package.js';
import { fixtureQuestion, learningSeed } from '../fixtures/learning-seed.js';

async function fixture(t: test.TestContext) {
  const app = await buildApp({
    databasePath: ':memory:',
    dailyPushScheduler: false,
    logger: false,
  });
  t.after(() => app.close());
  const call = async (url: string, payload?: unknown, status = 200) => {
    const response = await app.inject({
      url,
      ...(payload === undefined ? {} : { method: 'POST', payload: payload as object }),
    });
    assert.equal(response.statusCode, status, response.body);
    return response.json();
  };
  const preview = (dataBase64: string) => call('/api/packages/preview', { dataBase64 });
  const commit = (dataBase64: string, fingerprint: string, extra = {}, status = 200) =>
    call(
      '/api/packages/import',
      { dataBase64, expectedFingerprint: fingerprint, confirmed: true, ...extra },
      status,
    );
  return { call, preview, commit };
}

test('exported single-question and paper packages import as pending, while trusted backup retains status', async (t) => {
  const source = await fixture(t),
    receiver = await fixture(t),
    migration = await fixture(t);
  await source.call('/api/import', { mode: 'merge', data: learningSeed() });
  const paperResponse = await source.call(
    '/api/papers',
    { title: '分享题集', mode: 'manual', questionIds: ['FIXTURE-BOOL'] },
    201,
  );
  for (const selection of [
    { kind: 'questions', id: 'FIXTURE-BOOL' },
    { kind: 'paper', id: paperResponse.id },
  ]) {
    const file = await source.call('/api/packages/export', { kind: 'share', selection });
    assert.match(file.filename, /\.zip$/);
    const opened = await readDataPackage(Buffer.from(file.dataBase64, 'base64'));
    assert.equal(opened.manifest.kind, 'share');
    const preview = await receiver.preview(file.dataBase64);
    assert.equal(preview.kind, 'share');
    await receiver.commit(file.dataBase64, preview.fingerprint);
  }
  const shared = await receiver.call('/api/export');
  assert.equal(shared.questions.length, 1);
  assert.equal(shared.questions[0].status, 'pending');
  assert.equal(shared.papers[0].archived, true);

  const backup = await source.call('/api/packages/export', { kind: 'migration' });
  const preview = await migration.preview(backup.dataBase64);
  assert.equal(preview.counts.questions.added, 6);
  const refusal = await migration.commit(backup.dataBase64, preview.fingerprint, {}, 400);
  assert.equal(refusal.error.code, 'PACKAGE_TRUST_CONFIRMATION_REQUIRED');
  assert.equal((await migration.call('/api/export')).questions.length, 0);
  await migration.commit(backup.dataBase64, preview.fingerprint, { confirmedTrusted: true });
  assert.ok(
    (await migration.call('/api/export')).questions.every(
      (q: { status: string }) => q.status === 'published',
    ),
  );
});

test('split migration is atomic, deduplicates records and rejects conflicting or stale inputs', async (t) => {
  const receiver = await fixture(t);
  const seed = learningSeed(),
    [first, second] = seed.questions;
  const make = async (other: typeof first, duplicate = first) =>
    Buffer.from(
      await buildDataPackage({
        kind: 'migration',
        title: '多分片迁移',
        payloads: [
          { path: 'data/part-001.json', data: { ...seed, questions: [first] } },
          { path: 'data/part-002.json', data: { ...seed, questions: [duplicate, other] } },
        ],
      }),
    ).toString('base64');
  const bad = await make({ ...second, categoryIds: ['missing-category'] });
  const badPreview = await receiver.preview(bad);
  assert.equal(badPreview.counts.questions.added, 2);
  await receiver.commit(bad, badPreview.fingerprint, { confirmedTrusted: true }, 400);
  assert.equal((await receiver.call('/api/export')).questions.length, 0);
  assert.equal((await receiver.call('/api/export')).domains.length, 0);
  const conflict = await make(second, { ...first, title: '相同题号不同内容' });
  assert.equal(
    (await receiver.call('/api/packages/preview', { dataBase64: conflict }, 400)).error.code,
    'PACKAGE_RECORD_CONFLICT',
  );
  const good = await make(second);
  const preview = await receiver.preview(good);
  await receiver.call('/api/import', { mode: 'merge', data: { ...seed, questions: [first] } });
  assert.equal(
    (await receiver.commit(good, preview.fingerprint, { confirmedTrusted: true }, 409)).error.code,
    'PACKAGE_PREVIEW_STALE',
  );
  const fresh = await receiver.preview(good);
  assert.equal(fresh.counts.questions.added, 1);
  await receiver.commit(good, fresh.fingerprint, { confirmedTrusted: true });
  assert.equal((await receiver.call('/api/export')).questions.length, 2);
});

test('template creates pending questions and editing their package preserves revision safeguards', async (t) => {
  const { call, preview, commit } = await fixture(t);
  const template = await call('/api/packages/export', { kind: 'question-template' });
  assert.ok(
    (await readDataPackage(Buffer.from(template.dataBase64, 'base64'))).files.has(
      'taxonomy/reference.json',
    ),
  );
  const encode = async (kind: 'question-template' | 'question-update', data: unknown) =>
    Buffer.from(
      await buildDataPackage({
        kind,
        title: '批量编辑验收',
        payloads: [{ path: 'data/questions.json', data }],
      }),
    ).toString('base64');
  const question = fixtureQuestion('NEW-PACK', 'true_false', { categoryIds: [], tagIds: [] });
  const added = await encode('question-template', {
    format: 'learning-new-questions',
    schemaVersion: 1,
    questions: [question],
  });
  await commit(added, (await preview(added)).fingerprint);
  const exported = await call('/api/packages/export', {
    kind: 'question-update',
    ids: [question.id],
  });
  const opened = await readDataPackage(Buffer.from(exported.dataBase64, 'base64'));
  const raw = opened.payloads[0]!.data as { questions: (typeof question)[] };
  assert.equal(raw.questions[0]!.status, 'pending');
  raw.questions[0]!.title = '修改后的题目';
  const modified = await encode('question-update', raw);
  const checked = await preview(modified);
  await commit(modified, checked.fingerprint);
  assert.equal((await call('/api/export')).questions[0].title, '修改后的题目');
  assert.equal((await call('/api/export')).questions[0].status, 'pending');
  const revisions = (await call('/api/export')).questionRevisions;
  assert.equal(revisions.length, 2);
  assert.ok(
    revisions.every((revision: { questionId: string }) => revision.questionId === question.id),
  );
  await call('/api/packages/preview', { dataBase64: modified }, 409);
});

test('current packaged backups preserve filters and distinguish absent from explicitly cleared detail history', async (t) => {
  const source = await fixture(t);
  await source.call('/api/import', { mode: 'merge', data: learningSeed() });
  const paper = await source.call(
    '/api/papers',
    {
      title: '当前备份恢复',
      mode: 'manual',
      questionIds: ['FIXTURE-BOOL'],
    },
    201,
  );
  const attempt = await source.call(`/api/papers/${paper.id}/attempts`, {}, 201);
  await source.call(`/api/attempts/${attempt.id}/submit`, {
    answers: { 'FIXTURE-BOOL': { value: 'true' } },
  });
  const backup = await source.call('/api/export');
  backup.papers[0].filters = { types: ['true_false'] };
  for (const result of backup.learningResults) delete result.historyIndexed;
  delete backup.questionHistory;
  for (const explicitHistory of [false, true]) {
    const receiver = await fixture(t);
    const bytes = await buildDataPackage({
      kind: 'migration',
      title: '当前格式备份',
      payloads: [
        {
          path: 'data/backup.json',
          data: {
            ...backup,
            ...(explicitHistory ? { questionHistory: [] } : {}),
          },
        },
      ],
    });
    const dataBase64 = Buffer.from(bytes).toString('base64');
    const preview = await receiver.preview(dataBase64);
    await receiver.commit(dataBase64, preview.fingerprint, { confirmedTrusted: true });
    const restored = await receiver.call('/api/export');
    assert.deepEqual(restored.papers[0].filters, { types: ['true_false'] });
    assert.equal(restored.questionHistory.length, explicitHistory ? 0 : 1);
  }
  const refused = await fixture(t);
  const invalid = structuredClone(backup);
  invalid.papers[0].filters.bankId = 'retired-bank';
  const bytes = await buildDataPackage({
    kind: 'migration',
    title: '包含退役筛选字段的包',
    payloads: [{ path: 'data/backup.json', data: invalid }],
  });
  const error = await refused.call(
    '/api/packages/preview',
    {
      dataBase64: Buffer.from(bytes).toString('base64'),
    },
    400,
  );
  assert.equal(error.error.code, 'VALIDATION_ERROR');
  assert.ok(
    error.error.details.some((item: { message: string }) => item.message.includes('bankId')),
  );
  const untouched = await refused.call('/api/export');
  assert.equal(untouched.questions.length, 0);
  assert.equal(untouched.papers.length, 0);
});

test('exported migration packages preserve an intentionally cleared question history', async (t) => {
  const source = await fixture(t),
    reexporter = await fixture(t),
    receiver = await fixture(t);
  await source.call('/api/import', { mode: 'merge', data: learningSeed() });
  const paper = await source.call(
    '/api/papers',
    { title: '空单题历史往返', mode: 'manual', questionIds: ['FIXTURE-BOOL'] },
    201,
  );
  const attempt = await source.call(`/api/papers/${paper.id}/attempts`, {}, 201);
  await source.call(`/api/attempts/${attempt.id}/submit`, {
    answers: { 'FIXTURE-BOOL': { value: 'true' } },
  });
  const backup = await source.call('/api/export');
  backup.questionHistory = [];
  for (const result of backup.learningResults) delete result.historyIndexed;
  await reexporter.call('/api/import', { mode: 'merge', data: backup });
  assert.equal((await reexporter.call('/api/export')).questionHistory.length, 0);

  const file = await reexporter.call('/api/packages/export', { kind: 'migration' });
  const opened = await readDataPackage(Buffer.from(file.dataBase64, 'base64'));
  assert.ok(opened.payloads.some(({ data }) => Object.hasOwn(data as object, 'questionHistory')));
  const preview = await receiver.preview(file.dataBase64);
  await receiver.commit(file.dataBase64, preview.fingerprint, { confirmedTrusted: true });
  const restored = await receiver.call('/api/export');
  assert.equal(restored.attempts.length, 1, 'whole-attempt history remains available');
  assert.equal(
    restored.questionHistory.length,
    0,
    'export does not recreate cleared detail history',
  );
});
