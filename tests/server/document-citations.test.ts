import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { PDFDocument } from 'pdf-lib';
import { Store } from '../../server/core/store.js';
import { ApiError, documentCitationSchema, questionSchema } from '../../server/core/validation.js';
import { registerLibraryRoutes } from '../../server/modules/library/routes.js';
import { registerQuestionRoutes } from '../../server/modules/questions/routes.js';
import { registerQuestionImportRoutes } from '../../server/modules/questions/import-routes.js';
import { registerDocumentDraftRoutes } from '../../server/modules/library/document-drafts.js';
import { registerAssetRoutes } from '../../server/modules/assets/routes.js';
import { exportData, importData } from '../../server/modules/transfer/migration.js';
import { exportShare, importShare } from '../../server/modules/sharing/service.js';
import { assetIsReferenced } from '../../server/modules/assets/service.js';
import {
  documentContentVersion,
  readDocumentSource,
  validateDocumentCitations,
} from '../../server/modules/library/sources.js';
import { buildPaper } from '../../server/modules/practice/service.js';

async function fixture(t: test.TestContext) {
  const store = new Store(':memory:'),
    app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError)
      return reply
        .code(error.status)
        .send({ error: { code: error.code, message: error.message, details: error.details } });
    return reply.code(500).send({ error: { message: error.message } });
  });
  registerLibraryRoutes(app, store);
  registerQuestionRoutes(app, store);
  registerQuestionImportRoutes(app, store);
  registerDocumentDraftRoutes(app, store);
  registerAssetRoutes(app, store);
  t.after(async () => {
    await app.close();
    store.db.close();
  });
  const api = async (
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
    body?: unknown,
    status = 200,
  ) => {
    const response = await app.inject({
      url: path,
      method,
      ...(body === undefined ? {} : { payload: body }),
    });
    assert.equal(response.statusCode, status, response.body);
    return response.json();
  };
  const document = await api(
    '/api/documents',
    'POST',
    {
      id: 'book',
      title: '程序设计教材',
      kind: '书籍',
      bodyMarkdown: '# 第一章\n\n变量把名称与值关联。\n\n表达式产生值。',
    },
    201,
  );
  const version = documentContentVersion(document);
  const citation = (extra = {}) => ({
    documentId: 'book',
    versionId: version,
    title: document.title,
    relation: 'summarized',
    label: '第一章',
    excerpt: '变量把名称与值关联。',
    ...extra,
  });
  const question = (extra = {}) => ({
    title: '什么是变量？',
    type: 'short_answer',
    stemMarkdown: '请说明变量名称与值的关系。',
    answerMarkdown: '变量把名称与值关联。',
    documentLinks: [citation()],
    ...extra,
  });
  return { store, app, api, document, version, citation, question };
}

test('reading a source is pure; linking a question captures one immutable version', async (t) => {
  const f = await fixture(t);
  const { exportedAt: _exported, ...before } = exportData(f.store);
  const detail = await f.api('/api/documents/book');
  assert.equal(detail.contentVersion, f.version);
  const original = await f.api(`/api/documents/book/versions/${f.version}`);
  assert.equal(original.bodyMarkdown, f.document.bodyMarkdown);
  const { exportedAt: _later, ...after } = exportData(f.store);
  assert.deepEqual(after, before);
  const question = await f.api('/api/questions', 'POST', f.question(), 201);
  assert.equal(question.status, 'pending');
  assert.equal(question.documentLinks[0].versionId, f.version);
  assert.equal(f.store.all('document_versions').length, 1);
  await f.api('/api/questions', 'POST', f.question({ title: '另一个变量问题' }), 201);
  assert.equal(f.store.all('document_versions').length, 1);
});

test('source edits and archive preserve old references and signal changed content', async (t) => {
  const f = await fixture(t);
  await f.api('/api/questions', 'POST', f.question(), 201);
  await f.api('/api/documents/book', 'PUT', {
    ...f.document,
    title: '新版程序设计教材',
    bodyMarkdown: '新版正文已经改变。',
  });
  let source = await f.api(`/api/documents/book/versions/${f.version}`);
  assert.equal(source.bodyMarkdown, f.document.bodyMarkdown);
  assert.notEqual(source.currentVersionId, source.versionId);
  assert.equal(source.currentTitle, '新版程序设计教材');
  await f.api('/api/documents/book', 'DELETE');
  source = await f.api(`/api/documents/book/versions/${f.version}`);
  assert.equal(source.archived, true);
  assert.equal(source.bodyMarkdown, f.document.bodyMarkdown);
  assert.equal((await f.api('/api/documents/book/questions')).total, 1);
});

test('title-only edits retain source identity and draft publishing preserves previous content', async (t) => {
  const f = await fixture(t);
  const renamed = await f.api('/api/documents/book', 'PUT', { ...f.document, title: '教材重命名' });
  assert.equal(documentContentVersion(renamed), f.version);
  const { id: _id, updatedAt: _stamp, ...state } = renamed;
  const draft = await f.api(
    '/api/document-drafts',
    'POST',
    {
      documentId: 'book',
      baseDocumentUpdatedAt: renamed.updatedAt,
      state: { ...state, bodyMarkdown: '草稿发布的新正文。' },
    },
    201,
  );
  await f.api(`/api/document-drafts/${draft.id}/publish`, 'POST', {
    expectedUpdatedAt: draft.updatedAt,
  });
  const source = await f.api(`/api/documents/book/versions/${f.version}`);
  assert.equal(source.bodyMarkdown, f.document.bodyMarkdown);
});

test('schema and source validation reject invented excerpts, wrong ranges and mixed locator kinds atomically', async (t) => {
  const f = await fixture(t);
  for (const change of [
    { startOffset: 4 },
    { startOffset: 8, endOffset: 3 },
    { pageStart: 4, pageEnd: 2 },
    { documentId: null },
    { versionId: 'invented' },
    { pageStart: 2, startOffset: 0, endOffset: 4 },
  ])
    assert.equal(
      documentCitationSchema.safeParse(f.citation(change)).success,
      false,
      JSON.stringify(change),
    );
  for (const change of [
    { excerpt: '不存在的原文' },
    { startOffset: 0, endOffset: 2, excerpt: '变量把名称与值关联。' },
    { endOffset: 999, startOffset: 0 },
    { pageStart: 1 },
    { documentId: 'missing' },
  ]) {
    await f.api(
      '/api/questions',
      'POST',
      f.question({ documentLinks: [f.citation(change)] }),
      change.documentId ? 404 : 400,
    );
    assert.equal(f.store.all('questions').length, 0);
    assert.equal(f.store.all('document_versions').length, 0);
  }
});

test('bulk imports and pending JSON edits validate source links and roll back whole batches', async (t) => {
  const f = await fixture(t);
  await f.api(
    '/api/questions/bulk-import',
    'POST',
    {
      confirmed: true,
      data: {
        format: 'learning-new-questions',
        schemaVersion: 1,
        questions: [
          f.question(),
          f.question({ documentLinks: [f.citation({ excerpt: '杜撰文字' })] }),
        ],
      },
    },
    400,
  );
  assert.equal(f.store.all('questions').length, 0);
  assert.equal(f.store.all('document_versions').length, 0);
  const created = await f.api('/api/questions', 'POST', f.question(), 201);
  const updated = await f.api('/api/questions/pending/import', 'POST', {
    confirmed: true,
    data: {
      format: 'learning-pending-questions',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      questions: [{ ...created, documentLinks: [f.citation({ relation: 'reference' })] }],
    },
  });
  assert.equal(updated.items[0].documentLinks[0].relation, 'reference');
});

test('related questions are paged metadata, combine constraints on one citation and refresh after updates', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 12; i++)
    await f.api('/api/questions', 'POST', f.question({ id: 'Q' + i, title: `变量问题${i}` }), 201);
  const all = f.store.all.bind(f.store);
  f.store.all = ((table: any) => {
    assert.notEqual(table, 'questions', 'reverse lookup must not load full question bodies');
    return all(table);
  }) as typeof f.store.all;
  let page = await f.api('/api/documents/book/questions?page=2&pageSize=10');
  assert.equal(page.total, 12);
  assert.equal(page.items.length, 2);
  assert.ok(page.items.every((q: any) => !('answerMarkdown' in q) && !('stemMarkdown' in q)));
  assert.equal((await f.api('/api/documents/book/questions?search=问题11')).total, 1);
  assert.equal((await f.api('/api/documents/book/questions?pageNumber=5')).total, 0);
  const q = f.store.require('questions', 'Q1');
  await f.api('/api/questions/Q1', 'PUT', { ...q, documentLinks: [] });
  page = await f.api('/api/documents/book/questions');
  assert.equal(page.total, 11);
});

test('JSON migration retains linked versions including orphaned snapshots; corrupted source identity rolls back', async (t) => {
  const f = await fixture(t);
  await f.api('/api/questions', 'POST', f.question({ id: 'Q' }), 201);
  await f.api('/api/documents/book', 'PUT', { ...f.document, bodyMarkdown: '新版本。' });
  const data = exportData(f.store),
    target = new Store(':memory:');
  t.after(() => target.db.close());
  importData(target, data);
  assert.equal(readDocumentSource(target, 'book', f.version).bodyMarkdown, f.document.bodyMarkdown);
  validateDocumentCitations(target, target.require('questions', 'Q'));
  const corrupt = structuredClone(data) as any;
  corrupt.documentVersions[0].bodyMarkdown = '篡改版本正文';
  const empty = new Store(':memory:');
  t.after(() => empty.db.close());
  assert.throws(() => importData(empty, corrupt), /摘要或身份无效/);
  assert.equal(empty.all('questions').length, 0);
  target.remove('documents', 'book');
  assert.equal(readDocumentSource(target, 'book', f.version).archived, true);
});

test('frozen paper source references survive later source and question replacement', async (t) => {
  const f = await fixture(t);
  let q = await f.api('/api/questions', 'POST', f.question({ id: 'Q' }), 201);
  f.store.put('questions', 'Q', { ...q, status: 'published' });
  const paper = buildPaper(f.store, {
    title: '原文练习',
    description: '',
    mode: 'manual',
    questionIds: ['Q'],
  });
  await f.api('/api/documents/book', 'PUT', { ...f.document, bodyMarkdown: '新版内容。' });
  q = f.store.require('questions', 'Q');
  await f.api('/api/questions/Q', 'PUT', { ...q, documentLinks: [] });
  assert.equal(paper.snapshot[0].documentLinks![0].versionId, f.version);
  assert.equal(
    readDocumentSource(f.store, 'book', f.version).bodyMarkdown,
    f.document.bodyMarkdown,
  );
});

test('social sharing detaches foreign source IDs, keeps citation context and never exports entire textbooks', async (t) => {
  const f = await fixture(t);
  await f.api('/api/questions', 'POST', f.question({ id: 'Q' }), 201);
  const data = exportShare(f.store, { kind: 'questions', ids: ['Q'] });
  assert.equal(data.questions[0].documentLinks![0].documentId, null);
  assert.equal(data.questions[0].documentLinks![0].versionId, null);
  assert.equal(data.questions[0].documentLinks![0].excerpt, '变量把名称与值关联。');
  assert.ok(!JSON.stringify(data).includes('表达式产生值。'));
  const target = new Store(':memory:');
  t.after(() => target.db.close());
  importShare(target, data);
  assert.equal(target.require('questions', 'Q').documentLinks[0].documentId, null);
  assert.equal(importShare(f.store, data).counts.questions!.reused, 1);
});

test('PDF references retain replaced files as assets and reject Markdown offset locators', async (t) => {
  const f = await fixture(t);
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]);
  const first = await f.api(
    '/api/assets',
    'POST',
    {
      filename: 'book.pdf',
      mimeType: 'application/pdf',
      dataBase64: Buffer.from(await pdf.save()).toString('base64'),
    },
    201,
  );
  const doc = await f.api(
      '/api/documents',
      'POST',
      { id: 'pdf', title: 'PDF教材', format: 'pdf', assetId: first.id },
      201,
    ),
    version = documentContentVersion(doc);
  const citation = {
    ...f.citation(),
    documentId: 'pdf',
    versionId: version,
    title: 'PDF教材',
    pageStart: 1,
    pageEnd: 1,
    excerpt: '',
  };
  await f.api('/api/questions', 'POST', f.question({ documentLinks: [citation] }), 201);
  assert.equal((await f.api('/api/documents/pdf/questions?pageNumber=1')).total, 1);
  await f.api(
    '/api/questions',
    'POST',
    f.question({
      documentLinks: [
        { ...citation, pageStart: undefined, pageEnd: undefined, startOffset: 0, endOffset: 1 },
      ],
    }),
    400,
  );
  pdf.addPage();
  const second = await f.api(
    '/api/assets',
    'POST',
    {
      filename: 'new.pdf',
      mimeType: 'application/pdf',
      dataBase64: Buffer.from(await pdf.save()).toString('base64'),
    },
    201,
  );
  await f.api('/api/documents/pdf', 'PUT', { ...doc, assetId: second.id });
  assert.equal(readDocumentSource(f.store, 'pdf', version).assetId, first.id);
  assert.equal(assetIsReferenced(f.store, first.id), true);
  await f.api(`/api/assets/${first.id}`, 'DELETE', undefined, 409);
});
