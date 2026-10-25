import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../server/index.js';
import { Store } from '../../server/core/store.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';
import { documentDraftSchema, validateDocumentDraftState, listDocumentDrafts } from '../../server/modules/library/document-drafts.js';
import { exportData, importData } from '../../server/modules/transfer/migration.js';
import { exportConfiguration } from '../../server/modules/settings/configuration.js';
import type { DocumentDraftState } from '../../shared/models/document-drafts.js';
import { collectAssetReferences } from '../../shared/assets/asset-references.js';

const state = (title = '', bodyMarkdown = ''): DocumentDraftState => ({ title, kind: '学习笔记', bodyMarkdown, collection: 'general', categoryIds: [], tagIds: [], domainIds: [], format: 'markdown', assetId: null, fileName: null, sourcePath: null, author: '', publisher: '', publishedYear: '', description: '' });
async function fixture(t: test.TestContext) {
  const app = await buildApp({ databasePath: ':memory:', staticRoot: 'no-document-draft-assets', dailyPushScheduler: false });
  t.after(() => app.close());
  const api = async (url: string, method: any = 'GET', payload?: unknown, expected = 200): Promise<any> => {
    const response = await app.inject({ url, method, ...(payload === undefined ? {} : { payload }) });
    assert.equal(response.statusCode, expected, response.body); return response.json();
  };
  const create = (value = state(), documentId: string | null = null, baseDocumentUpdatedAt: string | null = null) => api('/api/document-drafts', 'POST', { documentId, baseDocumentUpdatedAt, state: value }, 201);
  return { app, api, create };
}

test('incomplete drafts stay outside the library and publish atomically only after required fields are valid', async t => {
  const { api, create } = await fixture(t);
  const first = await create({ ...state('', '只有正文'), kind: '' });
  assert.equal((await api('/api/documents')).length, 0); assert.equal((await api('/api/document-drafts')).length, 1);
  await api(`/api/document-drafts/${first.id}/publish`, 'POST', { expectedUpdatedAt: first.updatedAt }, 400);
  assert.equal((await api('/api/document-drafts'))[0].state.bodyMarkdown, '只有正文');
  const saved = await api(`/api/document-drafts/${first.id}`, 'PUT', { expectedUpdatedAt: first.updatedAt, state: state('正式资料', '正文完整') });
  assert.equal(saved.id, first.id); assert.notEqual(saved.updatedAt, first.updatedAt);
  const second = await create(state('另一份草稿', '保留'));
  const document = await api(`/api/document-drafts/${saved.id}/publish`, 'POST', { expectedUpdatedAt: saved.updatedAt });
  assert.equal(document.title, '正式资料'); assert.equal((await api('/api/documents')).length, 1);
  assert.deepEqual((await api('/api/document-drafts')).map((draft: any) => draft.id), [second.id]);
  await api(`/api/document-drafts/${saved.id}`, 'PUT', { expectedUpdatedAt: saved.updatedAt, state: state('不能复活') }, 404);
});

test('draft writes, deletion and publish reject stale tabs without overwriting current content', async t => {
  const { api, create } = await fixture(t), first = await create(state('草稿', '旧'));
  const latest = await api(`/api/document-drafts/${first.id}`, 'PUT', { expectedUpdatedAt: first.updatedAt, state: state('草稿', '新') });
  for (const [method, suffix, payload] of [
    ['PUT', '', { expectedUpdatedAt: first.updatedAt, state: state('草稿', '被旧页面覆盖') }],
    ['DELETE', '', { expectedUpdatedAt: first.updatedAt }],
    ['POST', '/publish', { expectedUpdatedAt: first.updatedAt }],
  ] as const) assert.equal((await api(`/api/document-drafts/${first.id}${suffix}`, method, payload, 409)).error.code, 'DOCUMENT_DRAFT_VERSION_CONFLICT');
  assert.equal((await api('/api/document-drafts'))[0].state.bodyMarkdown, '新');
  await api(`/api/document-drafts/${latest.id}`, 'DELETE', { expectedUpdatedAt: latest.updatedAt });
  assert.equal((await api('/api/document-drafts')).length, 0);
});

test('source version conflicts preserve the draft and offer explicit copy without changing the source', async t => {
  const { api, create } = await fixture(t);
  const document = await api('/api/documents', 'POST', state('原资料', '原文'), 201);
  const draft = await create(state('草稿修订', '未发布的改动'), document.id, document.updatedAt);
  assert.equal((await api('/api/document-drafts')).length, 0);
  assert.equal((await api(`/api/document-drafts?documentId=${document.id}`))[0].id, draft.id);
  const updated = await api(`/api/documents/${document.id}`, 'PUT', { ...document, bodyMarkdown: '其他页面已经保存' });
  await api(`/api/document-drafts/${draft.id}/publish`, 'POST', { expectedUpdatedAt: draft.updatedAt }, 409);
  const copied = await api(`/api/document-drafts/${draft.id}/publish`, 'POST', { expectedUpdatedAt: draft.updatedAt, asNew: true });
  assert.notEqual(copied.id, document.id); assert.equal(copied.bodyMarkdown, '未发布的改动');
  assert.equal((await api(`/api/documents/${document.id}`)).bodyMarkdown, updated.bodyMarkdown);
  const archivedDraft = await create(state('归档后草稿', '另存'), document.id, updated.updatedAt);
  await api(`/api/documents/${document.id}`, 'DELETE');
  await api(`/api/document-drafts/${archivedDraft.id}/publish`, 'POST', { expectedUpdatedAt: archivedDraft.updatedAt }, 409);
  assert.equal((await api(`/api/document-drafts/${archivedDraft.id}/publish`, 'POST', { expectedUpdatedAt: archivedDraft.updatedAt, asNew: true })).bodyMarkdown, '另存');
});

test('draft context caps keep the latest three and settings cleanup requires an accurate preview', async t => {
  const { api, create } = await fixture(t), drafts = [];
  for (let index = 0; index < 4; index++) drafts.push(await create(state(`新资料${index}`)));
  const document = await api('/api/documents', 'POST', state('原资料'), 201);
  const separate = await create(state('原资料草稿'), document.id, document.updatedAt);
  assert.deepEqual((await api('/api/document-drafts')).map((value: any) => value.id), drafts.slice(1).reverse().map(value => value.id));
  assert.equal((await api(`/api/document-drafts?documentId=${document.id}`))[0].id, separate.id);
  const settings = await api('/api/settings'); assert.equal(settings.maxDocumentDrafts, 3);
  const reduced = { ...settings, maxDocumentDrafts: 1 };
  const preview = (await api('/api/settings', 'PUT', { settings: reduced }, 409)).error.details;
  assert.equal(preview.documentDrafts, 2); assert.equal(preview.total, 2);
  await api('/api/settings', 'PUT', { settings: reduced, confirmedRetention: true, expectedRetention: { ...preview, documentDrafts: 1 } }, 409);
  await api('/api/settings', 'PUT', { settings: reduced, confirmedRetention: true, expectedRetention: preview });
  assert.equal((await api('/api/document-drafts')).length, 1); assert.equal((await api(`/api/document-drafts?documentId=${document.id}`)).length, 1);
});

test('full backups retain drafts, portable configuration excludes them and changed records invalidate import previews', async t => {
  const { api, create } = await fixture(t), draft = await create(state('未发布', '需要迁移'));
  const exported = await api('/api/export'); assert.equal(exported.documentDrafts[0].id, draft.id);
  const target = new Store(':memory:'); t.after(() => target.db.close()); importData(target, exported);
  assert.equal(target.require<any>('document_drafts', draft.id).state.bodyMarkdown, '需要迁移');
  target.put('document_drafts', draft.id, { ...draft, state: state('本地版本', '保留') }); importData(target, exported);
  assert.equal(target.require<any>('document_drafts', draft.id).state.bodyMarkdown, '保留');
  const configuration = await api('/api/settings/export'); assert.equal(configuration.system.maxDocumentDrafts, 3); assert.equal(configuration.documentDrafts, undefined);
  const preview = await api('/api/settings/import/preview', 'POST', { data: configuration });
  await api(`/api/document-drafts/${draft.id}`, 'PUT', { expectedUpdatedAt: draft.updatedAt, state: state('更改后', '相同数量但不同正文') });
  await api('/api/settings/import', 'POST', { data: configuration, fingerprint: preview.fingerprint, confirmed: true }, 409);
  const old = structuredClone(exported); delete old.documentDrafts; delete old.settings[0].maxDocumentDrafts;
  const olderTarget = new Store(':memory:'); t.after(() => olderTarget.db.close()); importData(olderTarget, old);
  assert.equal(olderTarget.all('document_drafts').length, 0); assert.equal(exportConfiguration(olderTarget).system.maxDocumentDrafts, DEFAULT_SETTINGS.maxDocumentDrafts);
});

test('draft-only assets are protected until discard, and malformed references are rejected', async t => {
  const { api, create } = await fixture(t);
  const png = { filename: 'draft-only.png', mimeType: 'image/png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' };
  const asset = await api('/api/assets', 'POST', png, 201), draft = await create(state('含图', `![草稿图片](/api/assets/${asset.id}/content)`));
  assert.equal(collectAssetReferences(draft).has(asset.id), true);
  assert.equal((await api('/api/assets')).find((value: any) => value.id === asset.id).referenced, true);
  await api(`/api/assets/${asset.id}`, 'DELETE', undefined, 409);
  await api(`/api/document-drafts/${draft.id}`, 'DELETE', { expectedUpdatedAt: draft.updatedAt });
  await api(`/api/assets/${asset.id}`, 'DELETE');
  const store = new Store(':memory:'); t.after(() => store.db.close());
  assert.throws(() => validateDocumentDraftState(store, { ...state(), assetId: 'missing' }));
  assert.throws(() => documentDraftSchema.parse({ ...draft, documentId: null, baseDocumentUpdatedAt: '2026-10-01T00:00:00Z' }));
});

test('saving a source edit uses its original identity and clears only the matching draft', async t => {
  const { api, create } = await fixture(t);
  const document = await api('/api/documents', 'POST', state('原资料', '原文'), 201);
  const draft = await create(state('修改标题', '修改内容'), document.id, document.updatedAt), other = await create(state('另一稿'), document.id, document.updatedAt);
  assert.equal((await api(`/api/documents/${document.id}`)).bodyMarkdown, '原文');
  const saved = await api(`/api/document-drafts/${draft.id}/publish`, 'POST', { expectedUpdatedAt: draft.updatedAt });
  assert.equal(saved.id, document.id); assert.equal(saved.bodyMarkdown, '修改内容'); assert.notEqual(saved.updatedAt, document.updatedAt);
  assert.deepEqual((await api(`/api/document-drafts?documentId=${document.id}`)).map((value: any) => value.id), [other.id]);
  await api(`/api/document-drafts/${other.id}/publish`, 'POST', { expectedUpdatedAt: other.updatedAt }, 409);
});

test('draft taxonomy references are protected and full migration failures roll back together', async t => {
  const { api, create } = await fixture(t);
  const domain = await api('/api/domains', 'POST', { name: '草稿领域' }, 201);
  const draft = await create({ ...state('领域草稿'), domainIds: [domain.id] });
  assert.equal((await api(`/api/domains/${domain.id}`, 'DELETE', undefined, 409)).error.code, 'DOCUMENT_DRAFT_IN_USE');
  const exported = await api('/api/export'), target = new Store(':memory:'); t.after(() => target.db.close());
  const bad = structuredClone(exported); bad.documentDrafts[0].state.domainIds = ['missing-domain'];
  assert.throws(() => importData(target, bad)); assert.equal(target.all('domains').length, 0); assert.equal(target.all('document_drafts').length, 0);
  await api(`/api/document-drafts/${draft.id}`, 'DELETE', { expectedUpdatedAt: draft.updatedAt }); await api(`/api/domains/${domain.id}`, 'DELETE');
});

test('context reads hydrate only bounded matching draft bodies and never the other contexts', t => {
  const store = new Store(':memory:'); t.after(() => store.db.close());
  for (let index = 0; index < 5; index++) store.put('document_drafts', 'wanted-' + index, { id: 'wanted-' + index, documentId: 'doc-a', baseDocumentUpdatedAt: null, state: state('本页', '正文' + index), createdAt: '2026-10-01T00:00:00Z', updatedAt: `2026-10-0${index + 1}T00:00:00Z` });
  store.put('document_drafts', 'private-other', { id: 'private-other', documentId: 'doc-b', baseDocumentUpdatedAt: null, state: state('其他文档', 'PRIVATE_BODY_CANARY'), createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' });
  store.all = () => { throw new Error('whole draft table must not load'); };
  const all = store.database.all.bind(store.database); let bodies = 0;
  store.database.all = ((query: any) => { const rows = all(query); for (const row of rows as any[]) if (row.data) { assert.ok(!row.data.includes('PRIVATE_BODY_CANARY')); bodies++; } return rows; }) as typeof store.database.all;
  const result = listDocumentDrafts(store, 'doc-a'); assert.equal(result.length, 3); assert.equal(bodies, 3); assert.equal(result[0].id, 'wanted-4');
});
