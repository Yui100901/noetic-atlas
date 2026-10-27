import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../server/index.js';

test('similar-question API documentation exposes search constraints, consent, recommendation results and SSE', async t => {
  const app = await buildApp({ databasePath: ':memory:', seedPath: 'missing-similar-doc-seed', staticRoot: 'missing-similar-doc-web', native: true, dailyPushScheduler: false }); t.after(() => app.close());
  const response = await app.inject('/api/openapi.json'); assert.equal(response.statusCode, 200);
  const spec = response.json(), search = spec.paths['/api/questions/{id}/similar'].get, ai = spec.paths['/api/ai/similar-questions'].post;
  const query = Object.fromEntries(search.parameters.filter((parameter: any) => parameter.in === 'query').map((parameter: any) => [parameter.name, parameter.schema]));
  assert.equal(query.q.maxLength, 100); assert.equal(query.page.minimum, 1); assert.ok(query.pageSize); assert.ok(query.partId);
  const input = ai.requestBody.content['application/json'].schema;
  assert.ok(input.required.includes('questionId')); assert.ok(input.required.includes('confirmed')); assert.equal(input.properties.confirmed.const, true);
  assert.equal(input.properties.q.maxLength, 100); assert.equal(input.properties.requirements.maxLength, 2000);
  const success = ai.responses['200'].content;
  assert.ok(success['application/json']); assert.ok(success['text/event-stream']);
  assert.match(ai.description, /result.*结构校验|result.*验证/);
  assert.ok(spec.components.schemas.AiRun.oneOf[0].properties.kind.enum.includes('similar_questions'));
  const results = spec.components.schemas.AiRun.oneOf[0].properties.result.oneOf;
  assert.ok(results.some((result: any) => result.properties?.candidates && result.properties?.scope && result.properties?.items?.items?.properties?.questionId), 'recommendation result shape should be documented');
  assert.ok(JSON.stringify(spec.components.schemas.AiRun).includes('failure'));
});

test('active exams deny both local similar search and AI recommendations before any provider or audit action', async t => {
  const app = await buildApp({ databasePath: ':memory:', seedPath: 'missing-similar-lock-seed', staticRoot: 'missing-similar-lock-web', native: true, dailyPushScheduler: false }); t.after(() => app.close());
  const api = async (method: 'GET' | 'POST', url: string, payload?: unknown, expected = 200) => {
    const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) }); assert.equal(response.statusCode, expected, response.body); return response.json();
  };
  const question = await api('POST', '/api/questions', { id: 'similar-exam-source', title: 'TCP基础判断', type: 'true_false', stemMarkdown: 'TCP属于传输层协议。', correctAnswers: ['true'] }, 201);
  await api('POST', '/api/questions/review', { ids: [question.id], action: 'approve', confirmed: true, expectedUpdatedAt: { [question.id]: question.updatedAt } });
  const paper = await api('POST', '/api/papers', { title: '相似题考试访问锁', mode: 'manual', questionIds: [question.id], scoring: { enabled: false } }, 201);
  const exam = await api('POST', `/api/papers/${paper.id}/attempts`, { mode: 'exam', durationMinutes: 1 }, 201);
  const local = await api('GET', `/api/questions/${question.id}/similar?q=TCP`, undefined, 409); assert.equal(local.error.code, 'EXAM_ACTIVE'); assert.equal(local.error.details.attemptId, exam.id);
  const ai = await app.inject({ method: 'POST', url: '/api/ai/similar-questions', headers: { accept: 'text/event-stream' }, payload: { questionId: question.id, confirmed: true } });
  assert.equal(ai.statusCode, 409); assert.equal(ai.json().error.code, 'EXAM_ACTIVE'); assert.ok(!String(ai.headers['content-type']).includes('text/event-stream'));
  await api('POST', `/api/attempts/${exam.id}/submit`, {});
  assert.deepEqual(await api('GET', '/api/ai/runs'), []);
});
