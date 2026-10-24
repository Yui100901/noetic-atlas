import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import Fastify from 'fastify';
import { buildApp } from '../../server/index.js';
import { Store } from '../../server/core/store.js';
import { ApiError, parse, questionSchema } from '../../server/core/validation.js';
import { buildPaper, createAttempt, reviewAttempt, saveAttempt, submitAttempt, type StoredAttempt } from '../../server/modules/practice/service.js';
import { registerQuestionHistoryRoutes } from '../../server/modules/questions/history.js';
import { archiveAttemptQuestionHistory } from '../../server/modules/questions/history-store.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';
import type { Question } from '../../shared/models/types.js';

type App = Awaited<ReturnType<typeof buildApp>>;
type Answers = Record<string, { value: string | string[] }>;
const stamp = '2026-01-01T00:00:00.000Z';
const question = (id: string, type: Question['type'] = 'true_false', extra: Record<string, unknown> = {}): Question => ({
  ...parse(questionSchema, { id, title: id, type, stemMarkdown: `原始题干 ${id}`, answerMarkdown: `原始答案 ${id}`, explanationMarkdown: `原始解析 ${id}`, status: 'published', ...(type === 'true_false' ? { correctAnswers: ['true'] } : {}), ...extra }),
  id, createdAt: stamp, updatedAt: stamp,
});
const group = (id: string): Question => question(id, 'group', { stemMarkdown: '固定公共材料', parts: [
  { id: 'a', title: '甲', type: 'true_false', stemMarkdown: '甲的判断', correctAnswers: ['true'], answerMarkdown: '甲答案' },
  { id: 'b', title: '乙', type: 'short_answer', stemMarkdown: '乙的说明', answerMarkdown: '乙答案' },
] });
const envelope = (questions: Question[]) => ({ schemaVersion: 1, domains: [], categories: [], tags: [], questions, documents: [], papers: [] });
async function call(app: App, url: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', payload?: unknown, status = 200): Promise<any> {
  const response = await app.inject({ url, method, ...(payload === undefined ? {} : { payload }) });
  assert.equal(response.statusCode, status, response.body); return response.json();
}
async function fixture(t: test.TestContext, questions: Question[] = []) {
  const app = await buildApp({ databasePath: ':memory:', seedPath: 'missing-question-history-seed', staticRoot: 'missing-question-history-web' });
  t.after(() => app.close());
  if (questions.length) await call(app, '/api/import', 'POST', { mode: 'merge', data: envelope(questions) });
  return app;
}
const history = (app: App, id: string, query = '') => call(app, `/api/questions/${encodeURIComponent(id)}/history${query ? `?${query}` : ''}`);
async function paper(app: App, ids: string[], scored = false) {
  return call(app, '/api/papers', 'POST', { title: `单题历史来源 ${ids.join('、')}`, mode: 'manual', questionIds: ids, scoring: { enabled: scored } }, 201);
}
async function submit(app: App, saved: any, answers: Answers) {
  const draft = await call(app, `/api/papers/${saved.id}/attempts`, 'POST', undefined, 201);
  return call(app, `/api/attempts/${draft.id}/submit`, 'POST', { answers });
}
async function settings(app: App, changes: Record<string, number>) {
  const value = { ...await call(app, '/api/settings'), ...changes };
  const response = await app.inject({ url: '/api/settings', method: 'PUT', payload: { settings: value } });
  if (response.statusCode === 200) return response.json();
  assert.equal(response.statusCode, 409, response.body);
  const preview = response.json(); assert.equal(preview.error.code, 'RETENTION_CONFIRMATION_REQUIRED');
  return call(app, '/api/settings', 'PUT', { settings: value, confirmedRetention: true, expectedRetention: preview.error.details });
}
function counts(value: any) {
  return Object.fromEntries(['answered', 'correct', 'partial', 'incorrect', 'ungraded'].map(key => [key, value.summary[key]]));
}

test('detail-only history skips cumulative statistics while preserving answers and pagination', async t => {
  const q = question('history-detail-only'), store = new Store(':memory:'); t.after(() => store.db.close());
  store.put('questions', q.id, q);
  const saved = buildPaper(store, { title: '只读取作答详情', description: '', mode: 'manual', questionIds: [q.id], scoring: { enabled: false } });
  store.put('papers', saved.id, saved);
  const attempt = createAttempt(store, saved); submitAttempt(store, attempt, { [q.id]: { value: 'true' } });
  const app = Fastify(); registerQuestionHistoryRoutes(app, store); t.after(() => app.close());
  const normal = await call(app as App, `/api/questions/${q.id}/history`);
  const db = store.database, all = db.all.bind(db), observed: string[] = [];
  db.all = ((query: any) => { observed.push(query.compile().sql); return all(query); }) as typeof db.all;
  const details = await call(app as App, `/api/questions/${q.id}/history?summary=false&page=1&pageSize=10`);
  const { summary: _summary, ...expected } = normal;
  assert.deepEqual(details, expected);
  assert.ok(!observed.some(query => query.includes('from "learning_results"')), 'detail pagination must not calculate cumulative statistics again');
  assert.equal((await app.inject(`/api/questions/${q.id}/history?summary=other`)).statusCode, 400);
});

test('single-question statistics count only nonblank submitted answers, excluding drafts and omissions', async t => {
  const bool = question('history-presence-bool'), essay = question('history-presence-essay', 'essay');
  const multi = question('history-presence-multi', 'multiple_choice', { options: [{ key: 'A', text: '甲' }, { key: 'B', text: '乙' }], correctAnswers: ['A', 'B'] });
  const fill = question('history-presence-fill', 'fill_blank', { stemMarkdown: '{{one}} / {{two}}', blanks: [{ id: 'one', label: '第一空', answers: ['甲'] }, { id: 'two', label: '第二空', answers: ['乙'] }] });
  const app = await fixture(t, [bool, essay, multi, fill]), saved = await paper(app, [bool.id, essay.id, multi.id, fill.id]);
  const draft = await call(app, `/api/papers/${saved.id}/attempts`, 'POST', undefined, 201);
  await call(app, `/api/attempts/${draft.id}`, 'PUT', { answers: { [bool.id]: { value: 'true' } } });
  assert.equal((await history(app, bool.id)).summary.answered, 0);
  await submit(app, saved, { [essay.id]: { value: ' \n\t ' }, [multi.id]: { value: [] }, [fill.id]: { value: [' ', '\t'] } });
  for (const q of [bool, essay, multi, fill]) { const empty = await history(app, q.id); assert.equal(empty.summary.answered, 0); assert.equal(empty.total, 0); }
  await submit(app, saved, { [bool.id]: { value: 'false' }, [essay.id]: { value: '实际回答' }, [multi.id]: { value: ['A'] }, [fill.id]: { value: ['甲', ''] } });
  assert.deepEqual(counts(await history(app, bool.id)), { answered: 1, correct: 0, partial: 0, incorrect: 1, ungraded: 0 });
  assert.deepEqual(counts(await history(app, essay.id)), { answered: 1, correct: 0, partial: 0, incorrect: 0, ungraded: 1 });
  for (const q of [multi, fill]) assert.equal((await history(app, q.id)).summary.answered, 1, 'any actual content counts once even when the answer is incomplete');
  const backup = await call(app, '/api/export');
  const blank = backup.learningResults.find((result: any) => result.items.every((item: any) => item.answered === false));
  assert.ok(blank, 'answered=false is persisted for omissions rather than inferred from correctness');
});

test('default ten-entry detail retention is independent of unlimited whole-attempt history and cumulative statistics', async t => {
  const q = question('history-default-ten', 'short_answer'), app = await fixture(t, [q]), saved = await paper(app, [q.id]);
  const config = await call(app, '/api/settings'); assert.equal(config.maxQuestionHistory, 10); assert.equal(config.maxHistoryPerPaper, 0); assert.equal(config.maxQuickHistory, 0);
  const attempts = [];
  for (let index = 0; index < 12; index++) attempts.push(await submit(app, saved, { [q.id]: { value: `PRIVATE_ANSWER_${index}` } }));
  const result = await history(app, q.id, 'pageSize=10');
  assert.deepEqual(counts(result), { answered: 12, correct: 0, partial: 0, incorrect: 0, ungraded: 12 });
  assert.equal(result.retention.limit, 10); assert.equal(result.retention.available, 10); assert.equal(result.total, 10); assert.equal(result.items.length, 10);
  assert.deepEqual(result.items.map((item: any) => item.attemptId), attempts.slice(-10).reverse().map(a => a.id));
  assert.equal((await history(app, q.id, 'page=2&pageSize=10')).items.length, 0);
  await call(app, `/api/attempts/${attempts[0].id}`);
  const backup = await call(app, '/api/export');
  assert.equal(backup.attempts.length, 12); assert.equal(backup.questionHistory.length, 10);
  assert.ok(!JSON.stringify(backup.questionHistory).includes('PRIVATE_ANSWER_'), 'retained attempts provide answer bodies without copying them to the single-question index');
});

test('whole-attempt pruning archives needed frozen detail, then question pruning removes only independent detail', async t => {
  const q = question('history-two-retentions', 'short_answer'), app = await fixture(t, [q]), saved = await paper(app, [q.id]);
  await settings(app, { maxQuestionHistory: 2 });
  const old = await submit(app, saved, { [q.id]: { value: '清理前的原始回答' } });
  const recent = await submit(app, saved, { [q.id]: { value: '较新的回答' } });
  const current = await call(app, `/api/questions/${q.id}`);
  await call(app, `/api/questions/${q.id}`, 'PUT', { ...current, study: undefined, stemMarkdown: '后来改过的题干', answerMarkdown: '后来改过的参考答案' });
  await settings(app, { maxHistoryPerPaper: 1 });
  await call(app, `/api/attempts/${old.id}`, 'GET', undefined, 404);
  const archived = (await history(app, q.id)).items.find((item: any) => item.attemptId === old.id);
  assert.equal(archived.historyAvailable, false); assert.equal(archived.question.stemMarkdown, q.stemMarkdown); assert.equal(archived.question.answerMarkdown, q.answerMarkdown); assert.equal(archived.answer.value, '清理前的原始回答');
  assert.equal((await history(app, q.id)).items.find((item: any) => item.attemptId === recent.id).historyAvailable, true);
  const pruned = await settings(app, { maxQuestionHistory: 1 }); assert.equal(pruned.retention.questionHistory, 1);
  const kept = await history(app, q.id); assert.equal(kept.total, 1); assert.equal(kept.items[0].attemptId, recent.id); assert.equal(kept.summary.answered, 2);
  const backup = await call(app, '/api/export'); assert.ok(!JSON.stringify(backup.questionHistory).includes('清理前的原始回答'));
  await call(app, `/api/attempts/${recent.id}`);
  await settings(app, { maxQuestionHistory: 0 });
  const disabled = await history(app, q.id); assert.equal(disabled.total, 0); assert.equal(disabled.summary.answered, 2); assert.equal(disabled.retention.limit, 0);
  await call(app, `/api/attempts/${recent.id}`);
});

test('question-detail pruning leaves old whole attempts reviewable and limits each grouped part separately', async t => {
  const q = group('history-independent-parts'), app = await fixture(t, [q]), saved = await paper(app, [q.id]);
  await settings(app, { maxQuestionHistory: 1 });
  const first = await submit(app, saved, { [`${q.id}::a`]: { value: 'true' }, [`${q.id}::b`]: { value: '只答一次乙' } });
  const second = await submit(app, saved, { [`${q.id}::a`]: { value: 'false' } });
  const a = await history(app, q.id, 'partId=a'), b = await history(app, q.id, 'partId=b');
  assert.deepEqual(counts(a), { answered: 2, correct: 1, partial: 0, incorrect: 1, ungraded: 0 });
  assert.deepEqual(counts(b), { answered: 1, correct: 0, partial: 0, incorrect: 0, ungraded: 1 });
  assert.equal(a.items[0].attemptId, second.id); assert.equal(b.items[0].attemptId, first.id); assert.equal(b.items[0].question.groupStemMarkdown, '固定公共材料');
  const original = await call(app, `/api/attempts/${first.id}`); assert.equal(original.answers[`${q.id}::a`].value, 'true');
});

test('regrading updates four-way results in place and an unscored verdict does not invent a numeric score', async t => {
  const q = question('history-review-once', 'short_answer'), app = await fixture(t, [q]), saved = await paper(app, [q.id], true);
  const graded = await submit(app, saved, { [q.id]: { value: '待评分回答' } });
  await call(app, `/api/attempts/${graded.id}/review`, 'PUT', { scores: { [q.id]: 1 } });
  assert.deepEqual(counts(await history(app, q.id)), { answered: 1, correct: 0, partial: 1, incorrect: 0, ungraded: 0 });
  for (const score of [3, 3]) await call(app, `/api/attempts/${graded.id}/review`, 'PUT', { scores: { [q.id]: score } });
  assert.deepEqual(counts(await history(app, q.id)), { answered: 1, correct: 1, partial: 0, incorrect: 0, ungraded: 0 });
  await call(app, `/api/attempts/${graded.id}/review`, 'PUT', { scores: { [q.id]: 0 } });
  assert.equal((await history(app, q.id)).summary.incorrect, 1);
  await call(app, `/api/attempts/${graded.id}/review`, 'PUT', { scores: { [q.id]: null } });
  assert.equal((await history(app, q.id)).summary.ungraded, 1);
  const quick = await call(app, '/api/quick-practice', 'POST', { questionId: q.id }, 201);
  await call(app, `/api/attempts/${quick.id}/submit`, 'POST', { answers: { [q.id]: { value: '无分练习回答' } } });
  for (const verdict of ['partial', 'partial']) await call(app, `/api/attempts/${quick.id}/review`, 'PUT', { verdicts: { [q.id]: verdict } });
  const reviewed = await call(app, `/api/attempts/${quick.id}`); assert.equal(reviewed.totalScore, null); assert.equal(reviewed.answers[q.id].selfScore, undefined);
  assert.deepEqual(counts(await history(app, q.id)), { answered: 2, correct: 0, partial: 1, incorrect: 0, ungraded: 1 });
  await call(app, `/api/attempts/${quick.id}/review`, 'PUT', { verdicts: { [q.id]: null } });
  assert.equal((await history(app, q.id)).summary.ungraded, 2);
});

test('same question aggregates submissions across sources while drafts and repeated grading never add answers', async t => {
  const q = question('history-cross-source'), app = await fixture(t, [q]), a = await paper(app, [q.id]), b = await paper(app, [q.id]);
  await submit(app, a, { [q.id]: { value: 'true' } }); await submit(app, b, { [q.id]: { value: 'false' } });
  const quick = await call(app, '/api/quick-practice', 'POST', { questionId: q.id }, 201);
  await call(app, `/api/attempts/${quick.id}/submit`, 'POST', { answers: { [q.id]: { value: 'true' } } });
  const result = await history(app, q.id); assert.deepEqual(counts(result), { answered: 3, correct: 2, partial: 0, incorrect: 1, ungraded: 0 });
  assert.deepEqual(new Set(result.items.map((item: any) => `${item.source}:${item.paperId}`)), new Set([`paper:${a.id}`, `paper:${b.id}`, 'quick:quick-practice']));
});

test('JSON migration preserves archives, retained references, resets and independent detail counts', async t => {
  const q = question('history-migration', 'short_answer'), app = await fixture(t, [q]), saved = await paper(app, [q.id]);
  await settings(app, { maxHistoryPerPaper: 1, maxQuestionHistory: 2 });
  await submit(app, saved, { [q.id]: { value: '迁移的归档答案' } }); await submit(app, saved, { [q.id]: { value: '迁移的整卷答案' } });
  const backup = await call(app, '/api/export'), copy = await fixture(t);
  await call(copy, '/api/import', 'POST', { mode: 'merge', data: backup });
  assert.deepEqual(await history(copy, q.id), await history(app, q.id));
  const preview = await call(copy, '/api/learning/reset-preview');
  await call(copy, '/api/learning/reset', 'POST', { confirmed: true, fingerprint: preview.fingerprint });
  const reset = await history(copy, q.id); assert.equal(reset.summary.answered, 0); assert.equal(reset.total, 2); assert.ok(reset.items.every((item: any) => item.beforeReset));
  const again = await fixture(t); await call(again, '/api/import', 'POST', { mode: 'merge', data: await call(copy, '/api/export') });
  const after = await history(again, q.id); assert.equal(after.summary.answered, 0); assert.equal(after.total, 2); assert.ok(after.items.every((item: any) => item.beforeReset));
});

test('legacy retained answers can establish presence but already-pruned subjective answers remain explicitly unknown', async t => {
  const q = question('history-legacy-presence', 'short_answer'), app = await fixture(t, [q]), saved = await paper(app, [q.id], true);
  const attempt = await submit(app, saved, { [q.id]: { value: '旧版本保存的实际回答' } });
  await call(app, `/api/attempts/${attempt.id}/review`, 'PUT', { scores: { [q.id]: 1 } });
  const backup = await call(app, '/api/export'); delete backup.questionHistory;
  for (const result of backup.learningResults) { delete result.historyIndexed; for (const item of result.items) { delete item.answered; item.judgment = 'incorrect'; } }
  delete backup.attempts[0].answers[q.id].verdict;
  const retained = await fixture(t); await call(retained, '/api/import', 'POST', { mode: 'merge', data: backup });
  const recovered = await history(retained, q.id); assert.equal(recovered.summary.answered, 1); assert.equal(recovered.summary.partial, 1); assert.equal(recovered.summary.incorrect, 0); assert.equal(recovered.items[0].verdict, 'partial'); assert.equal(recovered.total, 1, 'a genuinely old backup backfills detail from its retained actual answer');
  const pruned = structuredClone(backup); pruned.attempts = [];
  const unknown = await fixture(t); await call(unknown, '/api/import', 'POST', { mode: 'merge', data: pruned });
  const result = await history(unknown, q.id); assert.equal(result.summary.answered, 0); assert.equal(result.summary.unknown, 1); assert.equal(result.total, 0);
});

test('starting an old SQLite database upgrades retained intermediate scores without reviving reset or trimmed detail', async t => {
  const parent = resolve('test-results'); await mkdir(parent, { recursive: true });
  const folder = await mkdtemp(resolve(parent, 'history-upgrade-')), databasePath = resolve(folder, 'old.sqlite');
  let app: App | undefined;
  t.after(async () => { await app?.close(); assert.equal(dirname(resolve(folder)), parent); await rm(folder, { recursive: true, force: true }); });
  const store = new Store(databasePath);
  try {
    for (const kind of ['partial', 'reset', 'trimmed', 'blank'] as const) {
      const q = question(`history-startup-${kind}`, 'short_answer'); store.put('questions', q.id, q);
      const saved = buildPaper(store, { id: `history-startup-source-${kind}`, title: kind, description: '', mode: 'manual', questionIds: [q.id], scoring: { enabled: true } }); store.put('papers', saved.id, saved);
      const attempt = submitAttempt(store, createAttempt(store, saved), { [q.id]: { value: kind === 'blank' ? ' \t ' : '升级前已评分的实际回答' } }); reviewAttempt(store, attempt, { [q.id]: 1 });
      delete attempt.answers[q.id]!.verdict; store.put('attempts', attempt.id, attempt);
      let result = store.require<any>('learning_results', attempt.id);
      if (kind === 'reset') result = { ...result, reset: true, items: [], questions: [] };
      else result.items = result.items.map((item: any) => { const { answered: _answered, ...old } = item; return { ...old, judgment: 'incorrect' }; });
      if (kind !== 'trimmed') delete result.historyIndexed;
      store.put('learning_results', attempt.id, result);
    }
    store.database.run(store.database.query.deleteFrom('metadata').where('key', '=', 'question_history_version'));
    store.database.maintenance.exec('DROP TABLE question_history');
  } finally { store.db.close(); }
  app = await buildApp({ databasePath, seedPath: 'missing-history-upgrade-seed', staticRoot: 'missing-history-upgrade-web' });
  const partial = await history(app, 'history-startup-partial'); assert.deepEqual(counts(partial), { answered: 1, correct: 0, partial: 1, incorrect: 0, ungraded: 0 }); assert.equal(partial.items[0].verdict, 'partial');
  const reset = await history(app, 'history-startup-reset'); assert.equal(reset.summary.answered, 0); assert.equal(reset.total, 1); assert.equal(reset.items[0].beforeReset, true);
  const trimmed = await history(app, 'history-startup-trimmed'); assert.equal(trimmed.summary.partial, 1); assert.equal(trimmed.total, 0, 'upgrading a judgment must not recreate a previously removed detail reference');
  const blank = await history(app, 'history-startup-blank'); assert.equal(blank.summary.answered, 0); assert.equal(blank.total, 0);
  const upgraded = await call(app, '/api/export'); assert.ok(upgraded.learningResults.filter((result: any) => !result.reset && result.items[0].answered).every((result: any) => result.items[0].judgment === 'partial'));
  await app.close(); app = await buildApp({ databasePath, seedPath: 'missing-history-upgrade-seed', staticRoot: 'missing-history-upgrade-web' });
  assert.deepEqual(await history(app, 'history-startup-partial'), partial); assert.equal((await history(app, 'history-startup-trimmed')).total, 0);
});

test('migration rejects orphaned or forged question-history references before writing any content', async t => {
  const q = question('history-import-integrity', 'short_answer'), app = await fixture(t, [q]), saved = await paper(app, [q.id]);
  await submit(app, saved, { [q.id]: { value: '引用的实际回答' } });
  const data = await call(app, '/api/export'); assert.equal(data.questionHistory.length, 1);
  const invalid = [
    (copy: any) => { copy.attempts = []; },
    (copy: any) => { copy.questionHistory[0].paperTitle = '伪造的来源名称'; },
    (copy: any) => { copy.questionHistory[0].submittedAt = '2020-01-01T00:00:00.000Z'; },
  ];
  for (const mutate of invalid) {
    const corrupt = structuredClone(data); mutate(corrupt);
    const empty = await fixture(t); await call(empty, '/api/import', 'POST', { mode: 'merge', data: corrupt }, 400);
    await call(empty, `/api/questions/${q.id}`, 'GET', undefined, 404);
    const exported = await call(empty, '/api/export'); assert.equal(exported.attempts.length, 0); assert.equal(exported.questionHistory.length, 0);
  }
});

test('raising the detail limit and migrating a current backup never resurrects previously trimmed references', async t => {
  const q = question('history-no-detail-resurrection', 'short_answer'), app = await fixture(t, [q]), saved = await paper(app, [q.id]);
  await settings(app, { maxQuestionHistory: 1 });
  const old = await submit(app, saved, { [q.id]: { value: '曾经超限的回答' } });
  const recent = await submit(app, saved, { [q.id]: { value: '仍在保留范围的回答' } });
  await settings(app, { maxQuestionHistory: 10 });
  assert.equal((await history(app, q.id)).total, 1);
  const copy = await fixture(t); await call(copy, '/api/import', 'POST', { mode: 'merge', data: await call(app, '/api/export') });
  const result = await history(copy, q.id); assert.equal(result.summary.answered, 2); assert.equal(result.total, 1); assert.equal(result.items[0].attemptId, recent.id);
  await call(copy, `/api/attempts/${old.id}`);
});

test('merging an older backup preserves newer same-ID local grades, history and cumulative results', async t => {
  const q = question('history-merge-local-grade', 'short_answer'), app = await fixture(t, [q]), saved = await paper(app, [q.id], true);
  const attempt = await submit(app, saved, { [q.id]: { value: '备份前的原始作答' } }), backup = await call(app, '/api/export');
  await call(app, `/api/attempts/${attempt.id}/review`, 'PUT', { scores: { [q.id]: 1 } });
  const merged = await call(app, '/api/import', 'POST', { mode: 'merge', data: backup });
  assert.equal(merged.counts.questionHistory.skipped, 1);
  const result = await history(app, q.id); assert.deepEqual(counts(result), { answered: 1, correct: 0, partial: 1, incorrect: 0, ungraded: 0 });
  assert.equal(result.items[0].verdict, 'partial'); assert.equal(result.items[0].answer.selfScore, 1); assert.equal((await call(app, `/api/attempts/${attempt.id}`)).answers[q.id].selfScore, 1);
  const malformed = structuredClone(backup); malformed.questionHistory[0].verdict = 'unknown';
  await call(app, '/api/import', 'POST', { mode: 'merge', data: malformed }, 400);
  assert.equal((await history(app, q.id)).items[0].verdict, 'partial', 'same-ID skipping cannot bypass the strict input schema');
});

for (const action of ['review', 'whole-attempt cleanup']) test(`previously trimmed detail never reappears during ${action} after raising the limit`, async t => {
  const q = question(`history-no-resurrection-${action === 'review' ? 'review' : 'cleanup'}`, 'short_answer'), app = await fixture(t, [q]), saved = await paper(app, [q.id], true);
  await settings(app, { maxQuestionHistory: 1 });
  const old = await submit(app, saved, { [q.id]: { value: '已从单题详情移除的回答' } });
  const recent = await submit(app, saved, { [q.id]: { value: '仍在单题详情中的回答' } });
  await settings(app, { maxQuestionHistory: 10 });
  if (action === 'review') await call(app, `/api/attempts/${old.id}/review`, 'PUT', { scores: { [q.id]: 1 } });
  else await settings(app, { maxHistoryPerPaper: 1 });
  const result = await history(app, q.id); assert.equal(result.summary.answered, 2); assert.equal(result.total, 1); assert.equal(result.items[0].attemptId, recent.id);
  if (action === 'review') assert.equal(result.summary.partial, 1, 'regrading changes cumulative judgment while the expired detail stays absent');
});

test('answers submitted while independent detail is disabled stay absent after re-enabling and regrading', async t => {
  const q = question('history-zero-disabled', 'short_answer'), app = await fixture(t, [q]), saved = await paper(app, [q.id], true);
  await settings(app, { maxQuestionHistory: 0 });
  const old = await submit(app, saved, { [q.id]: { value: '关闭独立详情期间作答' } });
  assert.equal((await history(app, q.id)).total, 0);
  await settings(app, { maxQuestionHistory: 10 });
  await call(app, `/api/attempts/${old.id}/review`, 'PUT', { scores: { [q.id]: 1 } });
  const result = await history(app, q.id); assert.equal(result.total, 0); assert.equal(result.summary.answered, 1); assert.equal(result.summary.partial, 1);
  const recent = await submit(app, saved, { [q.id]: { value: '重新启用后作答' } });
  const enabled = await history(app, q.id); assert.equal(enabled.total, 1); assert.equal(enabled.items[0].attemptId, recent.id); assert.equal(enabled.summary.answered, 2);
});

test('regrading reset-era attempts preserves old detail markers without reviving statistics or trimmed detail', async t => {
  const q = question('history-reset-regrading', 'short_answer'), app = await fixture(t, [q]), saved = await paper(app, [q.id], true);
  await settings(app, { maxQuestionHistory: 1 });
  const old = await submit(app, saved, { [q.id]: { value: '重置前已裁剪的详情' } });
  const kept = await submit(app, saved, { [q.id]: { value: '重置前仍保留的详情' } });
  const preview = await call(app, '/api/learning/reset-preview'); await call(app, '/api/learning/reset', 'POST', { confirmed: true, fingerprint: preview.fingerprint });
  await settings(app, { maxQuestionHistory: 10 });
  for (const attempt of [old, kept]) await call(app, `/api/attempts/${attempt.id}/review`, 'PUT', { scores: { [q.id]: 1 } });
  const reset = await history(app, q.id); assert.equal(reset.summary.answered, 0); assert.equal(reset.total, 1); assert.equal(reset.items[0].attemptId, kept.id); assert.equal(reset.items[0].beforeReset, true); assert.equal(reset.items[0].verdict, 'partial');
  const recent = await submit(app, saved, { [q.id]: { value: '重置后的新回答' } });
  const restarted = await history(app, q.id); assert.equal(restarted.summary.answered, 1); assert.equal(restarted.total, 2); assert.equal(restarted.items.find((item: any) => item.attemptId === recent.id).beforeReset, undefined);
});

test('statistics and paged detail GETs hydrate no private off-leaf answers or off-page bodies and never write', async t => {
  const store = new Store(':memory:'), app = Fastify();
  app.setErrorHandler((error, _request, reply) => error instanceof ApiError ? reply.code(error.status).send({ error: { code: error.code, message: error.message } }) : reply.code(500).send({ error: String(error) }));
  registerQuestionHistoryRoutes(app, store); t.after(async () => { await app.close(); store.db.close(); });
  store.put('settings', 'system', { ...DEFAULT_SETTINGS, maxQuestionHistory: 30 });
  const focus = question('history-reader-focus', 'short_answer'), other = question('history-reader-unrelated', 'essay', { stemMarkdown: 'UNSELECTED_LEAF_BODY_CANARY' });
  store.put('questions', focus.id, focus); store.put('questions', other.id, other);
  const attempts: StoredAttempt[] = [];
  for (let index = 0; index < 25; index++) {
    const saved = buildPaper(store, { id: `history-reader-source-${index}`, title: '只读正文边界', description: '', mode: 'manual', questionIds: [focus.id, other.id], scoring: { enabled: false } });
    saved.snapshot[0] = { ...focus, stemMarkdown: index === 0 || index === 24 ? 'OFF_PAGE_FOCUS_BODY_CANARY' : `第${index}次题干` };
    store.put('papers', saved.id, saved);
    const draft = createAttempt(store, saved); draft.startedAt = draft.updatedAt = new Date(Date.UTC(2100, 0, 1, 0, 0, index)).toISOString(); store.put('attempts', draft.id, draft);
    attempts.push(submitAttempt(store, draft, { [focus.id]: { value: `FOCUS_ANSWER_${index}` }, [other.id]: { value: `PRIVATE_OFF_LEAF_ANSWER_CANARY_${index}` } }));
  }
  const db = store.database, all = db.all.bind(db), one = db.one.bind(db), observed: unknown[] = [];
  db.all = ((query: any) => { const rows = all(query); observed.push(...rows); return rows; }) as typeof db.all;
  db.one = ((query: any) => { const row = one(query); if (row) observed.push(row); return row; }) as typeof db.one;
  const get = async (path: string) => { const response = await app.inject(path); assert.equal(response.statusCode, 200, response.body); return response.json(); };
  const changes = () => Number((store.db.prepare('SELECT total_changes() AS count').get() as any).count);
  for (const phase of ['retained', 'archived']) {
    if (phase === 'archived') for (const attempt of attempts) { archiveAttemptQuestionHistory(store, attempt); store.remove('attempts', attempt.id); }
    const before = changes(); observed.length = 0;
    const statistics = await get(`/api/questions/${focus.id}/statistics`); assert.equal(statistics.answered, 25);
    const summaryRead = JSON.stringify(observed);
    assert.ok(!summaryRead.includes('FOCUS_ANSWER_') && !summaryRead.includes('CANARY'), `${phase}: statistics must select compact flags, not any question or answer body`);
    observed.length = 0;
    const page = await get(`/api/questions/${focus.id}/history?page=2&pageSize=10`); assert.equal(page.total, 25); assert.equal(page.items.length, 10);
    const pageRead = JSON.stringify(observed);
    assert.ok(pageRead.includes('FOCUS_ANSWER_14'), 'the instrumentation observes selected-page answer hydration');
    assert.ok(!pageRead.includes('PRIVATE_OFF_LEAF_ANSWER_CANARY') && !pageRead.includes('UNSELECTED_LEAF_BODY_CANARY') && !pageRead.includes('OFF_PAGE_FOCUS_BODY_CANARY'), `${phase}: SQLite must filter other leaves and pages before returning content`);
    assert.equal(changes(), before, `${phase}: reading dirty projections must not migrate evidence, clean history or persist a cache`);
  }
});

test('creating, saving and submitting a draft never hydrate unrelated answers or surviving history', t => {
  const store = new Store(':memory:'); t.after(() => store.db.close());
  store.put('settings', 'system', { ...DEFAULT_SETTINGS, maxDraftsPerPaper: 3, maxHistoryPerPaper: 0 });
  const focus = question('history-write-focus', 'short_answer'), other = question('history-write-other', 'short_answer');
  for (const q of [focus, other]) store.put('questions', q.id, q);
  const makePaper = (id: string, q: Question) => { const saved = buildPaper(store, { id, title: id, description: '', mode: 'manual', questionIds: [q.id], scoring: { enabled: false } }); store.put('papers', saved.id, saved); return saved; };
  const focusPaper = makePaper('history-write-focus-paper', focus), otherPaper = makePaper('history-write-other-paper', other);
  submitAttempt(store, createAttempt(store, otherPaper), { [other.id]: { value: `PRIVATE_OTHER_PAPER_ANSWER_CANARY_${'x'.repeat(5000)}` } });
  const survivingDraft = saveAttempt(store, createAttempt(store, focusPaper), { [focus.id]: { value: 'PRIVATE_SURVIVING_DRAFT_CANARY' } });
  const older = submitAttempt(store, createAttempt(store, focusPaper), { [focus.id]: { value: 'PRIVATE_SURVIVING_HISTORY_CANARY' } });
  const db = store.database, all = db.all.bind(db), one = db.one.bind(db), observed: unknown[] = [];
  db.all = ((query: any) => { const rows = all(query); observed.push(...rows); return rows; }) as typeof db.all;
  db.one = ((query: any) => { const row = one(query); if (row) observed.push(row); return row; }) as typeof db.one;
  const current = createAttempt(store, focusPaper);
  saveAttempt(store, current, { [focus.id]: { value: '当前草稿实际回答' } });
  submitAttempt(store, current);
  const unlimitedRead = JSON.stringify(observed);
  for (const canary of ['PRIVATE_OTHER_PAPER_ANSWER_CANARY', 'PRIVATE_SURVIVING_DRAFT_CANARY', 'PRIVATE_SURVIVING_HISTORY_CANARY']) assert.ok(!unlimitedRead.includes(canary), `unlimited history writes must read compact dates and retention metadata: ${canary}`);
  assert.ok(store.get('attempts', older.id));
  store.put('settings', 'system', { ...DEFAULT_SETTINGS, maxDraftsPerPaper: 3, maxHistoryPerPaper: 1 }); observed.length = 0;
  const bounded = createAttempt(store, focusPaper); submitAttempt(store, bounded, { [focus.id]: { value: '触发整卷裁剪的回答' } });
  const boundedRead = JSON.stringify(observed);
  assert.ok(!boundedRead.includes('PRIVATE_OTHER_PAPER_ANSWER_CANARY') && !boundedRead.includes('PRIVATE_SURVIVING_DRAFT_CANARY'), 'bounded history may hydrate its selected deletions but not unrelated papers or retained drafts');
  assert.equal(store.get('attempts', older.id), undefined); assert.equal(store.get('attempts', current.id), undefined); assert.ok(store.get('attempts', bounded.id)); assert.ok(store.get('attempts', survivingDraft.id));
});
