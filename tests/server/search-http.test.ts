import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../server/index.js';
import { searchResponseOutputSchema } from '../../server/http/search-schemas.js';

test('unified search HTTP publishes schemas, validates literal inputs and respects the exam lock', async t => {
  const app = await buildApp({ databasePath: ':memory:', dailyPushScheduler: false, staticRoot: 'test-results/no-search-static' }); t.after(() => app.close());
  const api = async (url: string, method: 'GET' | 'POST' = 'GET', payload?: unknown, expected = 200) => {
    const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
    assert.equal(response.statusCode, expected, response.body); return response;
  };
  const empty = await api('/api/search'); assert.equal(empty.headers['cache-control'], 'no-store');
  assert.equal(searchResponseOutputSchema.parse(empty.json()).totalAll, 0);
  for (const url of ['/api/search?q=' + 'a'.repeat(101), '/api/search?q=a+b+c+d+e+f+g+h+i', '/api/search?type=answers', '/api/search?pageSize=1000', '/api/search?includeUnpublished=1', '/api/search?unknown=true']) await api(url, 'GET', undefined, 400);
  const spec = (await api('/api/openapi.json')).json().paths['/api/search'].get;
  assert.ok(spec.parameters.find((item: any) => item.name === 'includeUnpublished'));
  assert.ok(spec.responses['200'].content['application/json'].schema.required.includes('counts'));
  assert.ok(spec.responses['200'].content['application/json'].schema.properties.items.items.required.includes('excerpt'));
  await api('/api/import', 'POST', { mode: 'merge', data: { schemaVersion: 1, domains: [], categories: [], tags: [], documents: [], papers: [], questions: [
    { id: 'SEARCH-EXAM', title: '100%_ SQLite', type: 'true_false', stemMarkdown: 'literal query', correctAnswers: ['true'], status: 'published' },
  ] } });
  const result = searchResponseOutputSchema.parse((await api('/api/search?q=' + encodeURIComponent('100%_'))).json()); assert.equal(result.totalAll, 1); assert.equal(result.items[0]!.id, 'SEARCH-EXAM');
  const paper = (await api('/api/papers', 'POST', { title: '隔离考试', mode: 'manual', questionIds: ['SEARCH-EXAM'] }, 201)).json();
  const attempt = (await api(`/api/papers/${paper.id}/attempts`, 'POST', { mode: 'exam', durationMinutes: 120 }, 201)).json();
  const denied = (await api('/api/search?q=SQLite', 'GET', undefined, 409)).json(); assert.equal(denied.error.code, 'EXAM_ACTIVE');
  await api(`/api/attempts/${attempt.id}/submit`, 'POST', {});
  assert.equal((await api('/api/search?q=SQLite')).json().totalAll, 1);
});
