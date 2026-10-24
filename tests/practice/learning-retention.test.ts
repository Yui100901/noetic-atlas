import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { buildApp } from '../../server/index.js';
import { Store } from '../../server/core/store.js';
import { ApiError, parse, questionSchema } from '../../server/core/validation.js';
import { buildPaper, createAttempt, submitAttempt, reviewAttempt, type StoredAttempt } from '../../server/modules/practice/service.js';
import { registerContextLearningRoutes } from '../../server/modules/practice/learning.js';
import { registerGlobalLearningRoutes } from '../../server/modules/practice/global-learning.js';
import { assetUrl } from '../../shared/assets/assets.js';
import type { Question } from '../../shared/models/types.js';
import type { SystemSettings } from '../../shared/models/settings.js';

type App = Awaited<ReturnType<typeof buildApp>>;
const stamp = '2026-01-01T00:00:00.000Z';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=';
const question = (id: string, type: Question['type'] = 'true_false'): Question => ({
  ...parse(questionSchema, { id, title: id, type, stemMarkdown: `原始题干 ${id}`, answerMarkdown: `原始答案 ${id}`, explanationMarkdown: `原始解析 ${id}`, status: 'published', ...(type === 'true_false' ? { correctAnswers: ['true'] } : {}) }),
  id, createdAt: stamp, updatedAt: stamp,
});
const group = (id: string): Question => ({
  ...parse(questionSchema, { id, title: id, type: 'group', stemMarkdown: '原有公共材料', status: 'published', parts: [
    { id: 'a', title: '独立小题甲', type: 'true_false', stemMarkdown: '甲应为真', correctAnswers: ['true'], answerMarkdown: '甲答案', explanationMarkdown: '甲解析' },
    { id: 'b', title: '独立小题乙', type: 'true_false', stemMarkdown: '乙应为真', correctAnswers: ['true'], answerMarkdown: '乙答案', explanationMarkdown: '乙解析' },
  ] }), id, createdAt: stamp, updatedAt: stamp,
});
const envelope = (questions: Question[]) => ({ schemaVersion: 1, domains: [], categories: [], tags: [], questions, documents: [], papers: [] });
async function call(app: App, url: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', payload?: unknown, expected = 200): Promise<any> {
  const response = await app.inject({ url, method, ...(payload === undefined ? {} : { payload }) });
  assert.equal(response.statusCode, expected, response.body); return response.json();
}
async function fixture(t: test.TestContext, questions: Question[] = []) {
  const app = await buildApp({ databasePath: ':memory:', seedPath: 'missing-learning-retention-seed', staticRoot: 'missing-learning-retention-web' });
  t.after(() => app.close());
  if (questions.length) await call(app, '/api/import', 'POST', { mode: 'merge', data: envelope(questions) });
  return app;
}
async function paper(app: App, title: string, ids: string[], scored = false) {
  return call(app, '/api/papers', 'POST', { title, mode: 'manual', questionIds: ids, scoring: { enabled: scored } }, 201);
}
async function replacePaper(app: App, saved: any, ids: string[]) {
  return call(app, `/api/papers/${saved.id}`, 'PUT', { title: saved.title, mode: 'manual', questionIds: ids, scoring: { enabled: saved.scoring.enabled } });
}
async function submit(app: App, saved: any, answers: Record<string, { value: string | string[] }>) {
  const draft = await call(app, `/api/papers/${saved.id}/attempts`, 'POST', undefined, 201);
  return call(app, `/api/attempts/${draft.id}/submit`, 'POST', { answers });
}
const wrong = (app: App, paperId: string) => call(app, `/api/learning/questions?source=paper&paperId=${paperId}&kind=wrong`);
async function prune(app: App, changes: Partial<SystemSettings> = { maxHistoryPerPaper: 1 }) {
  const settings = { ...await call(app, '/api/settings'), ...changes };
  const preview = await call(app, '/api/settings', 'PUT', { settings }, 409);
  assert.equal(preview.error.code, 'RETENTION_CONFIRMATION_REQUIRED');
  return call(app, '/api/settings', 'PUT', { settings, confirmedRetention: true, expectedRetention: preview.error.details });
}
async function readers(t: test.TestContext, roots: Question[]) {
  const store = new Store(':memory:'), app = Fastify();
  app.setErrorHandler((error, _request, reply) => error instanceof ApiError ? reply.code(error.status).send({ error: { code: error.code, message: error.message } }) : reply.code(500).send({ error: String(error) }));
  registerContextLearningRoutes(app, store); registerGlobalLearningRoutes(app, store);
  t.after(async () => { await app.close(); store.db.close(); });
  for (const q of roots) store.put('questions', q.id, q);
  const saved = buildPaper(store, { id: 'reader-source', title: '读取边界', description: '', mode: 'manual', questionIds: roots.map(q => q.id), scoring: { enabled: true } }); store.put('papers', saved.id, saved);
  const submitted = submitAttempt(store, createAttempt(store, saved), Object.fromEntries(roots.map(q => [q.id, { value: q.type === 'true_false' ? 'false' : 'PRIVATE_OFF_PAGE_ANSWER_CANARY' }])));
  for (const q of roots.filter(q => q.type === 'short_answer')) reviewAttempt(store, submitted, { [q.id]: 1 });
  store.database.projections.refreshAll();
  const get = async (path: string) => { const response = await app.inject(path); assert.equal(response.statusCode, 200, response.body); return response.json(); };
  return { store, saved, submitted, get };
}

test('learning context GETs never rewrite a dirty paper projection', async t => {
  const { store, saved, get } = await readers(t, [question('reader-dirty')]);
  store.put('papers', saved.id, { ...saved, title: '尚未刷新的题集名称' });
  const changes = () => Number((store.db.prepare('SELECT total_changes() AS count').get() as any).count), before = changes();
  const summary = await get(`/api/learning/summary?source=paper&paperId=${saved.id}`);
  assert.equal(summary.title, '尚未刷新的题集名称'); assert.equal(summary.counts.wrong, 1);
  await get(`/api/learning/questions?source=paper&paperId=${saved.id}&kind=wrong`);
  assert.equal(changes(), before, 'GET should use compact current-row fallback rather than refreshing dirty projections');
});

test('context and global wrong pages hydrate only selected leaf bodies for retained and pruned attempts', async t => {
  const roots = Array.from({ length: 30 }, (_, index) => question(`reader-${String(index + 1).padStart(2, '0')}`, index === 29 ? 'short_answer' : 'true_false'));
  roots[29] = { ...roots[29]!, stemMarkdown: 'OFF_PAGE_BODY_CANARY', answerMarkdown: 'OFF_PAGE_REFERENCE_CANARY' };
  const { store, saved, submitted, get } = await readers(t, roots), db = store.database;
  const all = db.all.bind(db), one = db.one.bind(db), observed: unknown[] = [], violations: string[] = [];
  db.all = ((query: any) => { const rows = all(query); observed.push(...rows); return rows; }) as typeof db.all;
  db.one = ((query: any) => { const row = one(query); if (row) observed.push(row); return row; }) as typeof db.one;
  for (const phase of ['retained', 'pruned']) {
    if (phase === 'pruned') { store.remove('attempts', submitted.id); store.database.projections.refreshAll(); }
    for (const path of [`/api/learning/questions?source=paper&paperId=${saved.id}&kind=wrong&page=2&pageSize=10`, '/api/learning/global/questions?kind=wrong&page=2&pageSize=10']) {
      observed.length = 0; const page = await get(path); assert.equal(page.items.length, 10); assert.equal(page.total, 30);
      assert.ok(page.items.every((item: any) => item.question.id !== roots[29]!.id));
      const read = JSON.stringify(observed);
      if (read.includes('OFF_PAGE_BODY_CANARY') || read.includes('OFF_PAGE_REFERENCE_CANARY') || read.includes('PRIVATE_OFF_PAGE_ANSWER_CANARY')) violations.push(`${phase}: ${path}`);
    }
  }
  assert.deepEqual(violations, [], 'pagination must trim question bodies and user answers inside SQLite before hydration');
});

test('settings history cleanup preserves wrong snapshots, source identity, review events and source-local correction', async t => {
  const q = question('retained-bool'), other = question('retained-other'), app = await fixture(t, [q, other]);
  let a = await paper(app, '保留来源甲', [q.id, other.id]);
  const b = await paper(app, '保留来源乙', [q.id]);
  const old = await submit(app, a, { [q.id]: { value: 'false' }, [other.id]: { value: 'true' } });
  await call(app, `/api/attempts/${old.id}/review`, 'PUT', { mastery: { [q.id]: 1 } });
  await call(app, `/api/study/${q.id}`, 'PUT', { favorite: true, notes: '清理历史后保留此笔记', nextReviewAt: '2000-01-01T00:00:00.000Z' });
  const wrongB = await submit(app, b, { [q.id]: { value: 'false' } });
  const beforeStudy = await call(app, '/api/study');
  a = await replacePaper(app, a, [other.id]);
  await submit(app, a, { [other.id]: { value: 'true' } });
  const current = await call(app, `/api/questions/${q.id}`);
  await call(app, `/api/questions/${q.id}`, 'PUT', { ...current, study: undefined, title: '后来编辑的标题', stemMarkdown: '后来编辑的题干', answerMarkdown: '后来编辑的答案' });
  const applied = await prune(app); assert.equal(applied.retention.history, 1);
  await call(app, `/api/attempts/${old.id}`, 'GET', undefined, 404);
  const kept = (await wrong(app, a.id)).items[0];
  assert.equal(kept.question.stemMarkdown, q.stemMarkdown); assert.equal(kept.question.answerMarkdown, q.answerMarkdown); assert.equal(kept.question.explanationMarkdown, q.explanationMarkdown);
  assert.equal(kept.attemptId, old.id); assert.equal(kept.historyAvailable, false); assert.equal(kept.wrongCount, 1); assert.equal(kept.study.notes, '清理历史后保留此笔记');
  assert.deepEqual(await call(app, '/api/study'), beforeStudy);
  const global = (await call(app, '/api/learning/global/questions?kind=wrong')).items[0];
  const origin = global.origins.find((entry: any) => entry.paperId === a.id);
  assert.equal(origin.attemptId, old.id); assert.equal(origin.historyAvailable, false); assert.equal(origin.paperTitle, '保留来源甲'); assert.equal(origin.paperVersion, 1);
  assert.equal((await call(app, `/api/learning/attempts?source=paper&paperId=${a.id}&status=submitted`)).total, 1);
  a = await replacePaper(app, a, [q.id, other.id]);
  await submit(app, a, { [q.id]: { value: 'true' }, [other.id]: { value: 'true' } });
  assert.equal((await wrong(app, a.id)).total, 0); assert.equal((await wrong(app, b.id)).items[0].attemptId, wrongB.id);
  const stillWrong = (await call(app, '/api/learning/global/questions?kind=wrong')).items[0];
  assert.deepEqual(stillWrong.origins.map((entry: any) => entry.paperId), [b.id]);
});

test('actual submit/review services refresh persistent subjective judgments, preserve chronology and fall back on grade removal', async t => {
  const store = new Store(':memory:'), app = Fastify();
  app.setErrorHandler((error, _request, reply) => error instanceof ApiError ? reply.code(error.status).send({ error: { code: error.code, message: error.message } }) : reply.code(500).send({ error: String(error) }));
  registerContextLearningRoutes(app, store); registerGlobalLearningRoutes(app, store);
  t.after(async () => { await app.close(); store.db.close(); });
  const q = question('retained-essay', 'short_answer'); store.put('questions', q.id, q);
  const saved = buildPaper(store, { id: 'retained-subjective-source', title: '主观重评来源', description: '', mode: 'manual', questionIds: [q.id], scoring: { enabled: true } }); store.put('papers', saved.id, saved);
  const submitDirect = (value: string) => submitAttempt(store, createAttempt(store, saved), { [q.id]: { value } });
  const old = submitDirect('较早作答'); reviewAttempt(store, old, { [q.id]: 1 });
  const newer = submitDirect('较新作答'); reviewAttempt(store, newer, { [q.id]: 3 });
  const getWrong = async () => { const response = await app.inject(`/api/learning/questions?source=paper&paperId=${saved.id}&kind=wrong`); assert.equal(response.statusCode, 200, response.body); return response.json(); };
  assert.equal((await getWrong()).total, 0);
  reviewAttempt(store, store.require<StoredAttempt>('attempts', old.id), { [q.id]: 0 });
  assert.ok(store.require<StoredAttempt>('attempts', old.id).updatedAt! >= newer.submittedAt!);
  assert.equal((await getWrong()).total, 0, 'regrading an older answer does not make it the latest submission');
  reviewAttempt(store, store.require<StoredAttempt>('attempts', newer.id), { [q.id]: null });
  assert.equal((await getWrong()).items[0].attemptId, old.id, 'an ungraded latest submission falls back to the previous judged result');
  assert.equal(store.require<any>('learning_results', newer.id).items[0].judgment, undefined);
  reviewAttempt(store, store.require<StoredAttempt>('attempts', old.id), { [q.id]: 3 });
  assert.equal((await getWrong()).total, 0);
  reviewAttempt(store, store.require<StoredAttempt>('attempts', newer.id), { [q.id]: 1 });
  assert.equal((await getWrong()).items[0].attemptId, newer.id);
  reviewAttempt(store, store.require<StoredAttempt>('attempts', newer.id), { [q.id]: null });
  assert.equal((await getWrong()).total, 0, 'removing a grade restores the preceding correct judgment');
  assert.deepEqual(store.require<any>('learning_results', newer.id).questions, [], 'removed grades release obsolete wrong snapshots');
});

test('automatic pruning keeps a graded subjective mistake behind a newer pending answer and later grade removal', async t => {
  const q = question('auto-retained-essay', 'short_answer'), app = await fixture(t, [q]);
  const saved = await paper(app, '自动保留主观错题', [q.id], true);
  const old = await submit(app, saved, { [q.id]: { value: '旧的已评分回答' } });
  await call(app, `/api/attempts/${old.id}/review`, 'PUT', { scores: { [q.id]: 1 } });
  await call(app, '/api/settings', 'PUT', { settings: { ...await call(app, '/api/settings'), maxHistoryPerPaper: 1 } });
  const pending = await submit(app, saved, { [q.id]: { value: '新的待评分回答' } });
  await call(app, `/api/attempts/${old.id}`, 'GET', undefined, 404);
  let result = (await wrong(app, saved.id)).items[0]; assert.equal(result.attemptId, old.id); assert.equal(result.historyAvailable, false);
  await call(app, `/api/attempts/${pending.id}/review`, 'PUT', { scores: { [q.id]: 3 } }); assert.equal((await wrong(app, saved.id)).total, 0);
  await call(app, `/api/attempts/${pending.id}/review`, 'PUT', { scores: { [q.id]: null } });
  result = (await wrong(app, saved.id)).items[0]; assert.equal(result.attemptId, old.id); assert.equal(result.wrongCount, 1); assert.equal(result.historyAvailable, false);
  const exported = await call(app, '/api/export');
  assert.equal(exported.learningResults.find((entry: any) => entry.id === pending.id).items[0].judgment, undefined);
  assert.equal(exported.learningResults.find((entry: any) => entry.id === old.id).items[0].judgment, 'incorrect');
});

test('reset preview detects same-count edits and reset preserves favorites, notes, historical scores and drafts across root and part state', async t => {
  const q = group('reset-group'), app = await fixture(t, [q]);
  const saved = await paper(app, '独立重置范围', [q.id], true);
  const old = await submit(app, saved, { [`${q.id}::a`]: { value: 'false' }, [`${q.id}::b`]: { value: 'true' } });
  await call(app, `/api/attempts/${old.id}/review`, 'PUT', { mastery: { [`${q.id}::a`]: 0, [`${q.id}::b`]: 3 } });
  await call(app, `/api/study/${q.id}`, 'PUT', { favorite: true, notes: '整题笔记', mastery: 2, nextReviewAt: '2000-01-01T00:00:00.000Z' });
  await call(app, `/api/study/${q.id}`, 'PUT', { partId: 'a', notes: '甲笔记', nextReviewAt: '2000-01-01T00:00:00.000Z' });
  await call(app, `/api/study/${q.id}`, 'PUT', { partId: 'b', notes: '乙笔记', nextReviewAt: '2099-01-01T00:00:00.000Z' });
  const draft = await call(app, `/api/papers/${saved.id}/attempts`, 'POST', undefined, 201);
  await call(app, `/api/attempts/${draft.id}`, 'PUT', { answers: { [`${q.id}::a`]: { value: 'true' } } });
  const history = await call(app, `/api/attempts/${old.id}`), draftBefore = await call(app, `/api/attempts/${draft.id}`);
  const stale = await call(app, '/api/learning/reset-preview');
  assert.deepEqual(stale.counts, { states: 1, partStates: 2, reviews: 2, results: 1 }); assert.deepEqual(stale.retained, { attempts: 1, drafts: 1 });
  await call(app, `/api/study/${q.id}`, 'PUT', { notes: '预览后改动但数量未变' });
  const rejected = await call(app, '/api/learning/reset', 'POST', { confirmed: true, fingerprint: stale.fingerprint }, 409);
  assert.equal(rejected.error.code, 'LEARNING_RESET_PREVIEW_STALE'); assert.equal((await wrong(app, saved.id)).total, 1);
  const fresh = await call(app, '/api/learning/reset-preview'); assert.notEqual(fresh.fingerprint, stale.fingerprint);
  await call(app, '/api/learning/reset', 'POST', { confirmed: true, fingerprint: fresh.fingerprint });
  assert.deepEqual((await call(app, '/api/learning/global/summary')).counts, { wrong: 0, favorite: 2, due: 0 });
  assert.equal((await wrong(app, saved.id)).total, 0);
  const after = await call(app, '/api/study'); assert.deepEqual(after.reviews, []);
  for (const state of [...after.items, ...after.partItems]) { assert.equal(state.mastery, null); assert.equal(state.nextReviewAt, null); assert.equal(state.lastReviewedAt, null); assert.equal(state.wrongCount, 0); }
  assert.equal(after.items[0].favorite, true); assert.equal(after.items[0].notes, '预览后改动但数量未变');
  assert.deepEqual(after.partItems.map((state: any) => [state.partId, state.notes]).sort(), [['a', '甲笔记'], ['b', '乙笔记']]);
  assert.deepEqual(await call(app, `/api/attempts/${old.id}`), history);
  const draftAfter = await call(app, `/api/attempts/${draft.id}`); assert.equal(draftAfter.status, draftBefore.status); assert.deepEqual(draftAfter.answers, draftBefore.answers);
  await call(app, '/api/learning/reset', 'POST', { confirmed: false, fingerprint: fresh.fingerprint }, 400);
});

test('JSON migration preserves pruned evidence and reset markers prevent old retained history from reseeding progress', async t => {
  const q = question('migration-wrong'), other = question('migration-other'), app = await fixture(t, [q, other]);
  let a = await paper(app, '迁移已清理来源', [q.id]); const b = await paper(app, '迁移保留来源', [q.id]);
  const old = await submit(app, a, { [q.id]: { value: 'false' } });
  await submit(app, b, { [q.id]: { value: 'false' } });
  a = await replacePaper(app, a, [other.id]); await submit(app, a, { [other.id]: { value: 'true' } }); await prune(app);
  const backup = await call(app, '/api/export');
  assert.ok(backup.learningResults.some((result: any) => result.id === old.id)); assert.ok(!backup.attempts.some((attempt: any) => attempt.id === old.id));
  const copy = await fixture(t); await call(copy, '/api/import', 'POST', { mode: 'merge', data: backup });
  const migrated = (await wrong(copy, a.id)).items[0]; assert.equal(migrated.attemptId, old.id); assert.equal(migrated.historyAvailable, false); assert.equal(migrated.question.stemMarkdown, q.stemMarkdown);
  assert.equal((await call(copy, '/api/learning/global/questions?kind=wrong')).items[0].origins.length, 2);
  const preview = await call(copy, '/api/learning/reset-preview'); await call(copy, '/api/learning/reset', 'POST', { confirmed: true, fingerprint: preview.fingerprint });
  const resetBackup = await call(copy, '/api/export');
  assert.ok(resetBackup.learningResults.length > 0); assert.ok(resetBackup.learningResults.every((result: any) => result.reset && !result.items.length && !result.questions.length));
  assert.equal(resetBackup.learningResults.length, resetBackup.attempts.filter((attempt: any) => attempt.status === 'submitted').length);
  const resetCopy = await fixture(t); await call(resetCopy, '/api/import', 'POST', { mode: 'merge', data: resetBackup });
  assert.deepEqual((await call(resetCopy, '/api/learning/global/summary')).counts, { wrong: 0, favorite: 0, due: 0 });
  assert.equal((await wrong(resetCopy, b.id)).total, 0); assert.equal((await call(resetCopy, '/api/export')).attempts.length, resetBackup.attempts.length);
  await call(resetCopy, '/api/import', 'POST', { mode: 'merge', data: resetBackup });
  assert.equal((await wrong(resetCopy, b.id)).total, 0, 'repeated migration remains idempotent after a reset');
});

test('migration rejects contradictory same-ID attempt evidence and rolls back all newly imported records', async t => {
  const q = question('consistent-evidence'), source = await fixture(t, [q]);
  const saved = await paper(source, '一致性校验', [q.id]); await submit(source, saved, { [q.id]: { value: 'false' } });
  const backup = await call(source, '/api/export');
  const mutations: Array<[string, (result: any) => void]> = [
    ['snapshot', result => { result.questions[0].stemMarkdown = '不属于原作答的伪造题干'; }],
    ['judgment', result => { result.items[0].judgment = 'correct'; result.questions = []; }],
    ['source', result => { result.paperTitle = '伪造来源标题'; }],
    ['identity', result => { result.items[0].id = 'another-evidence'; result.questions[0].id = 'another-evidence'; }],
    ['reset origin', result => { result.reset = true; result.items = []; result.questions = []; result.paperVersion += 1; }],
  ];
  const target = await fixture(t);
  for (const [label, mutate] of mutations) {
    const changed = structuredClone(backup); changed.questions.push(question(`rollback-${label.replaceAll(' ', '-')}`)); mutate(changed.learningResults[0]);
    const rejected = await call(target, '/api/import', 'POST', { mode: 'merge', data: changed }, 400);
    assert.equal(rejected.error.code, 'LEARNING_RESULT_MISMATCH', label);
    const after = await call(target, '/api/export');
    for (const key of ['questions', 'papers', 'attempts', 'study', 'reviews', 'learningResults']) assert.deepEqual(after[key], [], `${label}: ${key} must roll back`);
  }
  await call(target, '/api/import', 'POST', { mode: 'merge', data: backup }); assert.equal((await wrong(target, saved.id)).total, 1);
});

test('maximum-length parent and part IDs retain independent state and round-trip flattened leaf identities', async t => {
  const rootId = '父'.repeat(160), partA = '甲'.repeat(160), partB = '乙'.repeat(160);
  const q = group(rootId); q.parts![0]!.id = partA; q.parts![1]!.id = partB;
  const app = await fixture(t, [q]), saved = await paper(app, '长题号组合边界', [rootId]);
  const a = `${rootId}::${partA}`, b = `${rootId}::${partB}`;
  const submitted = await submit(app, saved, { [a]: { value: 'false' }, [b]: { value: 'true' } });
  await call(app, `/api/attempts/${submitted.id}/review`, 'PUT', { mastery: { [a]: 0, [b]: 3 } });
  const record = (await wrong(app, saved.id)).items[0]; assert.equal(record.question.id, a); assert.equal(record.study.partId, partA);
  const data = await call(app, '/api/export'); assert.equal(data.studyParts.length, 2);
  const copy = await fixture(t); await call(copy, '/api/import', 'POST', { mode: 'merge', data });
  assert.equal((await wrong(copy, saved.id)).items[0].question.id, a);
  assert.deepEqual((await call(copy, '/api/study')).partItems.map((state: any) => [state.partId, state.mastery]).sort(), [[partA, 0], [partB, 3]].sort());
});

test('persistent grouped wrong snapshots alone protect assets and remain readable after source deletion and migration', async t => {
  const app = await fixture(t), asset = await call(app, '/api/assets', 'POST', { filename: 'retained.png', mimeType: 'image/png', dataBase64: png }, 201);
  const q = { ...group('asset-group'), stemMarkdown: `原有公共图示 ![材料](${assetUrl(asset.id)})` }, other = question('asset-other');
  await call(app, '/api/import', 'POST', { mode: 'merge', data: envelope([q, other]) });
  let saved = await paper(app, '将删除的图片来源', [q.id]);
  const old = await submit(app, saved, { [`${q.id}::a`]: { value: 'false' }, [`${q.id}::b`]: { value: 'true' } });
  saved = await replacePaper(app, saved, [other.id]); await submit(app, saved, { [other.id]: { value: 'true' } }); await prune(app);
  await call(app, `/api/questions/${q.id}`, 'DELETE'); await call(app, `/api/papers/${saved.id}?permanent=true`, 'DELETE');
  await call(app, `/api/attempts/${old.id}`, 'GET', undefined, 404);
  const backup = await call(app, '/api/export');
  assert.ok(!backup.questions.some((entry: any) => entry.id === q.id)); assert.ok(!backup.papers.some((entry: any) => entry.id === saved.id));
  assert.ok(!JSON.stringify(backup.attempts).includes(asset.id)); assert.ok(JSON.stringify(backup.learningResults).includes(asset.id));
  assert.equal((await call(app, '/api/assets'))[0].referenced, true); await call(app, `/api/assets/${asset.id}`, 'DELETE', undefined, 409);
  const kept = (await wrong(app, saved.id)).items[0];
  assert.equal(kept.question.groupStemMarkdown, q.stemMarkdown); assert.equal(kept.question.answerMarkdown, '甲答案'); assert.equal(kept.question.explanationMarkdown, '甲解析'); assert.deepEqual(kept.question.correctAnswers, ['true']); assert.equal(kept.historyAvailable, false);
  const origins = (await call(app, '/api/learning/global/questions?kind=wrong')).items[0].origins;
  assert.equal(origins[0].deleted, true); assert.equal(origins[0].paperTitle, '将删除的图片来源'); assert.equal(origins[0].historyAvailable, false);
  assert.ok((await call(app, '/api/learning/contexts')).items.some((context: any) => context.paperId === saved.id));
  const copy = await fixture(t); await call(copy, '/api/import', 'POST', { mode: 'merge', data: backup });
  assert.equal((await wrong(copy, saved.id)).items[0].question.groupStemMarkdown, q.stemMarkdown); await call(copy, `/api/assets/${asset.id}`, 'DELETE', undefined, 409);
  const preview = await call(copy, '/api/learning/reset-preview'); await call(copy, '/api/learning/reset', 'POST', { confirmed: true, fingerprint: preview.fingerprint });
  await call(copy, `/api/assets/${asset.id}`, 'DELETE');
  assert.equal((await call(copy, '/api/assets')).length, 0, 'explicitly resetting the last learning evidence releases its otherwise unused asset');
});
