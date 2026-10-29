import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import initSqlJs from 'sql.js';
import { loadNativeRuntime } from '../helpers/native-runtime.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.ts';

test('native FSRS remains durable and idempotent through grading, pruning, direction changes, JSON/SQLite migration and reset', async t => {


  const { createLocalRuntime } = await loadNativeRuntime();
  const sql = await initSqlJs({ locateFile: () => resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const q = (id: string, type: string, extra = {}) => ({ id, title: id, type, stemMarkdown: '说明测试知识', status: 'published', ...extra });
  const seed = { schemaVersion: 1, domains: [], categories: [], tags: [], documents: [], papers: [], questions: [
    q('MANUAL', 'short_answer'), q('CORRECT', 'true_false', { correctAnswers: ['true'] }), q('WRONG', 'true_false', { correctAnswers: ['true'] }), q('SHORT', 'short_answer'),
    q('GROUP', 'group', { parts: [{ id: 'a', title: '判断小题', type: 'true_false', stemMarkdown: '判断', correctAnswers: ['true'] }, { id: 'b', title: '说明小题', type: 'short_answer', stemMarkdown: '解释理由' }] }),
    q('WORD', 'short_answer', { title: 'nativeword', stemMarkdown: 'nativeword', vocabulary: { language: 'en', headword: 'nativeword', meaningPrompt: 'a synthetic vocabulary entry', acceptedAnswers: ['nativeword'], pronunciations: [{ label: '测试', ipa: '/ˈneɪtɪv/', sourceLabel: '隔离数据', sourceUrl: 'https://example.test/pronunciation', license: 'fixture', method: 'manual' }] } }),
  ], settings: [{ ...structuredClone(DEFAULT_SETTINGS), maxHistoryPerPaper: 1 }] };
  let durable: Uint8Array | undefined, saves = 0, failSave = false;
  const backups = new Map<string, Uint8Array>();
  const storage = { async load() { return durable?.slice(); }, async save(bytes: Uint8Array) { if (failSave) throw new Error('test disk full'); durable = bytes.slice(); saves++; }, async createRecoveryBackup(bytes: Uint8Array) { const id = `adaptive-${backups.size}`; backups.set(id, bytes.slice()); return { id, byteLength: bytes.length, createdAt: new Date().toISOString() }; }, async loadRecoveryBackup(id: string) { return backups.get(id)!.slice(); } };
  let runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false }); t.after(() => runtime.close());
  const api = async (url: string, method = 'GET', body?: unknown, expected = 200): Promise<any> => { const response = await runtime.fetch(url, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }); const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value; };
  const card = (questionId: string, extra = '') => api('/api/review-scheduler/card?questionId=' + questionId + extra);
  assert.equal((await api('/api/settings')).reviewScheduling.strategy, 'fsrs');
  await api('/api/study/MANUAL', 'PUT', { mastery: 3 });
  const beforeRead = saves; const empty = await card('MANUAL'); assert.equal(empty.card, null); assert.equal(empty.preview.length, 4); await api('/api/review-scheduler/queue'); assert.equal(saves, beforeRead);
  const intent = { questionId: 'MANUAL', rating: 'good', requestId: 'manual-one' };
  let value = await api('/api/review-scheduler/review', 'POST', intent); assert.equal(value.card.memory.reps, 1);
  value = await api('/api/review-scheduler/review', 'POST', intent); assert.equal(value.eventCount, 1); assert.equal((await api('/api/questions/MANUAL')).study.mastery, 3);
  failSave = true; await api('/api/review-scheduler/review', 'POST', { ...intent, requestId: 'rollback', rating: 'again' }, 507); failSave = false; assert.equal((await card('MANUAL')).eventCount, 1);
  const paper = await api('/api/papers', 'POST', { title: 'FSRS移动回归', mode: 'manual', questionIds: ['CORRECT', 'WRONG', 'SHORT', 'GROUP'], scoring: { enabled: true, totalPoints: 20, questionPoints: { CORRECT: 2, WRONG: 2, SHORT: 4, GROUP: 12 } } }, 201);
  const attempt = await api(`/api/papers/${paper.id}/attempts`, 'POST', {}, 201);
  const answers = { CORRECT: { value: ['true'] }, WRONG: { value: ['false'] }, SHORT: { value: '独立说明' }, 'GROUP::a': { value: ['true'] }, 'GROUP::b': { value: '小题理由' } };
  await api(`/api/attempts/${attempt.id}/submit`, 'POST', { answers }); await api(`/api/attempts/${attempt.id}/submit`, 'POST', { answers });
  assert.equal((await card('CORRECT')).eventCount, 1); assert.equal((await card('WRONG')).latestRating, 'again'); assert.equal((await card('SHORT')).eventCount, 0);
  await api(`/api/attempts/${attempt.id}/review`, 'PUT', { scores: { SHORT: 1, 'GROUP::b': 6 } });
  assert.equal((await card('SHORT')).latestRating, 'again'); assert.equal((await card('GROUP', '&partId=b')).latestRating, 'good');
  await api(`/api/review-scheduler/attempts/${attempt.id}/rating`, 'POST', { leafId: 'SHORT', rating: 'easy' }, 400);
  await api(`/api/review-scheduler/attempts/${attempt.id}/rating`, 'POST', { leafId: 'CORRECT', rating: 'easy' }); assert.equal((await card('CORRECT')).eventCount, 1); assert.equal((await card('CORRECT')).latestRating, 'easy');
  await api(`/api/review-scheduler/attempts/${attempt.id}/rating`, 'POST', { leafId: 'CORRECT', rating: null }); assert.equal((await card('CORRECT')).latestRating, 'good');
  await api(`/api/attempts/${attempt.id}/review`, 'PUT', { scores: { SHORT: null } }); assert.equal((await card('SHORT')).eventCount, 0);
  const past = new Date(Date.now() - 86400000).toISOString();
  await api('/api/review-scheduler/card', 'PATCH', { questionId: 'CORRECT', dueAt: past, suspended: true }); assert.ok(!(await api('/api/review-scheduler/queue')).items.some((item: any) => item.questionId === 'CORRECT'));
  await api('/api/review-scheduler/card', 'PATCH', { questionId: 'CORRECT', suspended: false }); assert.ok((await api('/api/review-scheduler/queue')).items.some((item: any) => item.questionId === 'CORRECT'));
  const unscored = await api('/api/papers', 'POST', { title: '离线无分主观', mode: 'manual', questionIds: ['SHORT'], scoring: { enabled: false } }, 201);
  const essay = await api(`/api/papers/${unscored.id}/attempts`, 'POST', {}, 201); await api(`/api/attempts/${essay.id}/submit`, 'POST', { answers: { SHORT: { value: '没有AI也能复盘' } } });
  await api(`/api/attempts/${essay.id}/review`, 'PUT', { verdicts: { SHORT: 'correct' } }); assert.equal((await card('SHORT')).latestRating, 'good');
  const words = await api('/api/papers', 'POST', { title: '方向独立', mode: 'manual', practiceKind: 'vocabulary', questionIds: ['WORD'] }, 201);
  const reverse = await api(`/api/papers/${words.id}/attempts`, 'POST', { vocabularyDirection: 'meaning_to_word' }, 201); await api(`/api/attempts/${reverse.id}/submit`, 'POST', { answers: { WORD: { value: ['nativeword'] } } });
  assert.equal((await card('WORD', '&direction=meaning_to_word')).eventCount, 1); assert.equal((await card('WORD', '&direction=word_to_meaning')).eventCount, 0);
  const retry = await api(`/api/papers/${paper.id}/attempts`, 'POST', {}, 201); await api(`/api/attempts/${retry.id}/submit`, 'POST', { answers: {} }); await api(`/api/attempts/${attempt.id}`, 'GET', undefined, 404); assert.equal((await card('CORRECT')).eventCount, 1);
  const summary = (await api('/api/analytics')).adaptive; assert.ok(summary.feedbackEvents >= 7);
  const beforeMetadata = saves; await card('CORRECT'); await api('/api/review-scheduler/queue'); await api(`/api/review-scheduler/attempts/${essay.id}`); assert.equal(saves, beforeMetadata);
  const exported = await api('/api/export'); assert.ok(exported.reviewCards.length); assert.ok(exported.reviewEvents.length);
  await runtime.close(); runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false }); assert.equal((await card('CORRECT')).eventCount, 1);
  await runtime.close(); durable = undefined; runtime = await createLocalRuntime(sql, exported, storage, { dailyPushScheduler: false }); assert.equal((await card('CORRECT')).eventCount, 1); assert.equal((await card('WORD', '&direction=meaning_to_word')).eventCount, 1);
  const response = await runtime.fetch('/api/backup.sqlite'); assert.equal(response.status, 200); const bytes = new Uint8Array(await response.arrayBuffer());
  const forged = new sql.Database(bytes); forged.run("UPDATE review_cards SET data=json_set(data,'$.memory.reps',999)"); const invalid = forged.export(); forged.close(); await assert.rejects(runtime.previewRestore(invalid, 'forged-memory.sqlite'));
  const preview = await runtime.previewRestore(bytes, 'complete-memory.sqlite'); await runtime.restore(preview.token);
  await runtime.close(); runtime = await createLocalRuntime(sql, exported, storage, { dailyPushScheduler: false }); assert.equal((await card('CORRECT')).eventCount, 1);
  const reset = await api('/api/learning/reset-preview'); await api('/api/learning/reset', 'POST', { confirmed: true, fingerprint: reset.fingerprint });
  assert.equal((await api('/api/export')).reviewEvents.length, 0); assert.equal((await card('SHORT')).card, null);
  await api(`/api/attempts/${essay.id}/review`, 'PUT', { verdicts: { SHORT: 'incorrect' } }); assert.equal((await card('SHORT')).card, null, 'old retained results never reseed reset memory');
  const settings = await api('/api/settings'); await api('/api/settings', 'PUT', { settings: { ...settings, reviewScheduling: { ...settings.reviewScheduling, strategy: 'fixed' } } });
  await api('/api/study/MANUAL/review', 'POST', { mastery: 3 }); const due = (await api('/api/questions/MANUAL')).study.nextReviewAt; assert.ok((Date.parse(due) - Date.now()) / 86400000 > 20.9);
});
