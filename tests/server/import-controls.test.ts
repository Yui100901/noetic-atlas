import assert from 'node:assert/strict';
import test from 'node:test';
import { unzipSync, zipSync } from 'fflate';
import { Store } from '../../server/core/store.js';
import { questionSchema } from '../../server/core/validation.js';
import {
  applyQuestionImport,
  previewQuestionImport,
} from '../../server/modules/question-imports/service.js';
import { exportShare, importShare, planShareImport } from '../../server/modules/sharing/service.js';
import { previewDataPackage, importDataPackage } from '../../server/modules/transfer/packages.js';
import { buildDataPackage, packageSha256 } from '../../shared/packages/data-package.js';
import { QUESTION_HASHES_PATH } from '../../shared/packages/question-hashes.js';
import { bytesToBase64 } from '../../shared/assets/assets.js';
import type { Question } from '../../shared/models/types.js';
import { buildApp } from '../../server/index.js';

const stamp = '2026-11-06T00:00:00.000Z';
const fixture = (t: test.TestContext) => {
  const store = new Store(':memory:');
  t.after(() => store.database.close());
  return store;
};
const question = (id: string, categoryIds: string[] = [], answer = '完整提交') =>
  ({
    ...questionSchema.parse({
      id,
      title: '事务',
      type: 'short_answer',
      stemMarkdown: '解释事务边界',
      answerMarkdown: answer,
      categoryIds,
      status: 'published',
    }),
    id,
    createdAt: stamp,
    updatedAt: stamp,
  }) as Question;
function taxonomy(store: Store, prefix: string, name: string) {
  store.put('domains', prefix, { id: prefix, name, description: '', sortOrder: 0 });
  store.put('categories', prefix + '-c', {
    id: prefix + '-c',
    name: '基础',
    domainId: prefix,
    parentId: null,
    description: '',
    sortOrder: 0,
  });
  return prefix + '-c';
}
test('disabled dedup never consults its index and preserves every new row while remapping conflicting IDs', (t) => {
  const store = fixture(t),
    local = question('same');
  store.put('questions', local.id, local);
  store.database.imports.ensure = () => {
    throw new Error('must not scan dedup index');
  };
  const incoming = [question('same'), question('different')];
  const preview = previewQuestionImport(store, incoming, undefined, { enabled: false });
  assert.equal(preview.enabled, false);
  assert.equal(preview.metrics.indexed, 0);
  assert.equal(preview.metrics.hashesComputed, 0);
  const result = applyQuestionImport(store, incoming, {
    enabled: false,
    expectedFingerprint: preview.fingerprint,
  });
  assert.equal(result.added, 2);
  assert.equal(store.all('questions').length, 3);
  assert.notEqual(result.items[0]!.id, 'same');
  assert.equal(store.get<Question>('questions', 'same')!.status, 'published');
  assert.ok(result.items.every((item) => item.status === 'pending'));
});
test('domain scoping limits similar candidates, spans child classifications, and keeps global exact fallback', (t) => {
  const store = fixture(t),
    en = taxonomy(store, 'en', '英语'),
    ja = taxonomy(store, 'ja', '日语');
  store.put('categories', 'en-child', {
    id: 'en-child',
    name: '第二分类',
    domainId: 'en',
    parentId: en,
    description: '',
    sortOrder: 1,
  });
  store.put('questions', 'english', question('english', [en]));
  const other = previewQuestionImport(store, [question('source', [ja], '新答案')]);
  assert.equal(other.counts.new, 1);
  const same = previewQuestionImport(store, [question('source', ['en-child'], '新答案')]);
  assert.equal(same.counts.similar, 1);
  const exact = previewQuestionImport(store, [question('source', [ja])]);
  assert.equal(exact.counts.exact, 1);
  const unknown = previewQuestionImport(store, [question('source', [], '新答案')]);
  assert.equal(unknown.counts.similar, 1);
});
test('another domain cannot evict a small domain from bounded batch similarity postings', (t) => {
  const store = fixture(t),
    en = taxonomy(store, 'en', '英语'),
    ja = taxonomy(store, 'ja', '日语');
  const incoming = [question('en-first', [en], '英语来源答案')];
  for (let index = 0; index < 60; index++)
    incoming.push(question(`ja-${index}`, [ja], `日语来源答案 ${index}`));
  incoming.push(question('en-last', [en], '英语更新答案'));
  const preview = previewQuestionImport(store, incoming);
  assert.equal(preview.items.at(-1)!.kind, 'similar');
  assert.ok(preview.items.at(-1)!.candidates.some((candidate) => candidate.incomingIndex === 0));
  assert.ok(preview.items.at(-1)!.candidates.every((candidate) => candidate.incomingIndex === 0));
  assert.ok(preview.metrics.compared <= incoming.length * preview.metrics.candidateLimit);
});
test('share mapping is applied before dedup and remaps domains/categories/tags without changing local metadata', (t) => {
  const source = fixture(t),
    target = fixture(t),
    sc = taxonomy(source, 'biology', '生物学'),
    tc = taxonomy(target, 'bio', '生物');
  source.put('tags', 'source-tag', {
    id: 'source-tag',
    name: '生物概念',
    domainId: 'biology',
    kind: 'topic',
    description: '',
    color: '#123456',
  });
  target.put('tags', 'target-tag', {
    id: 'target-tag',
    name: '通用概念',
    domainId: null,
    kind: 'method',
    description: '',
    color: '#123456',
  });
  const q = { ...question('source-q', [sc], '新答案'), tagIds: ['source-tag'] };
  source.put('questions', q.id, q);
  target.put('questions', 'local', question('local', [tc]));
  const pack = exportShare(source, { kind: 'questions', ids: [q.id] });
  const taxonomyMapping = {
    domains: [{ sourceId: 'biology', targetId: 'bio' }],
    categories: [{ sourceId: sc, targetId: tc }],
    tags: [{ sourceId: 'source-tag', targetId: 'target-tag' }],
  };
  assert.equal(planShareImport(target, pack).dedup.counts.new, 1);
  const plan = planShareImport(target, pack, {}, true, { taxonomyMapping });
  assert.equal(plan.dedup.counts.similar, 1);
  importShare(
    target,
    pack,
    plan.preview.fingerprint,
    { expectedFingerprint: plan.dedup.fingerprint, decisions: [{ key: 'i-0', action: 'both' }] },
    { taxonomyMapping },
  );
  const saved = target.all<Question>('questions').find((item) => item.id !== 'local')!;
  assert.deepEqual(saved.categoryIds, [tc]);
  assert.deepEqual(saved.tagIds, ['target-tag']);
  assert.equal(target.get('domains', 'bio').name, '生物');
  assert.equal(target.all('domains').length, 1);
});
test('renamed taxonomy collisions are deterministic, and cross-domain category targets fail before writes', (t) => {
  const source = fixture(t),
    target = fixture(t),
    sc = taxonomy(source, 'same', '生物学');
  taxonomy(target, 'same', '物理学');
  const wrong = taxonomy(target, 'other', '化学');
  source.put('questions', 'source', question('source', [sc]));
  const pack = exportShare(source, { kind: 'questions', ids: ['source'] });
  const context = { taxonomyMapping: { domains: [{ sourceId: 'same', name: '生物专题' }] } };
  const first = planShareImport(target, pack, { enabled: false }, true, context),
    second = planShareImport(target, pack, { enabled: false }, true, context);
  assert.equal(first.preview.fingerprint, second.preview.fingerprint);
  importShare(
    target,
    pack,
    first.preview.fingerprint,
    { enabled: false, expectedFingerprint: first.dedup.fingerprint },
    context,
  );
  assert.equal(target.get('domains', 'same').name, '物理学');
  assert.ok(target.all('domains').some((row) => row.name === '生物专题'));
  assert.throws(
    () =>
      planShareImport(target, pack, {}, true, {
        taxonomyMapping: { categories: [{ sourceId: sc, targetId: wrong }] },
      }),
    (error: any) => error.code === 'IMPORT_TAXONOMY_DOMAIN_MISMATCH',
  );
});
test('package controls bind preview fingerprints and validated sidecar hashes reuse only verified exact content', async (t) => {
  const source = fixture(t),
    target = fixture(t);
  const q = question('source');
  source.put('questions', q.id, q);
  target.put('questions', 'local', question('local'));
  const share = exportShare(source, { kind: 'questions', ids: [q.id] });
  const bytes = await buildDataPackage({
    kind: 'share',
    title: '控制验证',
    payloads: [{ path: 'data/content.json', data: share }],
  });
  const dataBase64 = bytesToBase64(bytes),
    checked = await previewDataPackage(target, { dataBase64 });
  assert.equal(checked.dedup!.counts.exact, 1);
  assert.equal(checked.dedup!.metrics.hashesReused, 1);
  const unchecked = await previewDataPackage(target, { dataBase64, dedup: { enabled: false } });
  assert.equal(unchecked.dedup!.enabled, false);
  await assert.rejects(
    importDataPackage(target, {
      dataBase64,
      confirmed: true,
      expectedFingerprint: checked.fingerprint,
      dedup: { enabled: false },
    }),
    (error: any) => error.code === 'PACKAGE_PREVIEW_STALE',
  );
  await importDataPackage(target, {
    dataBase64,
    confirmed: true,
    expectedFingerprint: unchecked.fingerprint,
    dedup: { enabled: false },
  });
  assert.equal(target.all('questions').length, 2);
});
test('a fully rechecksummed hash hint cannot hide an exact duplicate or merge differing content', async (t) => {
  const source = fixture(t),
    target = fixture(t);
  const local = question('local');
  target.put('questions', local.id, local);
  const build = async (answer: string, forgedHash: string) => {
    const incoming = question('source', [], answer);
    source.put('questions', incoming.id, incoming);
    const share = exportShare(source, { kind: 'questions', ids: [incoming.id] });
    const files = unzipSync(
      await buildDataPackage({
        kind: 'share',
        title: '不可信缓存',
        payloads: [{ path: 'data/content.json', data: share }],
      }),
    );
    const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));
    const manifest = decode(files['manifest.json']!);
    const sidecar = decode(files[QUESTION_HASHES_PATH]!);
    sidecar.payloads[0].hashes[0][0] = forgedHash;
    const encoded = new TextEncoder().encode(JSON.stringify(sidecar));
    files[QUESTION_HASHES_PATH] = encoded;
    Object.assign(
      manifest.files.find((file: any) => file.path === QUESTION_HASHES_PATH),
      { byteLength: encoded.length, sha256: await packageSha256(encoded) },
    );
    files['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));
    return bytesToBase64(zipSync(files));
  };
  const falseMiss = await previewDataPackage(target, {
    dataBase64: await build(local.answerMarkdown, 'f'.repeat(64)),
  });
  assert.equal(falseMiss.dedup!.counts.exact, 1);
  assert.equal(falseMiss.dedup!.metrics.hashesReused, 0);
  assert.equal(falseMiss.dedup!.metrics.hashesComputed, 1);
  const index = target.database.one(
    target.database.query
      .selectFrom('question_import_index')
      .select('content_hash')
      .where('id', '=', local.id),
  )!;
  const falseHit = await previewDataPackage(target, {
    dataBase64: await build('不同的参考答案', index.content_hash),
  });
  assert.equal(falseHit.dedup!.counts.exact, 0);
  assert.equal(falseHit.dedup!.counts.similar, 1);
  assert.equal(falseHit.dedup!.metrics.hashesComputed, 1);
  assert.equal(target.all('questions').length, 1);
});
test('HTTP question and share previews preserve the selected dedup mode and taxonomy mapping', async (t) => {
  const source = fixture(t),
    categoryId = taxonomy(source, 'biology', '生物');
  source.put('questions', 'source', question('source', [categoryId]));
  const data = exportShare(source, { kind: 'questions', ids: ['source'] });
  const app = await buildApp({
    databasePath: ':memory:',
    dailyPushScheduler: false,
    logger: false,
  });
  t.after(() => app.close());
  const post = async (url: string, payload: object, status = 200) => {
    const response = await app.inject({ method: 'POST', url, payload });
    assert.equal(response.statusCode, status, response.body);
    return response.json();
  };
  await post('/api/domains', { id: 'bio', name: '生物学' }, 201);
  await post('/api/categories', { id: 'bio-basic', domainId: 'bio', name: '基础' }, 201);
  const controls = {
    dedup: { enabled: false },
    taxonomyMapping: {
      domains: [{ sourceId: 'biology', targetId: 'bio' }],
      categories: [{ sourceId: categoryId, targetId: 'bio-basic' }],
    },
  };
  const preview = await post('/api/sharing/preview', { data, ...controls });
  assert.equal(preview.dedup.enabled, false);
  await post('/api/sharing/import', {
    data,
    ...controls,
    confirmed: true,
    expectedFingerprint: preview.fingerprint,
  });
  const exported = (await app.inject('/api/export')).json();
  assert.equal(exported.domains.length, 1);
  assert.deepEqual(exported.questions[0].categoryIds, ['bio-basic']);
  const questionPreview = await post('/api/questions/import-preview', {
    data: {
      format: 'learning-new-questions',
      schemaVersion: 1,
      questions: [{ ...question('other', ['bio-basic']) }],
    },
    dedup: { enabled: false },
  });
  assert.equal(questionPreview.enabled, false);
  assert.equal(questionPreview.counts.new, 1);
});
