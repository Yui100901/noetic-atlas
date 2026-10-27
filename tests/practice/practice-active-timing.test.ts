import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../server/index.js';
import { Store, now } from '../../server/core/store.js';
import { parse, questionSchema } from '../../server/core/validation.js';
import { attemptElapsedSeconds } from '../../shared/practice/attempt-timing.js';
import { buildPaper, createAttempt, createQuickAttempt, attemptView, saveAttempt, submitAttempt, validateAttemptTiming } from '../../server/modules/practice/service.js';
import { updatePracticeTiming, practiceTimingInputSchema, initialPracticeTiming } from '../../server/modules/practice/practice-timing.js';
import { importData, exportData } from '../../server/modules/transfer/migration.js';

const start = Date.parse('2026-10-26T02:00:00.000Z');
function fixture(t: test.TestContext) {
  const store = new Store(':memory:'); t.after(() => store.db.close());
  store.put('questions', 'T', { ...parse(questionSchema, { id: 'T', title: '计时题', type: 'true_false', stemMarkdown: 'TCP提供可靠传输。', correctAnswers: ['true'], status: 'published' }), createdAt: now(), updatedAt: now() });
  const paper = buildPaper(store, { id: 'P', title: '累计计时', mode: 'manual', description: '', questionIds: ['T'], scoring: { enabled: false } }); store.put('papers', paper.id, paper);
  return { store, paper };
}
test('drafts are paused on creation, reads and answer saves never charge wall-clock gaps', t => {
  t.mock.timers.enable({ apis: ['Date'], now: start }); const { store, paper } = fixture(t);
  const attempt = createAttempt(store, paper), quick = createQuickAttempt(store, { questionId: 'T' });
  t.mock.timers.tick(2 * 86400000);
  assert.equal(attemptView(attempt).elapsedSeconds, 0); assert.equal(attemptView(quick).elapsedSeconds, 0);
  updatePracticeTiming(store, attempt, { action: 'resume', sessionId: 'a', expectedSessionId: null });
  updatePracticeTiming(store, attempt, { action: 'checkpoint', sessionId: 'a', elapsedMilliseconds: 3500 });
  t.mock.timers.tick(86400000); saveAttempt(store, attempt, { T: { value: 'true' } });
  assert.equal(attempt.elapsedSeconds, 3); assert.equal(attemptElapsedSeconds(attempt), 3);
  updatePracticeTiming(store, attempt, { action: 'pause', sessionId: 'a', elapsedMilliseconds: 3800 });
  t.mock.timers.tick(86400000); assert.equal(attemptView(attempt).elapsedSeconds, 3);
});
test('resume after long absence preserves fractional seconds and counts only a new active session', t => {
  const { store, paper } = fixture(t), attempt = createAttempt(store, paper);
  updatePracticeTiming(store, attempt, { action: 'resume', sessionId: 'a', expectedSessionId: null });
  updatePracticeTiming(store, attempt, { action: 'pause', sessionId: 'a', elapsedMilliseconds: 700 });
  updatePracticeTiming(store, attempt, { action: 'resume', sessionId: 'b', expectedSessionId: 'a' });
  updatePracticeTiming(store, attempt, { action: 'checkpoint', sessionId: 'b', elapsedMilliseconds: 300 });
  updatePracticeTiming(store, attempt, { action: 'pause', sessionId: 'b', elapsedMilliseconds: 500 });
  assert.equal(attempt.practiceTiming!.elapsedMilliseconds, 1200); assert.equal(attempt.elapsedSeconds, 1);
  submitAttempt(store, attempt, { T: { value: 'true' } }); assert.equal(attempt.elapsedSeconds, 1); validateAttemptTiming(attempt);
});
test('duplicate, out-of-order and stale timing requests cannot add time twice or stop a newer session', t => {
  const { store, paper } = fixture(t), attempt = createAttempt(store, paper);
  updatePracticeTiming(store, attempt, { action: 'resume', sessionId: 'a', expectedSessionId: null });
  updatePracticeTiming(store, attempt, { action: 'checkpoint', sessionId: 'a', elapsedMilliseconds: 3000 });
  updatePracticeTiming(store, attempt, { action: 'checkpoint', sessionId: 'a', elapsedMilliseconds: 1000 });
  updatePracticeTiming(store, attempt, { action: 'resume', sessionId: 'a', expectedSessionId: null });
  assert.equal(attempt.practiceTiming!.elapsedMilliseconds, 3000);
  updatePracticeTiming(store, attempt, { action: 'pause', sessionId: 'a', elapsedMilliseconds: 4000 });
  updatePracticeTiming(store, attempt, { action: 'checkpoint', sessionId: 'a', elapsedMilliseconds: 50000 });
  updatePracticeTiming(store, attempt, { action: 'pause', sessionId: 'a', elapsedMilliseconds: 90000 });
  assert.equal(attempt.practiceTiming!.elapsedMilliseconds, 4000);
  updatePracticeTiming(store, attempt, { action: 'resume', sessionId: 'b', expectedSessionId: 'a' });
  updatePracticeTiming(store, attempt, { action: 'pause', sessionId: 'a', elapsedMilliseconds: 100000 });
  assert.equal(attempt.practiceTiming!.running, true); assert.equal(attempt.practiceTiming!.sessionId, 'b');
  assert.throws(() => updatePracticeTiming(store, attempt, { action: 'resume', sessionId: 'old-page', expectedSessionId: 'a' }), /其他答题页面/);
  assert.equal(attempt.practiceTiming!.elapsedMilliseconds, 4000);
});
test('legacy draft elapsed value freezes and submitted history remains unchanged', t => {
  const { store, paper } = fixture(t), attempt = createAttempt(store, paper);
  delete attempt.practiceTiming; attempt.elapsedSeconds = 65; attempt.startedAt = '2020-01-01T00:00:00.000Z';
  assert.equal(attemptView(attempt).elapsedSeconds, 65);
  updatePracticeTiming(store, attempt, { action: 'resume', sessionId: 'new', expectedSessionId: null });
  updatePracticeTiming(store, attempt, { action: 'pause', sessionId: 'new', elapsedMilliseconds: 500 });
  assert.equal(attempt.practiceTiming!.elapsedMilliseconds, 65500); submitAttempt(store, attempt);
  const before = JSON.stringify(attempt); updatePracticeTiming(store, attempt, { action: 'resume', sessionId: 'ignored', expectedSessionId: 'new' }); assert.equal(JSON.stringify(attempt), before);
  const old = { ...attempt, practiceTiming: undefined, elapsedSeconds: 77 }; assert.equal(attemptElapsedSeconds(old), 77);
  assert.throws(() => initialPracticeTiming({ elapsedSeconds: Number.MAX_SAFE_INTEGER }), /超过可保存范围/);
});
test('portable JSON retains cumulative timing and validates invalid timing states atomically', t => {
  const { store, paper } = fixture(t), attempt = createAttempt(store, paper), destination = new Store(':memory:'); t.after(() => destination.db.close());
  updatePracticeTiming(store, attempt, { action: 'resume', sessionId: 'a', expectedSessionId: null });
  updatePracticeTiming(store, attempt, { action: 'pause', sessionId: 'a', elapsedMilliseconds: 1700 });
  const data = exportData(store); importData(destination, data);
  assert.deepEqual(destination.require<any>('attempts', attempt.id).practiceTiming, attempt.practiceTiming);
  const invalid = structuredClone(data) as any; invalid.attempts[0].practiceTiming.elapsedMilliseconds = 500;
  const empty = new Store(':memory:'); t.after(() => empty.db.close()); assert.throws(() => importData(empty, invalid), (error: any) => error.code === 'VALIDATION_ERROR' && /累计|计时|会话/.test(JSON.stringify(error.details))); assert.equal(empty.all('attempts').length, 0);
  assert.equal(practiceTimingInputSchema.safeParse({ action: 'resume', sessionId: 'a' }).success, false);
  for (const value of [-1, 0.5, Infinity, 31 * 86400000 + 1]) assert.equal(practiceTimingInputSchema.safeParse({ action: 'checkpoint', sessionId: 'a', elapsedMilliseconds: value }).success, false);
});
test('timing HTTP operations are explicit writes while draft reads stay frozen and exams reject pause', async t => {
  const app = await buildApp({ databasePath: ':memory:', dailyPushScheduler: false }); t.after(() => app.close());
  const api = async (method: any, url: string, payload?: any, expected = 200) => { const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) }); assert.equal(response.statusCode, expected, response.body); return response.json(); };
  const q = await api('POST', '/api/questions', { title: 'HTTP计时题', type: 'true_false', stemMarkdown: 'TCP可靠。', correctAnswers: ['true'] }, 201);
  await api('POST', '/api/questions/review', { ids: [q.id], action: 'approve', confirmed: true, expectedUpdatedAt: { [q.id]: q.updatedAt } });
  const p = await api('POST', '/api/papers', { title: 'HTTP计时题集', mode: 'manual', questionIds: [q.id], scoring: { enabled: false } }, 201);
  const a = await api('POST', `/api/papers/${p.id}/attempts`, {}, 201);
  await api('POST', `/api/attempts/${a.id}/timing`, { action: 'resume', sessionId: 'a' }, 400);
  await api('POST', `/api/attempts/${a.id}/timing`, { action: 'resume', sessionId: 'a', expectedSessionId: null });
  await api('POST', `/api/attempts/${a.id}/timing`, { action: 'pause', sessionId: 'a', elapsedMilliseconds: 2500 });
  assert.equal((await api('GET', `/api/attempts/${a.id}`)).elapsedSeconds, 2);
  assert.equal((await api('GET', `/api/papers/${p.id}/drafts`))[0].elapsedSeconds, 2);
  await api('POST', `/api/attempts/${a.id}/timing`, { action: 'resume', sessionId: 'b', expectedSessionId: null }, 409);
  await api('POST', `/api/papers/${p.id}/attempts`, { mode: 'exam', durationMinutes: 1 }, 201);
  await api('POST', `/api/attempts/${a.id}/timing`, { action: 'pause', sessionId: 'a', elapsedMilliseconds: 5000 }, 409);
});
