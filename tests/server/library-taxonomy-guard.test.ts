import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../server/index.js';

test('taxonomy changes and legacy migration preserve explicit document subject boundaries atomically', async t => {
  const app = await buildApp({ databasePath: ':memory:', seedPath: 'test-results/no-guard-seed.json', staticRoot: 'test-results/no-guard-web' }); t.after(() => app.close());
  const call = (method: 'POST' | 'PUT' | 'GET', url: string, payload?: unknown) => app.inject({ method, url, ...(payload ? { payload } : {}) });
  for (const id of ['a', 'b']) assert.equal((await call('POST', '/api/domains', { id, name: id })).statusCode, 201);
  assert.equal((await call('POST', '/api/categories', { id: 'chapter', name: '章节', domainId: 'a' })).statusCode, 201);
  assert.equal((await call('POST', '/api/documents', { id: 'book', title: '书籍', kind: '书籍', domainIds: ['a'], categoryIds: ['chapter'] })).statusCode, 201);
  assert.equal((await call('PUT', '/api/categories/chapter', { name: '移动章节', domainId: 'b' })).statusCode, 400);
  assert.equal((await call('GET', '/api/taxonomy')).json().categories.find((c: any) => c.id === 'chapter').domainId, 'a');
  const data = (await call('GET', '/api/export')).json();
  data.domains.push({ id: 'rollback-domain', name: '不应残留', description: '', sortOrder: 0 });
  data.documents.push({ ...data.documents[0], id: 'bad-book', domainIds: ['b'] });
  assert.equal((await call('POST', '/api/import', { mode: 'merge', data })).statusCode, 400);
  assert.equal((await call('GET', '/api/taxonomy')).json().domains.some((d: any) => d.id === 'rollback-domain'), false);
  assert.equal((await call('GET', '/api/documents')).json().length, 1);
});
