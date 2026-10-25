import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../server/index.js';
import { analyticsReportOutputSchema, weeklyReportOutputSchema } from '../../server/http/analytics-schemas.js';

async function fixture(t: test.TestContext) {
  const app = await buildApp({ databasePath: ':memory:', dailyPushScheduler: false, staticRoot: 'test-results/no-static-analytics' });
  t.after(() => app.close());
  const api = async (url: string, method: 'GET' | 'POST' = 'GET', payload?: unknown, expected = 200) => {
    const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
    assert.equal(response.statusCode, expected, response.body); return response;
  };
  return { app, api };
}

test('analytics HTTP documents real query and response schemas with null empty accuracy', async t => {
  const { api } = await fixture(t);
  const response = await api('/api/analytics?timeZone=UTC');
  assert.equal(response.headers['cache-control'], 'no-store');
  const report = analyticsReportOutputSchema.parse(response.json());
  assert.equal(report.summary.answers, 0); assert.equal(report.summary.accuracy, null); assert.equal(report.daily.length, 30);
  const weekly = weeklyReportOutputSchema.parse((await api('/api/analytics/weekly?timeZone=UTC')).json());
  assert.equal(weekly.isCurrentWeek, true); assert.equal(weekly.comparison.mode, 'matched_elapsed');
  const spec = (await api('/api/openapi.json')).json();
  const analytics = spec.paths['/api/analytics'].get, week = spec.paths['/api/analytics/weekly'].get;
  assert.ok(analytics.parameters.find((parameter: any) => parameter.name === 'from'));
  assert.ok(week.parameters.find((parameter: any) => parameter.name === 'week'));
  assert.ok(analytics.responses['200'].content['application/json'].schema.required.includes('quality'));
  assert.ok(week.responses['200'].content['application/json'].schema.properties.comparison.required.includes('mode'));
});

test('analytics rejects malformed dates, invalid ranges, timezone and unknown query options', async t => {
  const { api } = await fixture(t);
  for (const url of [
    '/api/analytics?from=2026-02-30&to=2026-03-01',
    '/api/analytics?from=2026-10-25&to=2026-10-01',
    '/api/analytics?from=2025-01-01&to=2026-10-25',
    '/api/analytics?timeZone=invalid-zone',
    '/api/analytics?includeAnswers=true',
    '/api/analytics/weekly?week=not-a-date',
    '/api/analytics/weekly?timeZone=invalid-zone',
  ]) await api(url, 'GET', undefined, 400);
});

test('active exams lock analytics and weekly reports until submission', async t => {
  const { api } = await fixture(t);
  await api('/api/import', 'POST', { mode: 'merge', data: { schemaVersion: 1, domains: [], categories: [], tags: [], questions: [
    { id: 'ANALYTICS-EXAM', title: '隔离判断', type: 'true_false', stemMarkdown: '判断命题', correctAnswers: ['true'], status: 'published' },
  ], documents: [], papers: [] } });
  const paper = (await api('/api/papers', 'POST', { title: '隔离考试', mode: 'manual', questionIds: ['ANALYTICS-EXAM'] }, 201)).json();
  const attempt = (await api(`/api/papers/${paper.id}/attempts`, 'POST', { mode: 'exam', durationMinutes: 120 }, 201)).json();
  for (const url of ['/api/analytics', '/api/analytics/weekly']) {
    const denied = (await api(url, 'GET', undefined, 409)).json(); assert.equal(denied.error.code, 'EXAM_ACTIVE');
  }
  await api(`/api/attempts/${attempt.id}/submit`, 'POST', { answers: {} });
  const report = analyticsReportOutputSchema.parse((await api('/api/analytics')).json());
  assert.equal(report.summary.sessions, 1); assert.equal(report.summary.answers, 0); assert.equal(report.summary.omitted, 1); assert.equal(report.summary.elapsedSeconds, 0);
});
