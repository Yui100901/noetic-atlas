import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../server/index.js';
import { DEFAULT_REVIEW_SCHEDULING } from '../../shared/models/settings.js';
import { attemptReviewOutputSchema, reviewCardViewOutputSchema, reviewQueueOutputSchema } from '../../server/http/review-scheduler-schemas.js';

async function fixture(t: test.TestContext, native = false) {
  const app = await buildApp({ databasePath: ':memory:', native, dailyPushScheduler: false, seedPath: 'test-results/no-adaptive-http-seed.json', staticRoot: 'test-results/no-adaptive-http-static' });
  t.after(() => app.close());
  const api = async (url: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' = 'GET', payload?: unknown, expected = 200) => {
    const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
    assert.equal(response.statusCode, expected, response.body); return response;
  };
  await api('/api/import', 'POST', { mode: 'merge', data: {
    schemaVersion: 1, domains: [], categories: [], tags: [], documents: [],
    questions: [
      { id: 'FSRS-TF', title: '隔离判断', type: 'true_false', stemMarkdown: 'QUESTION_PRIVATE_CANARY', correctAnswers: ['true'], status: 'published' },
      { id: 'FSRS-SA', title: '隔离说明', type: 'short_answer', stemMarkdown: 'QUESTION_PRIVATE_CANARY', answerMarkdown: 'REFERENCE_PRIVATE_CANARY', status: 'published' },
    ],
    papers: [{ id: 'FSRS-PAPER', title: '隔离复习题集', mode: 'manual', questionIds: ['FSRS-TF', 'FSRS-SA'] }],
  } });
  const attempt = async (mode: 'practice' | 'exam' = 'practice') => (await api('/api/papers/FSRS-PAPER/attempts', 'POST', { mode, ...(mode === 'exam' ? { durationMinutes: 120 } : {}) }, 201)).json();
  const submit = async (id: string) => (await api(`/api/attempts/${id}/submit`, 'POST', { answers: { 'FSRS-TF': { value: ['true'] } } })).json();
  const state = async () => {
    const data = (await api('/api/export')).json();
    return Object.fromEntries(['reviewCards', 'reviewEvents', 'study', 'studyParts', 'reviews'].map(key => [key, data[key]]));
  };
  return { app, api, attempt, submit, state };
}

for (const native of [false, true]) test(`${native ? 'native' : 'web'} FSRS HTTP routes publish concrete requests and responses and support idempotent review`, async t => {
  const { api, attempt, submit } = await fixture(t, native);
  const paths = (await api('/api/openapi.json')).json().paths;
  for (const [path, methods] of [
    ['/api/review-scheduler/card', ['get', 'patch']], ['/api/review-scheduler/review', ['post']],
    ['/api/review-scheduler/queue', ['get']], ['/api/review-scheduler/attempts/{id}', ['get']],
    ['/api/review-scheduler/attempts/{id}/rating', ['post']],
  ] as const) for (const method of methods) assert.ok(paths[path]?.[method], `${method} ${path}`);
  const manualBody = paths['/api/review-scheduler/review'].post.requestBody.content['application/json'].schema;
  assert.equal(manualBody.additionalProperties, false);
  assert.ok(manualBody.required.includes('requestId')); assert.deepEqual(manualBody.properties.rating.enum, ['again', 'hard', 'good', 'easy']);
  const patchBody = paths['/api/review-scheduler/card'].patch.requestBody.content['application/json'].schema;
  assert.equal(patchBody.additionalProperties, false); assert.ok(patchBody.properties.suspended); assert.ok(patchBody.properties.dueAt);
  const ratingBody = paths['/api/review-scheduler/attempts/{id}/rating'].post.requestBody.content['application/json'].schema;
  assert.ok(ratingBody.required.includes('leafId')); assert.ok(ratingBody.required.includes('rating'));
  assert.ok(paths['/api/review-scheduler/card'].get.parameters.some((parameter: any) => parameter.name === 'direction'));
  assert.ok(paths['/api/review-scheduler/queue'].get.parameters.some((parameter: any) => parameter.name === 'pageSize'));
  const success = (path: string, method: string) => paths[path][method].responses['200'].content['application/json'].schema;
  assert.ok(success('/api/review-scheduler/card', 'get').required.includes('preview'));
  assert.ok(success('/api/review-scheduler/queue', 'get').properties.summary.required.includes('suspended'));
  assert.ok(success('/api/review-scheduler/attempts/{id}', 'get').properties.items.items.required.includes('eligible'));
  const payload = { questionId: 'FSRS-TF', rating: 'good', requestId: 'http-idempotent' };
  const first = reviewCardViewOutputSchema.parse((await api('/api/review-scheduler/review', 'POST', payload)).json());
  const duplicate = reviewCardViewOutputSchema.parse((await api('/api/review-scheduler/review', 'POST', payload)).json());
  assert.equal(first.eventCount, 1); assert.deepEqual(duplicate.card, first.card);
  await api('/api/review-scheduler/review', 'POST', { ...payload, rating: 'easy' }, 409);
  const paused = reviewCardViewOutputSchema.parse((await api('/api/review-scheduler/card', 'PATCH', { questionId: 'FSRS-TF', suspended: true })).json());
  assert.equal(paused.suspended, true); assert.equal(paused.card!.memory.reps, 1);
  reviewQueueOutputSchema.parse((await api('/api/review-scheduler/queue')).json());
  const value = await attempt(); await submit(value.id);
  const overview = attemptReviewOutputSchema.parse((await api(`/api/review-scheduler/attempts/${value.id}`)).json());
  assert.equal(overview.items.find(item => item.leafId === 'FSRS-TF')!.rating, 'good');
  const corrected = attemptReviewOutputSchema.parse((await api(`/api/review-scheduler/attempts/${value.id}/rating`, 'POST', { leafId: 'FSRS-TF', rating: 'again' })).json());
  assert.equal(corrected.items.find(item => item.leafId === 'FSRS-TF')!.rating, 'again');
});

test('FSRS HTTP rejects invalid query options, strict body fields and unknown attempt leaves without mutations', async t => {
  const { api, attempt, submit, state } = await fixture(t);
  const value = await attempt(); await submit(value.id); const before = await state();
  for (const url of [
    '/api/review-scheduler/card?questionId=FSRS-TF&direction=reverse',
    '/api/review-scheduler/card?questionId=FSRS-TF&includeAnswers=true',
    '/api/review-scheduler/queue?pageSize=15', '/api/review-scheduler/queue?kind=unknown',
    '/api/review-scheduler/queue?includeAnswers=true',
  ]) await api(url, 'GET', undefined, 400);
  await api('/api/review-scheduler/review', 'POST', { questionId: 'FSRS-TF', rating: 'excellent', requestId: 'bad-rating' }, 400);
  await api('/api/review-scheduler/review', 'POST', { questionId: 'FSRS-TF', rating: 'good', requestId: 'bad-field', mastery: 3 }, 400);
  await api('/api/review-scheduler/card', 'PATCH', { questionId: 'FSRS-TF' }, 400);
  await api('/api/review-scheduler/card', 'PATCH', { questionId: 'FSRS-TF', dueAt: 'tomorrow' }, 400);
  await api('/api/review-scheduler/card', 'PATCH', { questionId: 'FSRS-TF', suspended: true, force: true }, 400);
  const ratingUrl = `/api/review-scheduler/attempts/${value.id}/rating`;
  const unknown = (await api(ratingUrl, 'POST', { leafId: 'NOT-IN-ATTEMPT', rating: 'good' }, 400)).json();
  assert.equal(unknown.error.code, 'REVIEW_LEAF_INVALID');
  await api(ratingUrl, 'POST', { leafId: 'FSRS-TF', rating: 'good', force: true }, 400);
  assert.deepEqual(await state(), before);
});

test('FSRS card previews, batch overview and queue GETs preserve scheduling records and omit question bodies', async t => {
  const { api, attempt, submit, state } = await fixture(t);
  const initial = await state();
  const unseen = reviewCardViewOutputSchema.parse((await api('/api/review-scheduler/card?questionId=FSRS-SA')).json());
  assert.equal(unseen.card, null); assert.equal(unseen.preview.length, 4); assert.deepEqual(await state(), initial);
  const value = await attempt(); await submit(value.id); const before = await state();
  for (const url of [
    '/api/review-scheduler/card?questionId=FSRS-SA', '/api/review-scheduler/queue',
    `/api/review-scheduler/attempts/${value.id}`,
    `/api/review-scheduler/card?questionId=FSRS-TF&attemptId=${value.id}&leafId=FSRS-TF`,
  ]) {
    const response = await api(url); assert.equal(response.headers['cache-control'], 'no-store');
    assert.doesNotMatch(response.body, /QUESTION_PRIVATE_CANARY|REFERENCE_PRIVATE_CANARY|stemMarkdown|answerMarkdown|explanationMarkdown/);
  }
  assert.deepEqual(await state(), before);
});

test('active exams protect every FSRS read and write route until submission', async t => {
  const { api, attempt, submit, state } = await fixture(t);
  const historical = await attempt(); await submit(historical.id); const before = await state();
  const exam = await attempt('exam');
  const calls: Array<[string, 'GET' | 'POST' | 'PATCH', unknown?]> = [
    ['/api/review-scheduler/card?questionId=FSRS-TF', 'GET'], ['/api/review-scheduler/queue', 'GET'],
    [`/api/review-scheduler/attempts/${historical.id}`, 'GET'],
    ['/api/review-scheduler/review', 'POST', { questionId: 'FSRS-TF', rating: 'good', requestId: 'blocked-by-exam' }],
    ['/api/review-scheduler/card', 'PATCH', { questionId: 'FSRS-TF', suspended: true }],
    [`/api/review-scheduler/attempts/${historical.id}/rating`, 'POST', { leafId: 'FSRS-TF', rating: 'again' }],
  ];
  for (const [url, method, payload] of calls) {
    const denied = (await api(url, method, payload, 409)).json();
    assert.equal(denied.error.code, 'EXAM_ACTIVE'); assert.equal(denied.error.details.attemptId, exam.id);
  }
  await api(`/api/attempts/${exam.id}/submit`, 'POST', { answers: {} });
  const after = await state();
  for (const table of ['reviewCards', 'reviewEvents', 'studyParts', 'reviews']) assert.deepEqual(after[table], before[table]);
  const dates = (rows: any[]) => rows.map(({ questionId, nextReviewAt, lastReviewedAt }) => ({ questionId, nextReviewAt, lastReviewedAt }));
  assert.deepEqual(dates(after.study), dates(before.study));
  reviewCardViewOutputSchema.parse((await api('/api/review-scheduler/card?questionId=FSRS-TF')).json());
  reviewQueueOutputSchema.parse((await api('/api/review-scheduler/queue')).json());
});

test('fixed scheduling rejects explicit recall ratings without changing existing memory', async t => {
  const { api, attempt, submit, state } = await fixture(t);
  const value = await attempt(); await submit(value.id);
  const settings = (await api('/api/settings')).json();
  await api('/api/settings', 'PUT', { settings: { ...settings, reviewScheduling: { ...settings.reviewScheduling, strategy: 'fixed' } } });
  const before = await state();
  for (const rating of ['easy', null]) {
    const response = await api(`/api/review-scheduler/attempts/${value.id}/rating`, 'POST', { leafId: 'FSRS-TF', rating }, 409);
    assert.equal(response.json().error.code, 'REVIEW_FIXED_MODE');
  }
  assert.deepEqual(await state(), before);
});

test('review scheduling configuration round-trips custom fixed settings and migrates missing defaults through HTTP', async t => {
  const { api } = await fixture(t);
  const original = (await api('/api/settings')).json();
  assert.deepEqual(original.reviewScheduling, DEFAULT_REVIEW_SCHEDULING);
  const data = (await api('/api/settings/export?includeAi=false')).json();
  const custom = { strategy: 'fixed', desiredRetention: 0.95, maximumIntervalDays: 180, learningStepsMinutes: [2, 15], relearningStepsMinutes: [5], enableFuzz: true, autoRateObjective: false, reduceNewWhenOverdue: false };
  data.system.reviewScheduling = custom;
  const preview = (await api('/api/settings/import/preview', 'POST', { data })).json();
  assert.deepEqual(preview.systemChanges.find((change: any) => change.key === 'reviewScheduling'), { key: 'reviewScheduling', before: DEFAULT_REVIEW_SCHEDULING, after: custom });
  assert.deepEqual((await api('/api/settings')).json(), original);
  await api('/api/settings/import', 'POST', { data, fingerprint: preview.fingerprint, confirmed: true });
  assert.deepEqual((await api('/api/settings')).json().reviewScheduling, custom);
  assert.deepEqual((await api('/api/settings/export?includeAi=false')).json().system.reviewScheduling, custom);
  assert.deepEqual((await api('/api/export')).json().settings[0].reviewScheduling, custom);
  const fixed = reviewCardViewOutputSchema.parse((await api('/api/review-scheduler/card?questionId=FSRS-TF')).json());
  assert.equal(fixed.strategy, 'fixed'); assert.equal(fixed.canReview, false); assert.deepEqual(fixed.preview, []);
  const invalid = structuredClone(data); invalid.system.reviewScheduling.unknown = true;
  await api('/api/settings/import/preview', 'POST', { data: invalid }, 400);
  delete data.system.reviewScheduling;
  const legacy = (await api('/api/settings/import/preview', 'POST', { data })).json();
  await api('/api/settings/import', 'POST', { data, fingerprint: legacy.fingerprint, confirmed: true });
  assert.deepEqual((await api('/api/settings')).json().reviewScheduling, DEFAULT_REVIEW_SCHEDULING);
  data.system.reviewScheduling = { strategy: 'fixed' };
  const partial = (await api('/api/settings/import/preview', 'POST', { data })).json();
  await api('/api/settings/import', 'POST', { data, fingerprint: partial.fingerprint, confirmed: true });
  assert.deepEqual((await api('/api/settings')).json().reviewScheduling, { ...DEFAULT_REVIEW_SCHEDULING, strategy: 'fixed' });
});
