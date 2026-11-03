import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { Store } from '../../server/core/store.js';
import { questionSchema } from '../../server/core/validation.js';
import { buildApp } from '../../server/index.js';
import { registerHttpSecurity } from '../../server/http/security.js';
import {
  buildContentExport,
  CONTENT_EXPORT_LIMITS,
  previewContentExport,
  registerContentExportRoutes,
} from '../../server/modules/transfer/domain-exports.js';
import { importData } from '../../server/modules/transfer/migration.js';
import { exportShare, importShare } from '../../server/modules/sharing/routes.js';
import {
  contentExportContext,
  detachQuestionLinks,
} from '../../server/modules/sharing/export-content.js';
import { sharePackageSchema, validateShareExport } from '../../server/modules/sharing/schema.js';
import { readStoredZip } from '../helpers/stored-zip.js';
import type { ContentExportSelection } from '../../shared/models/domain-exports.js';
import type { Question } from '../../shared/models/types.js';

const stamp = '2026-11-03T00:00:00.000Z';
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=';
const secret = 'PRIVATE-EXPORT-CANARY';
function fixture(t: test.TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  return store;
}
function seed(store: Store) {
  for (const id of ['computer', 'english', 'empty']) {
    store.put('domains', id, { id, name: id, description: '', sortOrder: 0 });
    store.put('categories', id + '-root', {
      id: id + '-root',
      domainId: id,
      name: id,
      parentId: null,
      description: '',
      sortOrder: 0,
    });
  }
  store.put('categories', 'backend', {
    id: 'backend',
    domainId: 'computer',
    name: '后端',
    parentId: 'computer-root',
    description: '',
    sortOrder: 0,
  });
  store.put('tags', 'topic', {
    id: 'topic',
    name: '重点',
    domainId: 'computer',
    color: '#123456',
    description: '',
    kind: 'topic',
  });
  store.put('assets', 'diagram', {
    id: 'diagram',
    filename: '图.png',
    mimeType: 'image/png',
    dataBase64: png,
    sizeBytes: Buffer.from(png, 'base64').length,
    width: 1,
    height: 1,
    createdAt: stamp,
  });
  store.put('assets', 'unused-book', {
    id: 'unused-book',
    filename: secret + '.pdf',
    mimeType: 'application/pdf',
    dataBase64: Buffer.from(secret).toString('base64'),
    sizeBytes: secret.length,
    createdAt: stamp,
  });
}
function add(store: Store, id: string, fields: Partial<Question> = {}) {
  const q = {
    ...questionSchema.parse({
      id,
      title: id,
      type: 'short_answer',
      stemMarkdown: '解释此概念。',
      answerMarkdown: '概念含义。',
      categoryIds: ['backend'],
      tagIds: ['topic'],
      status: 'published',
      ...fields,
    }),
    id,
    createdAt: stamp,
    updatedAt: stamp,
  } as Question;
  store.put('questions', id, q);
  return q;
}
function build(store: Store, input: ContentExportSelection) {
  const preview = previewContentExport(store, input);
  return buildContentExport(store, { ...input, expectedFingerprint: preview.fingerprint });
}
const json = (value: Uint8Array) => JSON.parse(new TextDecoder().decode(value));
const decode = (file: { dataBase64: string; byteLength: number }) => {
  const value = Buffer.from(file.dataBase64, 'base64');
  assert.equal(file.byteLength, value.length);
  return value;
};

test('domain catalog has metadata-only scoped counts and stable scope-bound fingerprints', (t) => {
  const store = fixture(t);
  seed(store);
  add(store, 'shared', { categoryIds: ['backend', 'english-root'] });
  add(store, 'pending', { status: 'pending' });
  add(store, 'personal', { collection: 'personal' });
  const calls: string[] = [],
    original = store.database.all.bind(store.database);
  store.database.all = (query: any) => {
    calls.push(('compile' in query ? query.compile() : query).sql);
    return original(query);
  };
  const catalog = previewContentExport(store, { domainIds: [] });
  assert.equal(catalog.questionCount, 0);
  assert.equal(catalog.domains.find((d) => d.id === 'computer')!.questionCount, 3);
  assert.ok(
    !calls.some((query) => /select "data" from "questions"/.test(query)),
    'preview never fetches question bodies',
  );
  const all = previewContentExport(store, { domainIds: ['computer', 'english', 'empty'] });
  assert.equal(all.questionCount, 3);
  assert.equal(all.memberships, 4);
  assert.deepEqual(all.emptyDomainIds, ['empty']);
  assert.equal(all.categories, 3);
  assert.equal(all.tags, 1);
  assert.ok(all.estimatedQuestionBytes > 0);
  assert.equal(
    previewContentExport(store, { domainIds: ['empty', 'english', 'computer'] }).fingerprint,
    all.fingerprint,
  );
  const sharing = previewContentExport(store, { domainIds: ['computer'], purpose: 'share' });
  assert.equal(sharing.questionCount, 1);
  assert.equal(sharing.scope.status, 'published');
  assert.equal(sharing.scope.collection, 'general');
  assert.throws(
    () =>
      buildContentExport(store, {
        domainIds: ['computer'],
        purpose: 'share',
        expectedFingerprint: all.fingerprint,
      }),
    /重新预览/,
  );
  assert.throws(() => previewContentExport(store, { domainIds: ['missing'] }), /领域不存在/);
});

test('trusted domain migration keeps admission, taxonomy ancestors and images without private state or textbook originals', (t) => {
  const store = fixture(t);
  seed(store);
  add(store, 'selected', {
    status: 'published',
    collection: 'personal',
    stemMarkdown: '![图](/api/assets/diagram/content)',
    sourceDocument: secret,
    sourceAnchor: secret,
    sourceRefs: [{ label: '来源及许可', url: 'https://example.test/license' }],
    documentLinks: [
      {
        documentId: secret,
        versionId: 'a'.repeat(64),
        title: '公开教材',
        relation: 'summarized',
        label: '第二章',
        pageStart: 2,
        excerpt: '可分享摘录',
      },
    ],
    study: {
      questionId: 'selected',
      notes: secret,
      favorite: true,
      mastery: 1,
      nextReviewAt: null,
      lastReviewedAt: null,
      wrongCount: 0,
    },
    partStudies: [{ questionId: 'selected', notes: secret } as any],
    feedbackSummary: { note: secret } as any,
  });
  store.put('questions', 'selected', {
    ...store.require<Question>('questions', 'selected'),
    study: { notes: secret },
    partStudies: [{ notes: secret }],
    feedbackSummary: { note: secret },
    unexpectedPrivateField: secret,
  });
  add(store, 'unselected', { categoryIds: ['english-root'], tagIds: [], title: secret });
  for (const status of ['pending', 'draft', 'archived'] as const) add(store, status, { status });
  store.put('settings', 'system', { secret });
  store.database.putRecord('ai_settings', 'local', { apiKey: secret });
  store.put('documents', secret, { id: secret, bodyMarkdown: secret, assetId: 'unused-book' });
  store.put('question_drafts', secret, { id: secret, secret });
  store.put('question_revisions', secret, { id: secret, secret });
  const file = build(store, { domainIds: ['computer'] }),
    bytes = decode(file),
    pack = json(bytes);
  assert.ok(
    !JSON.stringify(exportShare(store, { kind: 'questions', ids: ['selected'] })).includes(secret),
    'ordinary shares use the same positive authoring boundary',
  );
  assert.equal(file.mimeType, 'application/json');
  assert.ok(!bytes.toString().includes(secret));
  assert.equal(pack.format, undefined);
  assert.equal(pack.schemaVersion, 1);
  assert.equal(pack.questions.length, 4);
  assert.deepEqual(
    new Set(pack.questions.map((q: Question) => q.status)),
    new Set(['published', 'pending', 'draft', 'archived']),
  );
  assert.deepEqual(
    pack.assets.map((a: any) => a.id),
    ['diagram'],
  );
  assert.equal(pack.assets[0].dataBase64, png);
  assert.deepEqual(
    new Set(pack.categories.map((c: any) => c.id)),
    new Set(['backend', 'computer-root']),
  );
  assert.deepEqual(pack.documents, []);
  assert.equal(pack.settings, undefined);
  assert.equal(pack.study, undefined);
  const citation = pack.questions.find((q: Question) => q.id === 'selected').documentLinks[0];
  assert.equal(citation.title, '公开教材');
  assert.equal(citation.documentId, null);
  assert.equal(citation.versionId, null);
  assert.equal(citation.pageStart, 2);
  const target = fixture(t);
  importData(target, pack);
  assert.equal(target.require<Question>('questions', 'selected').collection, 'personal');
  assert.equal(target.require<Question>('questions', 'selected').status, 'published');
  assert.equal(target.require<Question>('questions', 'draft').status, 'draft');
  assert.equal(target.all('study').length, 0);
  assert.equal(target.all('documents').length, 0);
});

test('share exports are admitted through the sharing gate; backup imports reject every formatted content package', (t) => {
  const source = fixture(t);
  seed(source);
  add(source, 'source');
  add(source, 'private', { collection: 'personal' });
  const pack = json(decode(build(source, { domainIds: ['computer'], purpose: 'share' })));
  assert.equal(pack.format, 'learning-share');
  assert.deepEqual(
    pack.questions.map((q: Question) => q.id),
    ['source'],
  );
  assert.equal(pack.questions[0].status, 'pending');
  const target = fixture(t);
  importShare(target, pack);
  assert.equal(target.require<Question>('questions', 'source').status, 'pending');
  for (const format of [
    'learning-share',
    'learning-new-questions',
    'learning-pending-questions',
    'unexpected',
  ])
    assert.throws(() => importData(target, { ...pack, format }), /只接受可信迁移/);
});

test('per-domain ZIP parts are independently importable, complete beyond 500 and retain cross-domain memberships', (t) => {
  const source = fixture(t);
  seed(source);
  source.transaction(() => {
    for (let index = 0; index < 1001; index++)
      add(source, `q-${String(index).padStart(5, '0')}`, {
        categoryIds: index === 0 ? ['backend', 'english-root'] : ['backend'],
        explanationMarkdown:
          '[外部分片](#/questions/q-01000) [网页](https://example.test/#/questions/external)',
      });
  });
  const combined = json(decode(build(source, { domainIds: ['computer', 'english'] })));
  assert.equal(combined.questions.length, 1001, 'combined does not inherit the part size cap');
  const file = build(source, { domainIds: ['computer', 'english', 'empty'], mode: 'per_domain' });
  const files = readStoredZip(decode(file)),
    manifest = json(files.get('manifest.json')!);
  assert.equal(file.mimeType, 'application/zip');
  assert.equal(file.summary.fileCount, 4);
  assert.equal(manifest.questionCount, 1001);
  assert.equal(manifest.memberships, 1002);
  assert.deepEqual(manifest.emptyDomainIds, ['empty']);
  const target = fixture(t),
    all = new Set<string>();
  for (const entry of manifest.files) {
    const bytes = files.get(entry.filename)!,
      pack = json(bytes),
      independent = fixture(t);
    assert.ok(entry.questionCount <= 500);
    assert.equal(entry.byteLength, bytes.byteLength);
    assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'));
    importData(independent, pack);
    assert.equal(independent.all('questions').length, entry.questionCount);
    importData(target, pack);
    for (const q of pack.questions) all.add(q.id);
  }
  assert.equal(all.size, 1001);
  assert.equal(target.all('questions').length, 1001);
  const firstComputerPart = manifest.files.find(
    (file: any) => file.domainId === 'computer' && file.part === 1,
  ).filename;
  assert.match(
    json(files.get(firstComputerPart)!).questions[0].explanationMarkdown,
    /关联题未包含在本文件/,
  );
  assert.match(
    json(files.get(firstComputerPart)!).questions[0].explanationMarkdown,
    /https:\/\/example.test\/#\/questions\/external/,
  );
});

test('source body, assets, taxonomy, mode and scope changes invalidate the preview without mutations', (t) => {
  const store = fixture(t);
  seed(store);
  const q = add(store, 'source');
  const scope = { domainIds: ['computer'] },
    preview = previewContentExport(store, scope);
  const original = JSON.stringify(store.all('questions'));
  buildContentExport(store, { ...scope, expectedFingerprint: preview.fingerprint });
  assert.equal(JSON.stringify(store.all('questions')), original);
  assert.throws(
    () =>
      buildContentExport(store, {
        ...scope,
        mode: 'per_domain',
        expectedFingerprint: preview.fingerprint,
      }),
    /重新预览/,
  );
  store.put('questions', q.id, { ...q, answerMarkdown: '更改含义。' });
  assert.throws(
    () => buildContentExport(store, { ...scope, expectedFingerprint: preview.fingerprint }),
    /重新预览/,
  );
  const afterQuestion = previewContentExport(store, scope);
  store.put('assets', 'diagram', { ...store.get('assets', 'diagram'), filename: '新图.png' });
  assert.throws(
    () => buildContentExport(store, { ...scope, expectedFingerprint: afterQuestion.fingerprint }),
    /重新预览/,
  );
  const afterAsset = previewContentExport(store, scope);
  store.put('categories', 'backend', { ...store.get('categories', 'backend'), name: '新分类名' });
  assert.throws(
    () => buildContentExport(store, { ...scope, expectedFingerprint: afterAsset.fingerprint }),
    /重新预览/,
  );
});

test('shared cross-domain parts keep the same semantic question content and reuse duplicates on import', (t) => {
  const source = fixture(t);
  seed(source);
  add(source, 'shared', {
    categoryIds: ['backend', 'english-root'],
    explanationMarkdown: '[参考](#/questions/neighbor) #/questions/neighbor',
  });
  add(source, 'neighbor');
  const file = build(source, {
    domainIds: ['computer', 'english'],
    purpose: 'share',
    mode: 'per_domain',
  });
  const files = readStoredZip(decode(file)),
    manifest = json(files.get('manifest.json')!);
  const target = fixture(t),
    exported = [] as Question[];
  for (const entry of manifest.files) {
    const pack = json(files.get(entry.filename)!);
    exported.push(pack.questions.find((q: Question) => q.id === 'shared'));
    const result = importShare(target, pack);
    assert.equal(result.counts.questions!.remapped, 0);
  }
  assert.equal(target.all('questions').length, 2);
  assert.equal(target.require<Question>('questions', 'shared').status, 'pending');
  assert.deepEqual(exported[0], exported[1]);
  assert.match(exported[0]!.explanationMarkdown, /#\/questions\?search=neighbor/);
  assert.equal(exported[0]!.explanationMarkdown.includes('未包含'), false);
  assert.match(
    new TextDecoder().decode(files.get('README.md')!),
    /全部关联题详情链接统一转为题号搜索/,
  );
});

test('empty ranges, invalid dependencies and malformed HTTP selections fail clearly', async (t) => {
  const store = fixture(t);
  seed(store);
  assert.throws(() => build(store, { domainIds: [] }), /至少选择/);
  assert.throws(() => build(store, { domainIds: ['empty'] }), /没有题目/);
  const q = add(store, 'missing-image', { stemMarkdown: '![缺图](/api/assets/missing/content)' });
  assert.throws(() => build(store, { domainIds: ['computer'] }), /附件 missing/);
  store.put('questions', q.id, { ...q, stemMarkdown: '普通内容', tagIds: ['missing-tag'] });
  assert.throws(() => build(store, { domainIds: ['computer'] }), /标签 missing-tag/);
  const app = Fastify();
  registerHttpSecurity(app, store);
  registerContentExportRoutes(app, store);
  t.after(() => app.close());
  for (const body of [
    { domainIds: ['computer', 'computer'] },
    { domainIds: ['computer'], purpose: 'wrong' },
    { domainIds: ['computer'], status: 'wrong' },
    { domainIds: ['computer'], unexpected: true },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/content-exports/preview',
      payload: body,
    });
    assert.equal(response.statusCode, 400);
  }
  assert.equal(CONTENT_EXPORT_LIMITS.maxCombinedBytes, 80 * 1024 * 1024 - 1024);
});

test('reusable export helpers do not resolve unselected question bodies or missing local links', (t) => {
  const store = fixture(t);
  seed(store);
  const q = add(store, 'source');
  assert.throws(
    () => contentExportContext(store).dependencies([{ ...q, categoryIds: ['missing'] }]),
    /分类 missing/,
  );
  const result = detachQuestionLinks(
    '[词](#/questions/escaped%20id) #/questions/raw [外](https://example.test/#/questions/raw)',
    new Set<string>(),
  );
  assert.match(result, /关联题未包含/);
  assert.match(result, /#\/questions\?search=raw/);
  assert.match(result, /https:\/\/example.test\/#\/questions\/raw/);
});

test('share producer and recipient enforce the same attachment-count limit even for small payloads', (t) => {
  const source = fixture(t);
  seed(source);
  add(source, 'source', { stemMarkdown: '![图](/api/assets/diagram/content)' });
  const pack = json(decode(build(source, { domainIds: ['computer'], purpose: 'share' })));
  // Reuse the tiny record in this schema boundary fixture, avoiding a large
  // database or binary allocation while crossing the real recipient limit.
  pack.assets = Array.from({ length: 10001 }, (_, index) => ({
    ...pack.assets[0],
    id: `image-${index}`,
  }));
  assert.ok(Buffer.byteLength(JSON.stringify(pack)) < CONTENT_EXPORT_LIMITS.maxCombinedBytes);
  const accepted = sharePackageSchema.safeParse(pack);
  assert.equal(accepted.success, false);
  assert.throws(
    () => validateShareExport(pack),
    (error: any) =>
      error.code === 'CONTENT_EXPORT_INVALID_SHARE' &&
      error.details.some((issue: any) => issue.path === 'assets'),
  );
  const target = fixture(t);
  assert.throws(
    () => importShare(target, pack),
    (error: any) =>
      error.code === 'VALIDATION_ERROR' &&
      error.details.some((issue: any) => issue.path === 'assets'),
  );
  assert.equal(target.all('questions').length, 0);
});

test('production routes expose accurate OpenAPI and stay behind exam access locks', async (t) => {
  const app = await buildApp({ databasePath: ':memory:', dailyPushScheduler: false });
  t.after(() => app.close());
  const source = fixture(t);
  seed(source);
  add(source, 'source');
  const imported = await app.inject({
    method: 'POST',
    url: '/api/import',
    payload: { data: json(decode(build(source, { domainIds: ['computer'] }))), mode: 'merge' },
  });
  assert.equal(imported.statusCode, 200, imported.body);
  const catalog = await app.inject({
    method: 'POST',
    url: '/api/content-exports/preview',
    payload: { domainIds: ['computer'] },
  });
  assert.equal(catalog.statusCode, 200);
  const preview = catalog.json();
  assert.equal(preview.questionCount, 1);
  const file = await app.inject({
    method: 'POST',
    url: '/api/content-exports',
    payload: { ...preview.scope, expectedFingerprint: preview.fingerprint },
  });
  assert.equal(file.statusCode, 200);
  assert.equal(file.json().summary.questionCount, 1);
  const docs = (await app.inject('/api/openapi.json')).json();
  assert.ok(
    docs.paths['/api/content-exports/preview'].post.requestBody.content['application/json'].schema
      .properties.domainIds,
  );
  assert.ok(
    docs.paths['/api/content-exports'].post.responses['200'].content['application/json'].schema
      .properties.dataBase64,
  );
  const paper = (
    await app.inject({
      method: 'POST',
      url: '/api/papers',
      payload: { title: '考试卷', mode: 'manual', questionIds: ['source'] },
    })
  ).json();
  const exam = await app.inject({
    method: 'POST',
    url: `/api/papers/${paper.id}/attempts`,
    payload: { mode: 'exam' },
  });
  assert.equal(exam.statusCode, 201, exam.body);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/content-exports/preview',
        payload: { domainIds: ['computer'] },
      })
    ).statusCode,
    409,
  );
});
