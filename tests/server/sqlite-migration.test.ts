import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import Fastify from 'fastify';
import { Store } from '../../server/core/store.js';
import { fixtureQuestion, learningSeed } from '../fixtures/learning-seed.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';
import {
  buildPaper,
  createAttempt,
  submitAttempt,
  createQuickAttempt,
} from '../../server/modules/practice/service.js';
import {
  exportSQLiteMigration,
  sqliteMigrationPlan,
} from '../../server/modules/transfer/sqlite-migration.js';
import { registerTransferRoutes } from '../../server/modules/transfer/routes.js';
import { ApiError, documentSchema } from '../../server/core/validation.js';
import { archiveAttemptQuestionHistory } from '../../server/modules/questions/history-store.js';
import { captureDocumentVersion } from '../../server/modules/library/sources.js';
import { createAsset } from '../../server/modules/assets/service.js';

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-migration-test-')),
    store = new Store(':memory:'),
    copies: Store[] = [];
  t.after(() => {
    store.database.close();
    for (const copy of copies) copy.database.close();
    const target = resolve(dir);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('atlas-migration-test-'));
    rmSync(target, { recursive: true, force: true });
  });
  const seed = learningSeed();
  for (const table of ['domains', 'categories', 'tags', 'questions'] as const)
    for (const row of seed[table]) store.put(table, row.id, row);
  store.put('domains', 'other', { id: 'other', name: '其他领域', description: '', sortOrder: 1 });
  store.put('categories', 'other-category', {
    id: 'other-category',
    domainId: 'other',
    parentId: null,
    name: '其他基础',
    description: '',
    sortOrder: 0,
  });
  store.put(
    'questions',
    'OTHER-DEPENDENCY',
    fixtureQuestion('OTHER-DEPENDENCY', 'true_false', {
      categoryIds: ['other-category'],
      tagIds: [],
    }),
  );
  store.put(
    'questions',
    'OTHER-PRIVATE',
    fixtureQuestion('OTHER-PRIVATE', 'true_false', {
      stemMarkdown: 'PRIVATE-UNRELATED-BODY-MUST-NOT-LEAK',
      categoryIds: ['other-category'],
      tagIds: [],
    }),
  );
  store.put('settings', 'system', structuredClone(DEFAULT_SETTINGS));
  const paper = buildPaper(store, {
    id: 'mixed',
    title: '跨领域题集',
    description: '',
    mode: 'manual',
    questionIds: ['FIXTURE-BOOL', 'OTHER-DEPENDENCY'],
  });
  store.put('papers', paper.id, paper);
  const otherPaper = buildPaper(store, {
    id: 'unrelated',
    title: '不相关题集',
    description: '',
    mode: 'manual',
    questionIds: ['OTHER-DEPENDENCY', 'OTHER-PRIVATE'],
  });
  store.put('papers', otherPaper.id, otherPaper);
  const attempt = submitAttempt(store, createAttempt(store, paper), {
    'FIXTURE-BOOL': { value: 'false' },
    'OTHER-DEPENDENCY': { value: 'true' },
  });
  const draft = createAttempt(store, paper);
  submitAttempt(store, createAttempt(store, otherPaper), { 'OTHER-PRIVATE': { value: 'false' } });
  const stamp = '2026-11-06T00:00:00.000Z';
  store.put('study', 'FIXTURE-BOOL', {
    questionId: 'FIXTURE-BOOL',
    favorite: true,
    mastery: 1,
    notes: '保留领域笔记',
    nextReviewAt: null,
    lastReviewedAt: null,
    wrongCount: 2,
  });
  store.database.putRecord('ai_settings', 'local', {
    enabled: true,
    baseUrl: 'https://example.com/v1',
    model: 'test',
    supportsImages: false,
    sendImages: false,
    timeoutSeconds: 60,
    maxTokens: 8192,
    key: 'SECRET-MIGRATION-TEST',
  });
  const run = {
    id: 'AI-MIGRATION',
    kind: 'explain',
    status: 'completed',
    createdAt: stamp,
    model: 'test',
    result: { explanationMarkdown: '解释历史', followUpsMarkdown: '', pitfallsMarkdown: '' },
    questionIds: ['FIXTURE-BOOL'],
    warnings: [],
    _context: { questionVersions: {}, sourceByItem: {} },
  };
  store.database.putRecord('ai_runs', run.id, run);
  const otherRun = {
    ...run,
    id: 'AI-UNRELATED',
    questionIds: ['OTHER-PRIVATE'],
    result: { ...run.result, explanationMarkdown: 'PRIVATE-UNRELATED-AI-MUST-NOT-LEAK' },
  };
  store.database.putRecord('ai_runs', otherRun.id, otherRun);
  const open = (bytes: Uint8Array) => {
    const path = join(dir, `copy-${crypto.randomUUID()}.sqlite`);
    writeFileSync(path, bytes);
    const copy = new Store(path);
    copies.push(copy);
    return copy;
  };
  return { store, attempt, draft, open };
}

test('domain SQLite migration preserves whole mixed attempts, drafts, learning evidence and AI history without reverse scope expansion', async (t) => {
  const { store, attempt, draft, open } = fixture(t),
    before = store.database.records('attempts');
  // Prepopulate all caches; excluded content must disappear from them as well.
  store.database.projections.refreshAll();
  store.database.imports.ensure();
  const selection = { domainIds: ['fixture-computer'] },
    plan = sqliteMigrationPlan(store, selection);
  assert.equal(plan.preview.seedQuestions, 6);
  assert.equal(plan.preview.dependencyQuestions, 1);
  const result = await exportSQLiteMigration(store, selection, plan.preview.fingerprint),
    copy = open(result.bytes);
  assert.equal(copy.all('questions').length, 7);
  assert.equal(copy.get('questions', 'OTHER-PRIVATE'), undefined);
  assert.ok(copy.get('papers', 'mixed'));
  assert.equal(copy.get('papers', 'unrelated'), undefined);
  assert.deepEqual(copy.get('attempts', attempt.id), store.get('attempts', attempt.id));
  assert.deepEqual(copy.get('attempts', draft.id), store.get('attempts', draft.id));
  assert.ok(copy.get('learning_results', attempt.id));
  assert.equal(copy.get('study', 'FIXTURE-BOOL').notes, '保留领域笔记');
  assert.equal(copy.database.getRecord<any>('ai_settings', 'local').key, '');
  assert.ok(copy.database.getRecord('ai_runs', 'AI-MIGRATION'));
  assert.equal(copy.database.getRecord('ai_runs', 'AI-UNRELATED'), undefined);
  assert.equal(
    copy.database.one(
      copy.database.query
        .selectFrom('question_import_index')
        .select('id')
        .where('id', '=', 'OTHER-PRIVATE'),
    ),
    undefined,
  );
  assert.equal(
    copy.database.one(
      copy.database.query
        .selectFrom('search_read_model')
        .select('source_id')
        .where('source_id', '=', 'OTHER-PRIVATE'),
    ),
    undefined,
  );
  const bytes = Buffer.from(result.bytes);
  for (const secret of [
    'SECRET-MIGRATION-TEST',
    'PRIVATE-UNRELATED-BODY-MUST-NOT-LEAK',
    'PRIVATE-UNRELATED-AI-MUST-NOT-LEAK',
  ])
    assert.equal(bytes.includes(Buffer.from(secret)), false);
  assert.deepEqual(store.database.records('attempts'), before);
  assert.equal(store.database.getRecord<any>('ai_settings', 'local').key, 'SECRET-MIGRATION-TEST');
  assert.equal(copy.database.storageHealth(true).integrity?.[0], 'ok');
});

test('overall SQLite migration retains private records and standalone drafts, while stale previews reject before export', async (t) => {
  const { store, open } = fixture(t),
    selection = { domainIds: [] };
  store.put('ai_workspace_drafts', 'unscoped-ai-draft', {
    id: 'unscoped-ai-draft',
    kind: 'import',
    contextId: null,
    state: { text: '独立导入草稿' },
    createdAt: '2026-11-06T00:00:00.000Z',
    updatedAt: '2026-11-06T00:00:00.000Z',
  });
  const stale = sqliteMigrationPlan(store, selection).preview;
  store.put('study', 'OTHER-PRIVATE', {
    questionId: 'OTHER-PRIVATE',
    favorite: false,
    mastery: null,
    notes: '预览后改变',
    nextReviewAt: null,
    lastReviewedAt: null,
    wrongCount: 0,
  });
  await assert.rejects(
    exportSQLiteMigration(store, selection, stale.fingerprint),
    (error: any) => error.code === 'MIGRATION_PREVIEW_STALE',
  );
  const preview = sqliteMigrationPlan(store, selection).preview,
    output = await exportSQLiteMigration(store, selection, preview.fingerprint),
    copy = open(output.bytes);
  assert.equal(preview.scope, 'all');
  assert.equal(copy.all('questions').length, 8);
  assert.equal(copy.database.records('ai_runs').length, 2);
  assert.ok(copy.get('ai_workspace_drafts', 'unscoped-ai-draft'));
  assert.equal(copy.database.getRecord<any>('ai_settings', 'local').key, '');
  assert.equal(store.database.records<any>('ai_settings')[0].key, 'SECRET-MIGRATION-TEST');
});

test('migration API validates domain selection and requires a current preview for SQLite downloads', async (t) => {
  const { store } = fixture(t),
    app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError)
      reply.code(error.status).send({ code: error.code, message: error.message });
    else reply.code(500).send({ message: error.message });
  });
  registerTransferRoutes(app, store);
  t.after(() => app.close());
  const unknown = await app.inject({
    method: 'POST',
    url: '/api/migrations/preview',
    payload: { domainIds: ['absent'] },
  });
  assert.equal(unknown.statusCode, 400);
  const preview = (
    await app.inject({
      method: 'POST',
      url: '/api/migrations/preview',
      payload: { domainIds: ['fixture-computer'] },
    })
  ).json();
  const response = await app.inject(
    `/api/migrations/database?domainIds=${encodeURIComponent(JSON.stringify(['fixture-computer']))}&fingerprint=${preview.fingerprint}`,
  );
  assert.equal(response.statusCode, 200, response.body.slice(0, 100));
  assert.match(String(response.headers['content-type']), /sqlite3/);
  assert.equal(Number(response.headers['content-length']), response.rawPayload.length);
  assert.equal(response.rawPayload.subarray(0, 16).toString(), 'SQLite format 3\0');
});

test('domain migration retains cited source versions, associated editing drafts/assets and independent answers after whole-history cleanup', async (t) => {
  const { store, open } = fixture(t),
    stamp = '2026-11-06T00:00:00.000Z';
  const image = createAsset(store, {
    filename: 'source.png',
    mimeType: 'image/png',
    dataBase64:
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  });
  const unused = createAsset(store, {
    filename: 'unused.png',
    mimeType: 'image/png',
    dataBase64:
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  });
  const document = documentSchema.parse({
    id: 'other-book',
    title: '来自其他领域的引用原文',
    kind: '书籍',
    domainIds: ['other'],
    categoryIds: ['other-category'],
    bodyMarkdown: `原文内容 ![示意](/api/assets/${image.id}/content)`,
  });
  store.put('documents', document.id, document);
  store.put(
    'documents',
    'unrelated-book',
    documentSchema.parse({
      ...document,
      id: 'unrelated-book',
      title: '不相关教材',
      bodyMarkdown: 'PRIVATE-UNRELATED-SOURCE-BODY',
    }),
  );
  const version = captureDocumentVersion(store, document),
    question = store.require<any>('questions', 'FIXTURE-BOOL');
  store.put('questions', question.id, {
    ...question,
    documentLinks: [
      {
        documentId: document.id,
        versionId: version.versionId,
        title: document.title,
        relation: 'reference',
        label: '引用',
        excerpt: '原文内容',
      },
    ],
  });
  const { id: _documentId, updatedAt: _updatedAt, ...draftState } = document;
  store.put('document_drafts', 'source-edit-draft', {
    id: 'source-edit-draft',
    documentId: document.id,
    baseDocumentUpdatedAt: stamp,
    state: { ...draftState, bodyMarkdown: '未完成的原文编辑' },
    createdAt: stamp,
    updatedAt: stamp,
  });
  const quick = submitAttempt(store, createQuickAttempt(store, { questionId: 'FIXTURE-BOOL' }), {
    'FIXTURE-BOOL': { value: 'false' },
  });
  archiveAttemptQuestionHistory(store, quick);
  store.remove('attempts', quick.id);
  const selection = { domainIds: ['fixture-computer'] },
    preview = sqliteMigrationPlan(store, selection).preview;
  assert.equal(preview.counts.assets, 1);
  assert.equal(preview.counts.documents, 1);
  assert.equal(preview.counts.document_drafts, 1);
  const result = await exportSQLiteMigration(store, selection, preview.fingerprint),
    copy = open(result.bytes);
  assert.ok(copy.get('documents', document.id));
  assert.ok(copy.get('document_versions', version.id));
  assert.ok(copy.get('document_drafts', 'source-edit-draft'));
  assert.ok(copy.get('assets', image.id));
  assert.equal(copy.get('assets', unused.id), undefined);
  assert.equal(copy.get('documents', 'unrelated-book'), undefined);
  const independent = copy.all<any>('question_history').find((row) => row.attemptId === quick.id)!;
  assert.equal(copy.get('attempts', quick.id), undefined);
  assert.equal(independent.detail.answer.value, 'false');
  assert.equal(
    Buffer.from(result.bytes).includes(Buffer.from('PRIVATE-UNRELATED-SOURCE-BODY')),
    false,
  );
});

test('domain migration preserves independent summaries and FSRS chains for deleted roots identified only by retained history snapshots', async (t) => {
  const { store, open } = fixture(t),
    questionId = 'DELETED-ROOT';
  store.put('domains', 'retired-domain', {
    id: 'retired-domain',
    name: '只剩历史的领域',
    description: '',
    sortOrder: 2,
  });
  store.put('categories', 'retired-category', {
    id: 'retired-category',
    domainId: 'retired-domain',
    parentId: null,
    name: '历史分类',
    description: '',
    sortOrder: 0,
  });
  store.put(
    'questions',
    questionId,
    fixtureQuestion(questionId, 'true_false', { categoryIds: ['retired-category'], tagIds: [] }),
  );
  const attempt = submitAttempt(store, createQuickAttempt(store, { questionId }), {
    [questionId]: { value: 'true' },
  });
  archiveAttemptQuestionHistory(store, attempt);
  store.remove('attempts', attempt.id);
  store.remove('questions', questionId);
  if (store.get('study', questionId)) store.remove('study', questionId);
  // Old compact summaries may omit classification metadata. The retained
  // detailed response is now the sole evidence that this was in the domain.
  const result = store.require<any>('learning_results', attempt.id);
  result.items = result.items.map(
    ({ categoryIds: _categories, tagIds: _tags, ...item }: any) => item,
  );
  store.put('learning_results', result.id, result);
  const cards = store.all<any>('review_cards').filter((row) => row.questionId === questionId);
  const events = store.all<any>('review_events').filter((row) => row.questionId === questionId);
  assert.equal(cards.length, 1);
  assert.equal(events.length, 1);
  const selection = { domainIds: ['retired-domain'] },
    preview = sqliteMigrationPlan(store, selection).preview;
  assert.equal(preview.counts.questions, 0);
  assert.equal(preview.seedQuestions, 0);
  assert.equal(preview.counts.question_history, 1);
  const exported = await exportSQLiteMigration(store, selection, preview.fingerprint),
    copy = open(exported.bytes);
  assert.equal(copy.get('questions', questionId), undefined);
  assert.equal(copy.get('attempts', attempt.id), undefined);
  assert.deepEqual(copy.get('learning_results', attempt.id), result);
  assert.equal(
    copy.all<any>('question_history').filter((row) => row.questionId === questionId).length,
    1,
  );
  assert.deepEqual(
    copy.all<any>('review_cards').filter((row) => row.questionId === questionId),
    cards,
  );
  assert.deepEqual(
    copy.all<any>('review_events').filter((row) => row.questionId === questionId),
    events,
  );
});
