import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Store } from '../../server/core/store.js';
import { ApiError, parse, questionSchema } from '../../server/core/validation.js';
import { registerSettingsRoutes, ensureSettings, getSettings } from '../../server/modules/settings/routes.js';
import { registerAiRoutes } from '../../server/modules/ai/routes.js';
import { getPublicAiSettings, readPrivateSettings, saveAiSettings } from '../../server/modules/ai/settings.js';
import { exportConfiguration, importConfiguration, previewConfiguration } from '../../server/modules/settings/configuration.js';
import { registerApiDocs } from '../../server/http/openapi.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';

function json(response: { statusCode: number; json(): any }, expected = 200) {
  assert.equal(response.statusCode, expected, JSON.stringify(response.json()));
  return response.json();
}
async function fixture(t: test.TestContext, docs?: 'web' | 'native') {
  const store = new Store(':memory:'); ensureSettings(store);
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => error instanceof ApiError ? reply.code(error.status).send({ error: { code: error.code, message: error.message, details: error.details } }) : reply.code((error as any).statusCode || 500).send({ error: { code: 'INTERNAL_ERROR' } }));
  if (docs) await registerApiDocs(app, { native: docs === 'native' });
  registerSettingsRoutes(app, store); registerAiRoutes(app, store);
  t.after(async () => { await app.close(); store.db.close(); });
  const call = async (url: string, payload?: unknown, expected = 200) => json(await app.inject({ method: payload === undefined ? 'GET' : 'POST', url, ...(payload === undefined ? {} : { payload }) }), expected);
  const withAi = (baseUrl = 'https://first.example/v1', key = 'secret-must-never-migrate') => saveAiSettings(store, { enabled: true, baseUrl, model: 'test-model', supportsImages: false, sendImages: false, timeoutSeconds: 60, maxTokens: 4096, key });
  return { app, store, call, withAi };
}
function record(store: Store, id: string, status: string, timestamp: string, extra = {}) {
  const question = { ...parse(questionSchema, { id: 'configuration-fixture', title: '保留策略测试题', type: 'true_false', stemMarkdown: '判断此题。', correctAnswers: ['true'] }), id: 'configuration-fixture' };
  store.put('attempts', id, { id, paperId: 'P', paperTitle: '保留策略测试', paperVersion: 1, source: 'paper', status, questions: [question], answers: {}, startedAt: timestamp, updatedAt: timestamp, ...(status === 'submitted' ? { submittedAt: timestamp } : {}), ...extra });
}
function authoring(store: Store, id: string, timestamp: string) { store.put('paper_drafts', id, { id, context: 'manual', updatedAt: timestamp, state: { title: id } }); }
const stamps = ['2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z', '2026-10-03T00:00:00.000Z'];

test('configuration export selects only portable preferences, never credentials, content, study or local versions', async t => {
  const f = await fixture(t); f.withAi();
  f.store.put('questions', 'private', { id: 'private', title: 'private-question-marker' });
  f.store.put('study', 'private', { id: 'private', notes: 'private-study-marker' });
  const data = await f.call('/api/settings/export');
  assert.equal(data.format, 'noetic-atlas-configuration'); assert.equal(data.schemaVersion, 1);
  assert.deepEqual(data.system, Object.fromEntries(Object.entries(DEFAULT_SETTINGS).filter(([key]) => !['id', 'updatedAt'].includes(key))));
  assert.deepEqual(Object.keys(data.ai).sort(), ['enabled', 'baseUrl', 'model', 'supportsImages', 'sendImages', 'timeoutSeconds', 'maxTokens'].sort());
  const raw = JSON.stringify(data);
  for (const forbidden of ['secret-must-never-migrate', 'private-question-marker', 'private-study-marker', 'updatedAt', 'hasKey']) assert.ok(!raw.includes(forbidden), forbidden);
  assert.equal('ai' in await f.call('/api/settings/export?includeAi=false'), false);
  await f.call('/api/settings/export?includeAi=1', undefined, 400);
  await f.call('/api/settings/export?includeKey=true', undefined, 400);
});

test('preview is read-only and explicit import overrides already customized preferences without touching content/history', async t => {
  const f = await fixture(t); f.withAi();
  f.store.put('settings', 'system', { ...getSettings(f.store), randomQuestionCount: 45 });
  record(f.store, 'saved-attempt', 'submitted', stamps[0]!);
  f.store.put('questions', 'kept-question', { id: 'kept-question', title: '保留题目' });
  f.store.put('study', 'kept-question', { id: 'kept-question', notes: '保留笔记' });
  const data = exportConfiguration(f.store); data.system.randomQuestionCount = 15; data.ai!.model = 'new-model';
  const before = ['settings', 'questions', 'study', 'attempts'].map(table => f.store.all(table as any));
  const privateBefore = readPrivateSettings(f.store);
  const plan = await f.call('/api/settings/import/preview', { data });
  assert.deepEqual(plan.systemChanges, [{ key: 'randomQuestionCount', before: 45, after: 15 }]);
  assert.deepEqual(plan.aiChanges, [{ key: 'model', before: 'test-model', after: 'new-model' }]);
  assert.equal(plan.aiKey.action, 'preserve'); assert.deepEqual(plan.retention, { drafts: 0, history: 0, authoring: 0, total: 0 });
  assert.deepEqual(['settings', 'questions', 'study', 'attempts'].map(table => f.store.all(table as any)), before);
  assert.deepEqual(readPrivateSettings(f.store), privateBefore);
  const result = await f.call('/api/settings/import', { data, fingerprint: plan.fingerprint, confirmed: true });
  assert.equal(result.settings.randomQuestionCount, 15); assert.equal(result.ai.model, 'new-model'); assert.equal(result.ai.hasKey, true);
  assert.equal(readPrivateSettings(f.store).key, privateBefore.key);
  for (const [index, table] of ['questions', 'study', 'attempts'].entries()) assert.deepEqual(f.store.all(table as any), before[index + 1]);
  assert.ok(!JSON.stringify(result).includes(privateBefore.key));
});

test('configuration without AI leaves local AI unchanged; equivalent endpoint paths retain key and changed endpoint clears it', async t => {
  const f = await fixture(t); f.withAi();
  const without = exportConfiguration(f.store, false), previous = readPrivateSettings(f.store);
  let plan = previewConfiguration(f.store, without); assert.equal(plan.aiKey.action, 'unchanged');
  importConfiguration(f.store, { data: without, fingerprint: plan.fingerprint, confirmed: true });
  assert.deepEqual(readPrivateSettings(f.store), previous);
  const data = exportConfiguration(f.store); data.ai!.baseUrl = 'https://first.example/v1/chat/completions/';
  plan = previewConfiguration(f.store, data); assert.equal(plan.aiKey.action, 'preserve');
  importConfiguration(f.store, { data, fingerprint: plan.fingerprint, confirmed: true });
  assert.equal(readPrivateSettings(f.store).key, previous.key);
  data.ai!.baseUrl = 'http://127.0.0.1:11434/v1';
  plan = previewConfiguration(f.store, data); assert.equal(plan.aiKey.action, 'clear'); assert.ok(plan.warnings.some(w => w.includes('没有密钥')));
  importConfiguration(f.store, { data, fingerprint: plan.fingerprint, confirmed: true });
  assert.equal(readPrivateSettings(f.store).key, ''); assert.equal(getPublicAiSettings(f.store).enabled, true);
});

test('enabled keyless local providers import without network requests and explain missing credentials', async t => {
  const f = await fixture(t), data = exportConfiguration(f.store);
  data.ai = { enabled: true, baseUrl: 'http://localhost:11434/v1', model: 'local', supportsImages: false, sendImages: false, maxTokens: 4096, timeoutSeconds: 60 };
  let requests = 0; t.mock.method(globalThis, 'fetch', () => { requests++; throw new Error('must not send'); });
  const plan = await f.call('/api/settings/import/preview', { data }); assert.equal(plan.aiKey.action, 'missing'); assert.ok(plan.warnings.length);
  const result = await f.call('/api/settings/import', { data, fingerprint: plan.fingerprint, confirmed: true });
  assert.equal(requests, 0); assert.equal(result.ai.hasKey, false); assert.equal(result.ai.enabled, true);
});

test('strict import rejects secret fields, invalid endpoints, values, envelope and unconfirmed writes without leaking input values', async t => {
  const f = await fixture(t); f.withAi(); const baseline = exportConfiguration(f.store), settings = getSettings(f.store), ai = readPrivateSettings(f.store);
  const invalid: any[] = [];
  for (const fields of [{ key: 'secret-in-incoming-file' }, { token: 'secret-in-incoming-file' }, { hasKey: true }, { updatedAt: stamps[0] }, { clearKey: true }]) invalid.push({ ...structuredClone(baseline), ai: { ...baseline.ai, ...fields } });
  for (const baseUrl of ['https://person:secret-in-incoming-file@example.com', 'https://example.com?token=secret-in-incoming-file', 'https://example.com#secret-in-incoming-file', 'file:///etc/passwd', 'invalid']) invalid.push({ ...structuredClone(baseline), ai: { ...baseline.ai, baseUrl } });
  invalid.push({ ...baseline, questions: [] }, { ...baseline, schemaVersion: 2 }, { ...baseline, system: { ...baseline.system, maxDraftsPerPaper: 0 } }, { ...baseline, system: { ...baseline.system, pointsByType: { true_false: 2 } } }, { ...baseline, ai: { ...baseline.ai, timeoutSeconds: 181 } }, { ...baseline, ai: { ...baseline.ai, baseUrl: '' } });
  for (const data of invalid) {
    const response = await f.app.inject({ method: 'POST', url: '/api/settings/import/preview', payload: { data } });
    assert.equal(response.statusCode, 400, response.body); assert.ok(!response.body.includes('secret-in-incoming-file'));
  }
  const plan = previewConfiguration(f.store, baseline);
  await f.call('/api/settings/import', { data: baseline, fingerprint: plan.fingerprint }, 400);
  await f.call('/api/settings/import', { data: baseline, fingerprint: plan.fingerprint, confirmed: false }, 400);
  await f.call('/api/settings/import/preview', { data: baseline, confirmed: true }, 400);
  assert.deepEqual(getSettings(f.store), settings); assert.deepEqual(readPrivateSettings(f.store), ai);
});

test('fingerprint binds imported payload, both settings versions and same-count draft edits or replacements', async t => {
  const f = await fixture(t); f.withAi(); const data = exportConfiguration(f.store), first = previewConfiguration(f.store, data);
  const changed = structuredClone(data); changed.system.randomQuestionCount++;
  await f.call('/api/settings/import', { data: changed, fingerprint: first.fingerprint, confirmed: true }, 409);
  f.store.put('settings', 'system', { ...getSettings(f.store), autosaveDebounceMs: 777 });
  const rejected = await f.call('/api/settings/import', { data, fingerprint: first.fingerprint, confirmed: true }, 409); assert.equal(rejected.error.code, 'CONFIGURATION_PREVIEW_STALE');
  let plan = previewConfiguration(f.store, data); f.withAi('https://first.example/v1', 'changed-local-key');
  await f.call('/api/settings/import', { data, fingerprint: plan.fingerprint, confirmed: true }, 409);
  record(f.store, 'draft', 'in_progress', stamps[0]!);
  plan = previewConfiguration(f.store, data); record(f.store, 'draft', 'in_progress', stamps[1]!);
  await f.call('/api/settings/import', { data, fingerprint: plan.fingerprint, confirmed: true }, 409);
  authoring(f.store, 'authoring', stamps[0]!); plan = previewConfiguration(f.store, data); authoring(f.store, 'authoring', stamps[2]!);
  await f.call('/api/settings/import', { data, fingerprint: plan.fingerprint, confirmed: true }, 409);
});

test('retention requires separate confirmation, preserves newest records and excludes ongoing exams', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++) { record(f.store, `draft${i}`, 'in_progress', stamps[i]!); record(f.store, `history${i}`, 'submitted', stamps[i]!); authoring(f.store, `author${i}`, stamps[i]!); }
  record(f.store, 'exam', 'in_progress', stamps[0]!, { practiceMode: 'exam' });
  f.store.put('study', 'kept', { id: 'kept', notes: 'preserve-notes' });
  const data = exportConfiguration(f.store, false); data.system.maxDraftsPerPaper = data.system.maxHistoryPerPaper = data.system.maxPaperDrafts = 1;
  const plan = previewConfiguration(f.store, data); assert.deepEqual(plan.retention, { drafts: 2, history: 2, authoring: 2, total: 6 });
  const previous = getSettings(f.store);
  const blocked = await f.call('/api/settings/import', { data, fingerprint: plan.fingerprint, confirmed: true }, 409); assert.equal(blocked.error.code, 'RETENTION_CONFIRMATION_REQUIRED');
  assert.equal(f.store.all('attempts').length, 7); assert.deepEqual(getSettings(f.store), previous);
  await f.call('/api/settings/import', { data, fingerprint: plan.fingerprint, confirmed: true, confirmedRetention: true });
  assert.deepEqual(f.store.all('attempts').map(a => a.id).sort(), ['draft2', 'exam', 'history2']); assert.deepEqual(f.store.all('paper_drafts').map(a => a.id), ['author2']);
  assert.equal(f.store.get('study', 'kept')!.notes, 'preserve-notes');
});

test('failure saving AI rolls back system changes and retention deletes in the same transaction', async t => {
  const f = await fixture(t); f.withAi();
  record(f.store, 'old', 'in_progress', stamps[0]!); record(f.store, 'recent', 'in_progress', stamps[1]!);
  const data = exportConfiguration(f.store); data.system.maxDraftsPerPaper = 1; data.ai!.model = 'changed';
  const plan = previewConfiguration(f.store, data), original = getSettings(f.store), originalAi = readPrivateSettings(f.store), originalAttempts = f.store.all('attempts');
  const putRecord = f.store.database.putRecord.bind(f.store.database);
  t.mock.method(f.store.database, 'putRecord', (table: any, id: string, value: unknown) => { if (table === 'ai_settings') throw new Error('simulated storage failure'); return putRecord(table, id, value); });
  await f.call('/api/settings/import', { data, fingerprint: plan.fingerprint, confirmed: true, confirmedRetention: true }, 500);
  assert.deepEqual(getSettings(f.store), original); assert.deepEqual(readPrivateSettings(f.store), originalAi); assert.deepEqual(f.store.all('attempts'), originalAttempts);
});

test('configuration routes enforce their small payload limit', async t => {
  const f = await fixture(t);
  const response = await f.app.inject({ method: 'POST', url: '/api/settings/import/preview', payload: { data: 'x'.repeat(1024 * 1024) } });
  assert.equal(response.statusCode, 413);
});

for (const mode of ['web', 'native'] as const) test(`${mode} OpenAPI describes the same credential-free configuration schemas, preview and confirmation examples`, async t => {
  const f = await fixture(t, mode); f.withAi();
  const doc = await f.call('/api/openapi.json'), schema = doc.components.schemas.ConfigurationExport;
  assert.equal(schema.properties.format.const ?? schema.properties.format.enum?.[0], 'noetic-atlas-configuration'); assert.equal(schema.additionalProperties, false);
  for (const name of ['key', 'token', 'hasKey', 'updatedAt']) assert.equal(name in schema.properties.ai.properties, false);
  const exported = doc.paths['/api/settings/export'].get; assert.ok(exported.parameters.some((p: any) => p.name === 'includeAi'));
  const media = doc.paths['/api/settings/import'].post.requestBody.content['application/json'], request = media.schema;
  assert.ok(request.required.includes('fingerprint')); assert.ok(request.required.includes('confirmed')); assert.equal(request.properties.confirmed.const ?? request.properties.confirmed.enum?.[0], true);
  assert.equal((media.example || request.examples?.[0]).data.format, 'noetic-atlas-configuration');
  assert.ok(doc.paths['/api/settings/import/preview'].post.responses['200'].content['application/json'].schema.properties.retention.properties.authoring);
  assert.ok(!JSON.stringify(doc).includes('secret-must-never-migrate'));
});
