import assert from 'node:assert/strict';
import test from 'node:test';
import { sql } from 'kysely';
import { Store } from '../../server/core/store.js';
import { questionSchema } from '../../server/core/validation.js';
import { exportBudget } from '../../shared/packages/export-budget.js';
import { previewPackageExport } from '../../server/modules/transfer/export-preflight.js';
import { exportDataPackage } from '../../server/modules/transfer/packages.js';

test('export budget covers count, file, expanded and STORE bounds with actionable alternatives', () => {
  const small = {
    questionCount: 1,
    jsonBytes: 100,
    attachmentBytes: 0,
    largestFileBytes: 100,
    fileCount: 1,
    payloadCount: 1,
  };
  assert.equal(exportBudget(small).allowed, true);
  for (const patch of [
    { questionCount: 50001 },
    { largestFileBytes: 81 * 1024 ** 2 },
    { jsonBytes: 257 * 1024 ** 2 },
    { attachmentBytes: 129 * 1024 ** 2 },
    { fileCount: 20001 },
  ]) {
    const report = exportBudget({ ...small, ...patch });
    assert.equal(report.allowed, false);
    assert.ok(report.reasons.length);
    assert.ok(report.recommendations.some((item) => item.href.includes('sub=content')));
  }
  assert.ok(
    exportBudget({ ...small, jsonBytes: 300 * 1024 ** 2 }, 'backup').recommendations.some((item) =>
      item.label.includes('SQLite'),
    ),
  );
});

test('export preflight is read-only, matches selection and bounds a real small ZIP', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.database.close());
  for (const id of ['first', 'second'])
    store.put(
      'questions',
      id,
      questionSchema.parse({
        id,
        title: id,
        type: 'short_answer',
        stemMarkdown: '解释事务',
        answerMarkdown: '整体提交',
        status: 'published',
      }),
    );
  const input = { kind: 'share', selection: { kind: 'questions', ids: ['first'] } };
  const report = previewPackageExport(store, input);
  assert.equal(report.allowed, true);
  assert.equal(report.questionCount, 1);
  const packet = await exportDataPackage(store, input);
  assert.ok(packet.byteLength <= report.estimatedZipBytes);
  assert.equal(store.all('questions').length, 2);
});

test('blocked package exports stop before reading the export bodies or generating a ZIP', async (t) => {
  const store = new Store(':memory:');
  t.after(() => store.database.close());
  store.put(
    'questions',
    'large',
    questionSchema.parse({
      id: 'large',
      title: '大题',
      type: 'short_answer',
      stemMarkdown: '说明原理',
      answerMarkdown: '答案',
      status: 'published',
    }),
  );
  // Inject virtual record byte lengths without allocating a huge fixture.
  store.database.projections.ensure(['questions']);
  store.database.logicalBytes = () => sql<number>`90000000`;
  store.questions = () => {
    throw new Error('export body must not load');
  };
  const input = { kind: 'share', selection: { kind: 'questions', ids: ['large'] } };
  const report = previewPackageExport(store, input);
  assert.equal(report.allowed, false);
  await assert.rejects(
    exportDataPackage(store, input),
    (error: any) =>
      error.code === 'EXPORT_PREFLIGHT_BLOCKED' && error.details.recommendations.length > 0,
  );
});
