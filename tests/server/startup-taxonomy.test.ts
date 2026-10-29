import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../server/core/store.js';
import { buildApp } from '../../server/index.js';

function fixture(t: test.TestContext) {
  const store = new Store(':memory:'); t.after(() => store.db.close());
  for (const id of ['a', 'b']) {
    store.put('domains', id, { id, name: id });
    store.put('categories', id, { id, name: id, domainId: id, parentId: null });
  }
  store.put('tags', 'topic', { id: 'topic', name: '领域主题', domainId: 'a', kind: 'topic' });
  store.put('tags', 'global', { id: 'global', name: '全局方式', domainId: null, kind: 'method' });
  return store;
}
const refs = { categoryIds: ['a'], tagIds: ['topic', 'global'] };
const code = (error: unknown) => (error as { code?: string }).code;

test('startup taxonomy checks reference metadata without decoding source bodies or issuing per-reference reads', t => {
  const store = fixture(t);
  const body = '不应读取的正文'.repeat(1000);
  store.put('questions', 'q', { ...refs, id: 'q', stemMarkdown: body });
  store.put('documents', 'd', { ...refs, id: 'd', domainIds: ['a'], bodyMarkdown: body, _archived: true });
  store.put('document_drafts', 'draft', { id: 'draft', state: { ...refs, domainIds: ['a'], bodyMarkdown: body } });
  const all = store.all.bind(store), get = store.get.bind(store);
  store.all = function <T>(table: Parameters<Store['all']>[0]): T[] {
    assert.ok(!['questions', 'documents', 'document_drafts'].includes(table), `unexpected full ${table} read`);
    return all<T>(table);
  };
  store.get = function <T>(table: Parameters<Store['get']>[0], id: string): T | undefined {
    assert.ok(!['domains', 'categories', 'tags'].includes(table), `unexpected per-reference ${table} read`);
    return get<T>(table, id);
  };
  store.normalizeLegacyTags(); store.validateTaxonomyReferences();
});

test('bulk taxonomy validation shares write-time errors for missing and incompatible references, including drafts and archived content', t => {
  const store = fixture(t);
  const cases = [
    { categoryIds: ['absent'], tagIds: [] },
    { categoryIds: ['a'], tagIds: ['absent'] },
    { categoryIds: [], tagIds: [], domainIds: ['absent'] },
    { categoryIds: ['a'], tagIds: ['topic'], domainIds: ['b'] },
    { categoryIds: ['b'], tagIds: ['topic'] },
    { categoryIds: [], tagIds: ['topic'], domainIds: ['b'] },
  ];
  for (const record of cases) {
    let expected: unknown; try { store.validateRefs(record); } catch (error) { expected = code(error); }
    assert.ok(expected);
    for (const table of ['questions', 'documents', 'document_drafts'] as const) {
      store.put(table, 'bad', table === 'document_drafts' ? { id: 'bad', state: record } : { ...record, id: 'bad', _archived: true });
      assert.throws(() => store.validateTaxonomyReferences(), error => code(error) === expected);
      store.remove(table, 'bad');
    }
  }
  store.validateTaxonomyReferences();
  store.put('tags', 'invalid-method', { id: 'invalid-method', name: '非法方法', kind: 'method', domainId: 'a' });
  assert.throws(() => store.validateTaxonomyReferences(), error => code(error) === 'METHOD_TAG_GLOBAL');
  store.put('tags', 'invalid-method', { id: 'invalid-method', name: '悬空领域', kind: 'topic', domainId: 'absent' });
  assert.throws(() => store.validateTaxonomyReferences(), error => code(error) === 'INVALID_REFERENCE');
});

test('legacy inference reads only reference arrays and leaves explicitly global scopes stable across later imports', t => {
  const store = fixture(t);
  for (const id of ['single', 'cross', 'unclassified']) store.put('tags', id, { id, name: id });
  store.put('questions', 'one', { id: 'one', categoryIds: ['a'], tagIds: ['single', 'cross', 'unclassified'] });
  store.put('documents', 'two', { id: 'two', categoryIds: ['b'], tagIds: ['cross'] });
  store.put('documents', 'three', { id: 'three', categoryIds: [], tagIds: ['unclassified'] });
  const all = store.all.bind(store);
  store.all = function <T>(table: Parameters<Store['all']>[0]): T[] {
    assert.ok(!['questions', 'documents'].includes(table)); return all<T>(table);
  };
  store.normalizeLegacyTags();
  assert.equal(store.get('tags', 'single').domainId, 'a');
  assert.equal(store.get('tags', 'cross').domainId, null);
  assert.equal(store.get('tags', 'unclassified').domainId, null);
  assert.equal(store.get('tags', 'global').kind, 'method');
  store.put('documents', 'later', { id: 'later', categoryIds: ['b'], tagIds: ['global'] });
  store.normalizeLegacyTags(); store.validateTaxonomyReferences();
  assert.equal(store.get('tags', 'global').domainId, null);
});

test('clean reopened startup still detects external reference corruption and broken assets rather than trusting a migration marker', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'atlas-taxonomy-startup-')), path = join(folder, 'fixture.sqlite');
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const options = { databasePath: path, staticRoot: join(folder, 'missing'), dailyPushScheduler: false };
  const first = await buildApp(options); await first.close();
  const external = new Store(path);
  external.put('questions', 'bad', { id: 'bad', categoryIds: ['absent'], tagIds: [] }); external.db.close();
  await assert.rejects(buildApp(options), error => code(error) === 'INVALID_REFERENCE');
  const repaired = new Store(path);
  repaired.put('questions', 'bad', { id: 'bad', categoryIds: [], tagIds: [], stemMarkdown: '![图片](/api/assets/absent/content)' }); repaired.db.close();
  await assert.rejects(buildApp(options), error => code(error) === 'INVALID_ASSET_REFERENCE');
});
