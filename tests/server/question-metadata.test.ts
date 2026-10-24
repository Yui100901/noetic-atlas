import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../server/index.js';

test('metadata API is read-only, includes pending/draft/archived states and validates unique bounded IDs', async t => {
  const app = await buildApp({ databasePath: ':memory:', staticRoot: 'test-results/no-metadata-web' }); t.after(() => app.close());
  const created: Record<string, any> = {};
  for (const id of ['pending', 'draft', 'archived', 'published']) {
    const response = await app.inject({ method: 'POST', url: '/api/questions', payload: { id, title: id, type: 'short_answer', stemMarkdown: '正文不应出现在元数据', answerMarkdown: '私有答案正文', status: id === 'draft' ? 'draft' : 'pending' } });
    assert.equal(response.statusCode, 201, response.body); created[id] = response.json();
  }
  let response = await app.inject({ method: 'POST', url: '/api/questions/review', payload: { ids: ['published'], action: 'approve', confirmed: true, expectedUpdatedAt: { published: created.published.updatedAt } } }); assert.equal(response.statusCode, 200, response.body);
  response = await app.inject({ method: 'PUT', url: '/api/questions/archived', payload: { ...created.archived, status: 'archived' } }); assert.equal(response.statusCode, 200, response.body);
  const before = (await app.inject('/api/export')).json();
  response = await app.inject({ method: 'POST', url: '/api/questions/metadata', payload: { ids: ['archived', 'missing', 'published', 'draft', 'pending'] } }); assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { items: ['archived', 'published', 'draft', 'pending'].map(id => ({ id, title: id, type: 'short_answer', status: id })), missingIds: ['missing'] });
  for (const payload of [{ ids: [] }, { ids: ['pending', 'pending'] }, { ids: ['pending'], status: 'all' }, { ids: ['invalid / id'] }, { ids: 'pending' }]) {
    response = await app.inject({ method: 'POST', url: '/api/questions/metadata', payload }); assert.equal(response.statusCode, 400, response.body);
  }
  const after = (await app.inject('/api/export')).json();
  for (const field of ['questions', 'papers', 'attempts', 'study', 'reviews', 'paperDrafts']) assert.deepEqual(after[field], before[field]);
  const spec = (await app.inject('/api/openapi.json')).json(), operation = spec.paths['/api/questions/metadata'].post;
  assert.equal(operation.requestBody.content['application/json'].schema.properties.ids.maxItems, 50000);
  assert.equal(operation.requestBody.content['application/json'].schema.additionalProperties, false);
  assert.ok(operation.responses[200].content['application/json'].schema.properties.missingIds);
});
