import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { Category, DocumentRecord } from '../../shared/models/types.js';
import { Store } from '../../server/core/store.js';
import { ApiError } from '../../server/core/validation.js';
import { registerAssetRoutes } from '../../server/modules/assets/routes.js';
import { registerLibraryRoutes } from '../../server/modules/library/routes.js';
import { normalizeDocument } from '../../server/modules/library/service.js';

const stamp = '2026-10-23T00:00:00.000Z';
async function fixture(t: test.TestContext) {
  const store = new Store(':memory:'), app = Fastify();
  app.setErrorHandler((error, _request, reply) => error instanceof ApiError ? reply.code(error.status).send({ error: { code: error.code } }) : reply.send(error));
  registerAssetRoutes(app, store); registerLibraryRoutes(app, store);
  t.after(async () => { await app.close(); store.database.close(); });
  return { store, app };
}
const responseJson = (response: { statusCode: number; json(): any }, status = 200) => { assert.equal(response.statusCode, status, JSON.stringify(response.json())); return response.json(); };
function observeReads(store: Store) {
  const original = store.database.all.bind(store.database), result = { calls: 0, dataBytes: 0, rows: 0, documentRows: 0 };
  store.database.all = ((query: Parameters<typeof original>[0]) => {
    const rows = original(query); result.calls++; result.rows += rows.length;
    for (const row of rows) if (row && typeof row === 'object' && 'data' in row && typeof row.data === 'string') {
      result.dataBytes += Buffer.byteLength(row.data);
      if (JSON.parse(row.data).id?.startsWith('D')) result.documentRows++;
    }
    return rows;
  }) as typeof store.database.all;
  return { result, restore() { store.database.all = original; } };
}

test('asset pages keep metadata and exact six-table references without retaining stale results', async t => {
  const { store, app } = await fixture(t);
  for (let index = 0; index < 14; index++) {
    const id = `A${String(index).padStart(2, '0')}`;
    store.put('assets', id, { id, filename: `${id}.md`, mimeType: 'text/markdown', dataBase64: Buffer.from('x'.repeat(32_768)).toString('base64'), sizeBytes: 32_768, createdAt: new Date(Date.parse(stamp) - index * 1000).toISOString() });
  }
  // Most records are deliberately reference-free; none should affect the flags.
  for (let index = 0; index < 120; index++) store.put('questions', `unrelated-${index}`, { id: `unrelated-${index}`, explanationMarkdown: '普通文字与代码。'.repeat(200) });
  store.put('questions', 'live', { id: 'live', parts: [{ stemMarkdown: '![图](/api/assets/A00/content)' }] });
  store.put('papers', 'frozen', { id: 'frozen', snapshot: [{ explanationMarkdown: '[文件](/api/assets/A01/data?download=1)' }] });
  store.put('attempts', 'history', { id: 'history', answers: { question: { value: '![笔记](/api/assets/A02/content)' } } });
  store.put('documents', 'book', { id: 'book', assetId: 'A03' });
  store.put('study', 'note', { questionId: 'note', notes: '[资料](/api/assets/A04/content)' });
  store.put('reviews', 'review', { id: 'review', notes: '[回顾](/api/assets/A05/data)' });
  // Escaped JSON is valid during database migration too. The structural
  // collector receives the decoded URL, not the serialized spelling.
  store.database.run(store.database.query.insertInto('questions').values({ id: 'escaped', data: JSON.stringify({ id: 'escaped', stemMarkdown: '[编码引用](/api/assets/%41%30%36/content)' }).replaceAll('/', '\\/') }));
  store.put('questions', 'false-positive', { id: 'false-positive', stemMarkdown: '/api/assets/A07/thumbnail', dataBase64: '/api/assets/A08/content' });
  store.database.run(store.database.query.insertInto('questions').values({ id: 'escaped-key', data: JSON.stringify({ id: 'escaped-key', nested: { assetId: 'A09' } }).replace('"assetId"', '"\\u0061ssetId"') }));

  // Fixture inserts occur after startup. Prepare derived references before
  // measuring the ordinary read path; later edits below still test invalidation.
  store.database.projections.ensure(['questions', 'documents', 'papers', 'attempts', 'study', 'reviews']);
  const reads = observeReads(store), first = responseJson(await app.inject('/api/assets?pageSize=10')); reads.restore();
  t.diagnostic(JSON.stringify({ assetPageReads: reads.result }));
  assert.ok(reads.result.calls <= 7, `page must batch reference reads, got ${reads.result.calls}`);
  assert.ok(reads.result.dataBytes < 20_000, `unreferenced bodies/binary payloads crossed the DB boundary: ${reads.result.dataBytes} bytes`);
  assert.equal(first.total, 14); assert.equal(first.page, 1); assert.equal(first.pageSize, 10);
  assert.deepEqual(first.items.map((item: any) => item.id), Array.from({ length: 10 }, (_, index) => `A${String(index).padStart(2, '0')}`));
  assert.deepEqual(first.items.filter((item: any) => item.referenced).map((item: any) => item.id), ['A00', 'A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A09']);
  assert.ok(first.items.every((item: any) => !Object.hasOwn(item, 'dataBase64')));
  assert.equal(JSON.stringify(first).includes('eHh4eHh4'), false);
  assert.equal(responseJson(await app.inject('/api/assets?page=3&pageSize=10')).items.length, 0);
  assert.equal(responseJson(await app.inject('/api/assets')).length, 14);
  responseJson(await app.inject({ method: 'DELETE', url: '/api/assets/A01' }), 409);
  store.remove('papers', 'frozen'); responseJson(await app.inject({ method: 'DELETE', url: '/api/assets/A01' }));
  store.put('questions', 'live', { id: 'live', stemMarkdown: '移除引用后的文本' });
  assert.equal(responseJson(await app.inject('/api/assets?page=1&pageSize=10')).items.find((item: any) => item.id === 'A00').referenced, false);
});

test('asset pagination retains insertion order for equal timestamps and empty detached pages', async t => {
  const { store, app } = await fixture(t);
  for (const id of ['z-file', 'a-file']) store.put('assets', id, { id, filename: id, mimeType: 'text/markdown', dataBase64: 'eA==', sizeBytes: 1, createdAt: stamp });
  const page = responseJson(await app.inject('/api/assets?page=1&pageSize=10'));
  assert.deepEqual(page.items.map((item: any) => item.id), ['z-file', 'a-file']);
  assert.deepEqual(responseJson(await app.inject('/api/assets?page=100&pageSize=20')), { items: [], total: 2, page: 100, pageSize: 20 });
  assert.equal(responseJson(await app.inject('/api/assets?pageSize=11'), 400).error.code, 'VALIDATION_ERROR');
});

test('library pages preserve old inferred domains, combined filters, Unicode search and stable ties', async t => {
  const { store, app } = await fixture(t);
  for (const id of ['computer', 'language']) store.put('domains', id, { id, name: id, sortOrder: 0, description: '' });
  const categories: Category[] = [
    { id: 'root', name: '根分类', domainId: 'computer', parentId: null, sortOrder: 0, description: '' },
    { id: 'child', name: '子分类', domainId: 'computer', parentId: 'root', sortOrder: 1, description: '' },
    { id: 'language-child', name: '语言分类', domainId: 'language', parentId: null, sortOrder: 2, description: '' },
  ];
  for (const category of categories) store.put('categories', category.id, category);
  for (const id of ['t1', 't2']) store.put('tags', id, { id, name: id, domainId: null, kind: 'topic', color: '#888888', description: '' });
  const documents: (DocumentRecord & { _archived?: boolean })[] = [];
  for (let index = 0; index < 45; index++) {
    const document = {
      id: `D${String(index).padStart(2, '0')}`, title: `资料${index}`, kind: index % 3 ? '学习笔记' : '书籍', bodyMarkdown: index % 7 ? '常规内容' : 'CAFÉ 词形与 K 单位', collection: index % 2 ? 'personal' : 'general', categoryIds: index % 2 ? ['language-child'] : ['child'], tagIds: index % 2 ? ['t1'] : ['t1', 't2'], sourcePath: null,
      ...(index % 5 ? { domainIds: index % 2 ? ['language'] : ['computer', 'language'] } : {}),
      ...(index % 4 ? { format: 'markdown' } : {}), author: index % 7 ? '' : 'Élodie', publisher: '出版社', description: '参考资料', updatedAt: new Date(Date.parse(stamp) - Math.floor(index / 2) * 1000).toISOString(), _archived: index % 11 === 0,
    } as DocumentRecord & { _archived?: boolean };
    documents.push(document); store.put('documents', document.id, document);
  }
  const baseline = documents.filter(document => !document._archived).map(document => normalizeDocument(store, document, categories)).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  // Initial derived index work is separate from steady-state page-local reads.
  store.database.projections.ensure(['documents']);
  const reads = observeReads(store), firstPage = responseJson(await app.inject('/api/documents?pageSize=10')); reads.restore();
  t.diagnostic(JSON.stringify({ documentPageReads: reads.result }));
  assert.equal(firstPage.items.length, 10); assert.equal(reads.result.documentRows, 10);
  assert.ok(reads.result.calls <= 3, `category reads must not grow per document, got ${reads.result.calls}`);
  const matches = (query: Record<string, string>) => baseline.filter(document => (!query.collection || query.collection === 'all' || document.collection === query.collection) && (!query.kind || document.kind === query.kind) && (!query.domainId || document.domainIds!.includes(query.domainId)) && (!query.categoryId || document.categoryIds.includes('child')) && (!query.tagIds || query.tagIds.split(',').every(tag => document.tagIds.includes(tag))) && (!query.format || document.format === query.format) && (!query.search || `${document.title} ${document.author} ${document.publisher} ${document.description} ${document.bodyMarkdown}`.toLowerCase().includes(query.search.trim().toLowerCase())));
  for (const query of [
    {}, { domainId: 'computer' }, { domainId: 'language' }, { domainId: 'computer', categoryId: 'root', tagIds: 't1,t2', format: 'markdown' }, { collection: 'personal', kind: '书籍' }, { collection: 'all', search: 'CAFÉ' }, { search: 'élodie' }, { search: 'k' }, { search: '常规', tagIds: 't2' },
  ]) {
    const params = new URLSearchParams({ ...query, page: '2', pageSize: '10' }), result = responseJson(await app.inject('/api/documents?' + params));
    const expected = matches(query);
    assert.equal(result.total, expected.length, params.toString()); assert.deepEqual(result.items, expected.slice(10, 20), params.toString());
  }
  const inferred = responseJson(await app.inject('/api/documents?domainId=computer')).find((document: DocumentRecord) => document.id === 'D10');
  assert.deepEqual(inferred.domainIds, ['computer']); assert.equal(inferred.format, 'markdown');
  assert.equal(store.get<any>('documents', 'D10').domainIds, undefined);
  assert.ok(responseJson(await app.inject('/api/documents?search=caf%C3%A9')).length > 0);
  assert.ok(responseJson(await app.inject('/api/documents?search=k')).length > 0);
  assert.deepEqual(responseJson(await app.inject('/api/documents/kinds')), ['书籍', '学习笔记'].sort((a, b) => a.localeCompare(b, 'zh-CN')));
  responseJson(await app.inject('/api/documents?domainId=missing'), 404); responseJson(await app.inject('/api/documents?tagIds=missing'), 404);
  const latest = { ...documents[1]!, id: 'latest', title: '新加入的资料', updatedAt: '2026-10-24T00:00:00.000Z', _archived: false };
  store.put('documents', latest.id, latest);
  assert.equal(responseJson(await app.inject('/api/documents?pageSize=10')).items[0].id, latest.id);
  assert.equal(responseJson(await app.inject('/api/documents?page=100&pageSize=10')).items.length, 0);
});
