import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import initSqlJs from 'sql.js';
import { loadNativeRuntime } from '../helpers/native-runtime.js';
import type { SeedData } from '../../shared/models/types.js';

test('offline practice timer persists confirmed active duration without counting time outside the answer page', async t => {


  const { createLocalRuntime } = await loadNativeRuntime();
  const sql = await initSqlJs({ locateFile: () => resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const start = Date.parse('2026-10-26T04:00:00.000Z');
  const seed: SeedData = { schemaVersion: 1, generatedAt: new Date(start).toISOString(), domains: [], categories: [], tags: [], documents: [], papers: [], questions: [{ id: 'ACTIVE-Q', title: '普通练习计时题', type: 'true_false', stemMarkdown: 'TCP提供可靠传输。', answerMarkdown: '对', explanationMarkdown: '', options: [], correctAnswers: ['true'], difficulty: 1, depth: 1, frequency: 1, frequencyScope: '', frequencyBasis: '', collection: 'general', status: 'published', categoryIds: [], tagIds: [], sourceRefs: [], sourceDocument: null, sourceAnchor: null }] };
  let durable: Uint8Array | undefined, failSave = false;
  const storage = { async load() { return durable?.slice(); }, async save(bytes: Uint8Array) { if (failSave) throw new Error('test storage full'); durable = bytes.slice(); } };
  let runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false }); t.after(() => runtime.close());
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const api = async (path: string, method = 'GET', body?: unknown, expected = 200): Promise<any> => {
    const response = await runtime.fetch(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  };
  const timing = async (id: string, action: 'resume' | 'checkpoint' | 'pause', sessionId: string, elapsedMilliseconds?: number, expected = 200) => {
    const expectedSessionId = action === 'resume' ? (await api(`/api/attempts/${id}`)).practiceTiming?.sessionId ?? null : undefined;
    return api(`/api/attempts/${id}/timing`, 'POST', { action, sessionId, ...(action === 'resume' ? { expectedSessionId } : {}), ...(elapsedMilliseconds === undefined ? {} : { elapsedMilliseconds }) }, expected);
  };
  const reopen = async () => { await runtime.close(); runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false }); };
  const paper = await api('/api/papers', 'POST', { title: '离线普通练习', mode: 'manual', questionIds: ['ACTIVE-Q'], scoring: { enabled: true, questionPoints: { 'ACTIVE-Q': 2 } } }, 201);
  let attempt: any;

  await t.test('new drafts and repeated GET/list reads do not start or advance the stopwatch', async () => {
    attempt = await api(`/api/papers/${paper.id}/attempts`, 'POST', { mode: 'practice' }, 201);
    assert.equal(attempt.elapsedSeconds, 0);
    const before = durable!.slice(); t.mock.timers.tick(300000); failSave = true;
    assert.equal((await api(`/api/attempts/${attempt.id}`)).elapsedSeconds, 0);
    assert.equal((await api(`/api/papers/${paper.id}/drafts`))[0].elapsedSeconds, 0);
    assert.equal((await api('/api/attempts?status=in_progress&page=1&pageSize=10')).items[0].elapsedSeconds, 0);
    failSave = false; assert.deepEqual(durable, before);
  });

  await t.test('pause is idempotent, answer autosave does not restart time, and reopening excludes a long offline gap', async () => {
    await timing(attempt.id, 'resume', 'native-session-one'); t.mock.timers.tick(12500);
    const paused = await timing(attempt.id, 'pause', 'native-session-one', 12500);
    assert.equal(paused.elapsedSeconds, 12); assert.equal(paused.practiceTiming.elapsedMilliseconds, 12500); assert.equal(paused.practiceTiming.running, false);
    await timing(attempt.id, 'pause', 'native-session-one', 12500);
    await api(`/api/attempts/${attempt.id}`, 'PUT', { answers: { 'ACTIVE-Q': { value: 'true' } } });
    t.mock.timers.tick(3600000); await reopen();
    const restored = await api(`/api/attempts/${attempt.id}`); assert.equal(restored.elapsedSeconds, 12); assert.equal(restored.answers['ACTIVE-Q'].value, 'true');
    await timing(attempt.id, 'resume', 'native-session-two'); t.mock.timers.tick(7800);
    const checkpoint = await timing(attempt.id, 'checkpoint', 'native-session-two', 7800); assert.equal(checkpoint.elapsedSeconds, 20);
    await api(`/api/attempts/${attempt.id}/timing`, 'POST', { action: 'resume', sessionId: 'native-delayed-resume', expectedSessionId: 'native-session-one' }, 409);
    const stale = await timing(attempt.id, 'pause', 'native-session-one', 20000);
    assert.equal(stale.practiceTiming.sessionId, 'native-session-two'); assert.equal(stale.practiceTiming.running, true); assert.equal(stale.elapsedSeconds, 20);
    await timing(attempt.id, 'pause', 'native-session-two', 7800); t.mock.timers.tick(86400000);
    const submitted = await api(`/api/attempts/${attempt.id}/submit`, 'POST', { answers: { 'ACTIVE-Q': { value: 'true' } } });
    assert.equal(submitted.elapsedSeconds, 20); assert.equal(submitted.practiceTiming.elapsedMilliseconds, 20300); assert.equal(submitted.objectiveScore, 2);
    await reopen(); assert.equal((await api(`/api/attempts/${attempt.id}`)).elapsedSeconds, 20);
  });

  await t.test('a missing final pause never adds the closed runtime gap, and a new session starts from its saved checkpoint', async () => {
    const draft = await api('/api/quick-practice', 'POST', { questionId: 'ACTIVE-Q' }, 201);
    await timing(draft.id, 'resume', 'native-abrupt-one'); t.mock.timers.tick(3500);
    await timing(draft.id, 'checkpoint', 'native-abrupt-one', 3500); await runtime.close();
    t.mock.timers.tick(172800000); runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false });
    assert.equal((await api(`/api/attempts/${draft.id}`)).elapsedSeconds, 3);
    await timing(draft.id, 'resume', 'native-abrupt-two'); t.mock.timers.tick(2600);
    const paused = await timing(draft.id, 'pause', 'native-abrupt-two', 2600); assert.equal(paused.elapsedSeconds, 6); assert.equal(paused.practiceTiming.elapsedMilliseconds, 6100);
    const complete = await api(`/api/attempts/${draft.id}/submit`, 'POST', { answers: {} }); assert.equal(complete.elapsedSeconds, 6);
  });

  await t.test('a failed native timer save rolls back both live state and durable bytes, and a retry counts once', async () => {
    const draft = await api(`/api/papers/${paper.id}/attempts`, 'POST', { mode: 'practice' }, 201);
    await timing(draft.id, 'resume', 'native-disk-session'); t.mock.timers.tick(4200);
    const before = await api(`/api/attempts/${draft.id}`), bytes = durable!.slice();
    failSave = true; await timing(draft.id, 'pause', 'native-disk-session', 4200, 507); failSave = false;
    assert.deepEqual(durable, bytes); assert.deepEqual(await api(`/api/attempts/${draft.id}`), before);
    const retried = await timing(draft.id, 'pause', 'native-disk-session', 4200); assert.equal(retried.elapsedSeconds, 4); assert.equal(retried.practiceTiming.elapsedMilliseconds, 4200);
    await reopen(); assert.equal((await api(`/api/attempts/${draft.id}`)).elapsedSeconds, 4);
  });

  await t.test('full SQLite backup validates accumulated timing, and exam time continues to use its absolute deadline', async () => {
    const response = await runtime.fetch('/api/backup.sqlite'); assert.equal(response.status, 200);
    const bytes = new Uint8Array(await response.arrayBuffer()); const preview = await runtime.previewRestore(bytes, 'practice-timer.sqlite'); assert.ok(preview.counts.attempts >= 3);
    const exam = await api(`/api/papers/${paper.id}/attempts`, 'POST', { mode: 'exam', durationMinutes: 1 }, 201);
    t.mock.timers.tick(20000); await api(`/api/attempts/${exam.id}`, 'PUT', { answers: { 'ACTIVE-Q': { value: 'true' } } });
    await timing(exam.id, 'pause', 'exam-must-not-pause', 20000, 409);
    await runtime.close(); t.mock.timers.tick(50000); runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false });
    const done = await api(`/api/attempts/${exam.id}/sync`, 'POST');
    assert.equal(done.elapsedSeconds, 60); assert.equal(done.status, 'submitted'); assert.equal(done.autoSubmitted, true); assert.equal(done.answers['ACTIVE-Q'].value, 'true');
  });
});
