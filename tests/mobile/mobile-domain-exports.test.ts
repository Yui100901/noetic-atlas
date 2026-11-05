import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import initSqlJs from 'sql.js';
import { loadNativeRuntime } from '../helpers/native-runtime.js';
import { readDataPackage } from '../../shared/packages/data-package.js';

test('production WASM domain exports create portable ZIPs without durable writes, migrate reviewed content and share as pending', async (t) => {
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
    saves = 0;
  const storage = {
    async load() {
      return durable?.slice();
    },
    async save(bytes: Uint8Array) {
      durable = bytes.slice();
      saves++;
    },
  };
  let runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false });
  t.after(() => runtime.close());
  const api = async (path: string, method = 'GET', data?: unknown, status = 200): Promise<any> => {
    const response = await runtime.fetch(path, {
      method,
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  };
  await api('/api/domains', 'POST', { id: 'native-export', name: '手机领域' }, 201);
  await api(
    '/api/categories',
    'POST',
    { id: 'native-parent', domainId: 'native-export', name: '基础' },
    201,
  );
  await api(
    '/api/categories',
    'POST',
    {
      id: 'native-category',
      domainId: 'native-export',
      name: '详细分类',
      parentId: 'native-parent',
    },
    201,
  );
  await api(
    '/api/tags',
    'POST',
    { id: 'native-tag', domainId: 'native-export', name: '分类标签' },
    201,
  );
  const image = await api(
    '/api/assets',
    'POST',
    {
      filename: '题图.png',
      mimeType: 'image/png',
      dataBase64:
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=',
    },
    201,
  );
  const question = await api(
    '/api/questions',
    'POST',
    {
      id: 'native-domain-question',
      title: '移动导出',
      type: 'short_answer',
      stemMarkdown: `![图](/api/assets/${image.id}/content)`,
      answerMarkdown: '题目答案',
      categoryIds: ['native-category'],
      tagIds: ['native-tag'],
    },
    201,
  );
  await api('/api/questions/review', 'POST', {
    ids: [question.id],
    action: 'approve',
    confirmed: true,
    expectedUpdatedAt: { [question.id]: question.updatedAt },
  });
  await api('/api/study/' + question.id, 'PUT', {
    notes: '不能导出的私人笔记',
    favorite: true,
    mastery: 1,
    nextReviewAt: null,
  });
  const writesBeforeExport = saves;
  const preview = await api('/api/content-exports/preview', 'POST', {
    domainIds: ['native-export'],
    mode: 'per_domain',
  });
  assert.equal(preview.questionCount, 1);
  assert.equal(preview.categories, 2);
  assert.equal(preview.tags, 1);
  const file = await api('/api/content-exports', 'POST', {
    ...preview.scope,
    expectedFingerprint: preview.fingerprint,
  });
  assert.equal(saves, writesBeforeExport, 'POST export queries never trigger a WASM durable save');
  const bytes = Buffer.from(file.dataBase64, 'base64');
  assert.equal(bytes.length, file.byteLength);
  const parsed = await readDataPackage(bytes);
  assert.equal(parsed.manifest.kind, 'migration');
  assert.equal(parsed.payloads.length, 1);
  const migration = parsed.payloads[0]!.data as any;
  assert.ok(
    [...parsed.files.keys()].some((path) => path.startsWith('assets/')),
    'binary image is a manifest-organized file',
  );
  assert.equal(migration.format, undefined);
  assert.equal(migration.questions[0].status, 'published');
  assert.equal(migration.assets.length, 1);
  assert.ok(!JSON.stringify(migration).includes('不能导出的私人笔记'));
  const sharePreview = await api('/api/content-exports/preview', 'POST', {
    domainIds: ['native-export'],
    purpose: 'share',
  });
  const shareFile = await api('/api/content-exports', 'POST', {
    ...sharePreview.scope,
    expectedFingerprint: sharePreview.fingerprint,
  });
  const sharePackage = await readDataPackage(Buffer.from(shareFile.dataBase64, 'base64'));
  assert.equal(sharePackage.manifest.kind, 'share');
  const share = sharePackage.payloads[0]!.data as any;
  assert.equal(share.format, 'learning-share');
  await runtime.close();
  durable = undefined;
  runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false });
  const beforePreview = saves;
  const inspect = await api('/api/packages/preview', 'POST', { dataBase64: file.dataBase64 });
  assert.equal(saves, beforePreview);
  await api('/api/packages/import', 'POST', {
    dataBase64: file.dataBase64,
    expectedFingerprint: inspect.fingerprint,
    confirmed: true,
    confirmedTrusted: true,
  });
  assert.equal(saves, beforePreview + 1, 'a complete package commits once to durable storage');
  assert.equal((await api('/api/questions/' + question.id)).status, 'published');
  assert.equal(
    (await api('/api/assets/' + image.id + '/data')).dataBase64,
    migration.assets[0].dataBase64,
  );
  await runtime.close();
  durable = undefined;
  runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false });
  await api('/api/import', 'POST', { data: share, mode: 'merge' }, 400);
  const shareInspect = await api('/api/packages/preview', 'POST', {
    dataBase64: shareFile.dataBase64,
  });
  await api('/api/packages/import', 'POST', {
    dataBase64: shareFile.dataBase64,
    expectedFingerprint: shareInspect.fingerprint,
    confirmed: true,
  });
  assert.equal((await api('/api/questions/' + question.id)).status, 'pending');
  await runtime.close();
  runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false });
  assert.equal((await api('/api/questions/' + question.id)).status, 'pending');
});
