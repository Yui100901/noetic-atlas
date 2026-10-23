import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../server/index.js';

test('exam routes enforce one active exam, retain it independently of normal drafts, and migrate completed timing', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-22T04:00:00.000Z') });
  const app = await buildApp({ databasePath: ':memory:', seedPath: 'missing-exam-route-seed', staticRoot: 'missing-exam-route-web', native: true }); t.after(() => app.close());
  async function api(url: string, method: 'GET' | 'POST' | 'PUT' = 'GET', payload?: unknown, expected = 200): Promise<any> { const r = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) }); assert.equal(r.statusCode, expected, r.body); return r.json(); }
  const stamp = new Date().toISOString();
  await api('/api/import', 'POST', { mode: 'merge', data: { schemaVersion: 1, generatedAt: stamp, domains: [], categories: [], tags: [], documents: [], papers: [], questions: [{ id: 'Q-TIME', title: '判断', type: 'true_false', stemMarkdown: '题干', answerMarkdown: '对', correctAnswers: ['true'], categoryIds: [], tagIds: [], status: 'published' }] } });
  const paper = await api('/api/papers', 'POST', { title: '考试路由', mode: 'manual', questionIds: ['Q-TIME'], scoring: { enabled: false } }, 201);
  for (let i = 0; i < 5; i++) await api(`/api/papers/${paper.id}/attempts`, 'POST', {}, 201);
  const exam = await api(`/api/papers/${paper.id}/attempts`, 'POST', { mode: 'exam', durationMinutes: 1 }, 201);
  assert.equal((await api('/api/exams/active')).attempt.id, exam.id);
  assert.equal((await api(`/api/papers/${paper.id}/attempts`, 'POST', { mode: 'exam' }, 409)).error.code, 'EXAM_ACTIVE');
  assert.equal((await api('/api/questions', 'GET', undefined, 409)).error.code, 'EXAM_ACTIVE');
  assert.ok((await api('/api/bootstrap')).stats);
  assert.equal((await api(`/api/attempts/${exam.id}`)).status, 'in_progress');
  await api(`/api/attempts/${exam.id}`, 'PUT', { answers: { 'Q-TIME': { value: 'true' } } });
  t.mock.timers.tick(61000);
  const activeRead = await api('/api/exams/active'); assert.equal(activeRead.attempt.status, 'in_progress', 'GET must remain read-only for native persistence');
  const late = await api(`/api/attempts/${exam.id}`, 'PUT', { answers: { 'Q-TIME': { value: 'false' } } }); assert.equal(late.status, 'submitted'); assert.equal(late.answers['Q-TIME'].value, 'true'); assert.equal(late.elapsedSeconds, 60); assert.equal(late.autoSubmitted, true);
  assert.equal((await api('/api/exams/sync', 'POST')).attempt, null);
  const sync = await api(`/api/attempts/${exam.id}/sync`, 'POST'); assert.equal(sync.submittedAt, late.submittedAt); assert.equal((await api('/api/questions/Q-TIME')).study.wrongCount, 0);
  const backup = await api('/api/export'); const target = await buildApp({ databasePath: ':memory:', seedPath: 'missing-exam-route-seed', staticRoot: 'missing-exam-route-web', native: true }); t.after(() => target.close());
  const imported = await target.inject({ method: 'POST', url: '/api/import', payload: { mode: 'merge', data: backup } }); assert.equal(imported.statusCode, 200, imported.body);
  const restored = (await target.inject(`/api/attempts/${exam.id}`)).json(); assert.equal(restored.elapsedSeconds, 60); assert.equal(restored.autoSubmitted, true); assert.equal(restored.deadlineAt, exam.deadlineAt);
});
