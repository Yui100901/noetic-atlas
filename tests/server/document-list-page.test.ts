import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../server/index.js';
import { DatabaseConnection } from '../../server/database/connection.js';
import type { DocumentRecord } from '../../shared/models/types.js';

const stamp = '2026-10-29T00:00:00.000Z';
const tail = 'BOOK_BODY_TAIL_MUST_NOT_CROSS_DRIVER';
async function fixture(t: test.TestContext) {
  let database: DatabaseConnection | undefined;
  const original = DatabaseConnection.prototype.all;
  const capture = t.mock.method(DatabaseConnection.prototype, 'all', function (this: DatabaseConnection, query: Parameters<typeof original>[0]) { database ||= this; return original.call(this, query); });
  const app = await buildApp({ databasePath: ':memory:', staticRoot: 'missing-library-page-web', seedPath: 'missing-library-page-seed', dailyPushScheduler: false, native: true });
  capture.mock.restore(); t.after(() => app.close()); assert.ok(database);
  const api = async (url: string, status = 200) => { const reply = await app.inject(url); assert.equal(reply.statusCode, status, reply.body); return reply.json(); };
  database.putRecord('domains', 'science', { id: 'science', name: '科学', description: '', sortOrder: 0 });
  database.putRecord('categories', 'science-root', { id: 'science-root', domainId: 'science', parentId: null, name: '基础', description: '', sortOrder: 0 });
  database.putRecord('categories', 'science-child', { id: 'science-child', domainId: 'science', parentId: 'science-root', name: '子分类', description: '', sortOrder: 0 });
  database.putRecord('tags', 'concept', { id: 'concept', name: '概念', domainId: null, kind: 'topic', color: '#39c5bb', description: '' });
  return { app, database, api };
}
function document(index: number): DocumentRecord & { _archived?: boolean } {
  return { id: 'D-' + index, title: 'ÉCOLE 南京 %_ ' + index, kind: index % 2 ? '书籍' : '学习笔记', bodyMarkdown: '# 简短预览\n' + '合成教材内容。'.repeat(2000) + tail,
    collection: index % 3 ? 'general' : 'personal', categoryIds: index % 2 ? ['science-child'] : [], tagIds: ['concept'], sourcePath: null,
    updatedAt: stamp, author: 'ÅUTHOR', publisher: '出版社', description: '', _archived: index % 7 === 0 };
}

test('library card pagination keeps full text within the driver and preserves filtering, ordering and old detail contracts', async t => {
  const { database, api } = await fixture(t), docs = Array.from({ length: 27 }, (_, index) => document(index));
  for (const doc of docs) database.putRecord('documents', doc.id, doc);
  database.projections.ensure(['documents']);
  const original = database.all.bind(database), returned: unknown[] = [];
  database.all = ((query: Parameters<typeof original>[0]) => { const rows = original(query); returned.push(...rows); return rows; }) as typeof original;
  let page: any;
  try { page = await api('/api/documents/page?page=2&pageSize=10&search=' + encodeURIComponent('école 南京 %_')); }
  finally { database.all = original; }
  const active = docs.filter(doc => !doc._archived);
  assert.equal(page.total, active.length); assert.equal(page.page, 2);
  assert.deepEqual(page.items.map((item: any) => item.id), active.slice(10, 20).map(doc => doc.id));
  assert.doesNotMatch(JSON.stringify(returned), /BOOK_BODY_TAIL|bodyMarkdown/);
  assert.equal(returned.filter((row: any) => typeof row.metadata === 'string').length, 10);
  assert.ok(page.items.every((item: any) => item.excerpt.length <= 110 && !Object.hasOwn(item, 'bodyMarkdown')));
  const filtered = await api('/api/documents/page?domainId=science&categoryId=science-root&tagIds=concept&kind=书籍&format=markdown&collection=general');
  const expected = active.filter(doc => doc.categoryIds.length && doc.collection === 'general');
  assert.deepEqual(filtered.items.map((item: any) => item.id), expected.map(doc => doc.id));
  assert.ok(filtered.items.every((item: any) => item.domainIds.includes('science')));
  const outside = await api('/api/documents/page?page=999&pageSize=10'); assert.equal(outside.page, 3); assert.equal(outside.items.length, active.length - 20);
  const empty = await api('/api/documents/page?search=' + encodeURIComponent("%_' OR 1=1 --")); assert.equal(empty.total, 0); assert.equal(empty.page, 1);
  const legacy = await api('/api/documents?page=2&pageSize=10'); assert.deepEqual(legacy.items.map((item: any) => item.id), page.items.map((item: any) => item.id));
  assert.ok(legacy.items.every((item: any) => item.bodyMarkdown.includes(tail)));
  assert.equal((await api('/api/documents')).length, active.length);
  assert.ok((await api('/api/documents/D-1')).bodyMarkdown.includes(tail));
  await api('/api/documents/D-0', 404);
});

test('library search retains Unicode, literal punctuation, cross-field and body matches after edits and deletion', async t => {
  const { app, database, api } = await fixture(t);
  const doc = document(1); database.putRecord('documents', doc.id, doc);
  for (const search of ['åuthor', '出版社', tail.toLowerCase(), '1 åuthor', '南京 %_']) {
    const result = await api('/api/documents/page?search=' + encodeURIComponent(search)); assert.equal(result.total, 1, search);
    assert.equal((await api('/api/documents?search=' + encodeURIComponent(search))).length, 1, search);
  }
  doc.title = '修改后的书籍'; doc.bodyMarkdown = '修改后的正文'; database.putRecord('documents', doc.id, doc);
  assert.equal((await api('/api/documents/page?search=' + tail)).total, 0);
  assert.equal((await api('/api/documents/page?search=' + encodeURIComponent('修改后'))).total, 1);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/documents/' + doc.id })).statusCode, 200);
  assert.equal((await api('/api/documents/page')).total, 0);
});

test('library card query bounds and generated API schemas agree', async t => {
  const { api } = await fixture(t);
  for (const query of ['page=0', 'page=1.1', 'pageSize=200', 'format=other', 'kind=' + 'a'.repeat(301), 'extra=true', 'search=' + 'a'.repeat(1001)]) await api('/api/documents/page?' + query, 400);
  await api('/api/documents/page?domainId=missing', 404);
  const spec = await api('/api/openapi.json'), operation = spec.paths['/api/documents/page'].get;
  const output = operation.responses['200'].content['application/json'].schema;
  assert.equal(output.properties.items.items.properties.bodyMarkdown, undefined);
  assert.ok(output.properties.items.items.required.includes('excerpt'));
  assert.equal(operation.parameters.find((parameter: any) => parameter.name === 'search').schema.maxLength, 1000);
});
