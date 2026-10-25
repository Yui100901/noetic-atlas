import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import initSqlJs from 'sql.js';
import { build } from 'vite';
import { nativeAliases } from '../../mobile/vite-aliases.ts';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.ts';

test('mobile daily recommendation progress survives saved drafts, grading, history pruning and restarts', async t => {
  const folder = resolve('test-results/native-daily-progress'); await mkdir(folder, { recursive: true });
  await build({ configFile: false, logLevel: 'error', define: { 'process.env': '{}' }, resolve: { alias: nativeAliases }, build: { outDir: folder, emptyOutDir: false, minify: false, lib: { entry: resolve('mobile/runtime.ts'), formats: ['es'], fileName: () => 'runtime.mjs' } } });
  const { createLocalRuntime } = await import(pathToFileURL(resolve(folder, 'runtime.mjs')).href);
  const sql = await initSqlJs({ locateFile: () => resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const objective = (id: string) => ({ id, title: id, type: 'true_false', stemMarkdown: '判断命题', answerMarkdown: '正确', correctAnswers: ['true'], categoryIds: ['progress-category'], status: 'published' });
  const subjective = { id: 'PROGRESS-SA', title: '解释概念', type: 'short_answer', stemMarkdown: '说明概念', answerMarkdown: '说明原理及边界', categoryIds: ['progress-category'], status: 'published' };
  const group = { id: 'PROGRESS-GROUP', title: '共同材料', type: 'group', stemMarkdown: '公共材料', categoryIds: ['progress-category'], status: 'published', parts: [
    { id: 'choice', title: '判断', type: 'true_false', stemMarkdown: '材料是否支持该命题', correctAnswers: ['true'], weight: 1 },
    { id: 'explain', title: '说明', type: 'short_answer', stemMarkdown: '说明理由', answerMarkdown: '参考理由', weight: 1 },
  ] };
  const settings = { ...structuredClone(DEFAULT_SETTINGS), maxHistoryPerPaper: 1, updatedAt: '2026-10-25T00:00:00Z', pointsByType: { ...DEFAULT_SETTINGS.pointsByType, true_false: 10, short_answer: 10, group: 20 }, dailyPush: { ...DEFAULT_SETTINGS.dailyPush, enabled: true, domainId: 'progress-domain', categoryIds: ['progress-category'], reviewPoints: 0, newPoints: 50 } };
  const seed = { schemaVersion: 1, domains: [{ id: 'progress-domain', name: '进度领域', description: '', sortOrder: 0 }], categories: [{ id: 'progress-category', domainId: 'progress-domain', parentId: null, name: '基础', description: '', sortOrder: 0 }], tags: [], questions: [objective('PROGRESS-TF-1'), objective('PROGRESS-TF-2'), subjective, group], documents: [], papers: [], settings: [settings] };
  let durable: Uint8Array | undefined, saves = 0;
  const storage = { async load() { return durable?.slice(); }, async save(bytes: Uint8Array) { durable = bytes.slice(); saves++; } };
  const options = { dailyPushScheduler: false, dailyPushNow: () => new Date('2026-10-25T04:00:00Z') };
  let runtime = await createLocalRuntime(sql, seed, storage, options); t.after(() => runtime.close());
  const api = async (url: string, method = 'GET', data?: unknown, expected = 200): Promise<any> => {
    const response = await runtime.fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
  };
  await api('/api/daily-push/check', 'POST');
  const progress = async () => (await api('/api/daily-push')).today.progress;
  const record = (await api('/api/daily-push')).today, paperId = record.paperId;
  let value = await progress(); assert.equal(value.status, 'not_started'); assert.equal(value.totalQuestions, 5); assert.equal(value.totalPoints, 50); assert.equal(value.percent, 0);
  const attempt = await api(`/api/papers/${paperId}/attempts`, 'POST', {}, 201);
  const objectiveQuestion = attempt.questions.find((question: any) => question.type === 'true_false');
  await api(`/api/attempts/${attempt.id}`, 'PUT', { answers: { [objectiveQuestion.id]: { value: ['true'] } } });
  value = await progress(); assert.equal(value.status, 'in_progress'); assert.equal(value.answeredQuestions, 1); assert.equal(value.answeredPoints, 10); assert.equal(value.percent, 20); assert.equal(value.resumeAttemptId, attempt.id);
  await runtime.close(); runtime = await createLocalRuntime(sql, seed, storage, options);
  value = await progress(); assert.equal(value.answeredQuestions, 1); assert.equal(value.resumeAttemptId, attempt.id);
  const answers = Object.fromEntries(attempt.questions.map((question: any) => [question.id, { value: question.type === 'true_false' ? ['true'] : '说明原理及边界' }]));
  await api(`/api/attempts/${attempt.id}/submit`, 'POST', { answers });
  value = await progress(); assert.equal(value.status, 'completed'); assert.equal(value.answeredQuestions, 5); assert.equal(value.percent, 100); assert.equal(value.pendingGradingCount, 2); assert.equal(value.resultAttemptId, attempt.id);
  const scores = Object.fromEntries(attempt.questions.filter((question: any) => question.type !== 'true_false').map((question: any) => [question.id, question.points]));
  await api(`/api/attempts/${attempt.id}/review`, 'PUT', { scores }); assert.equal((await progress()).pendingGradingCount, 0);
  const retry = await api(`/api/papers/${paperId}/attempts`, 'POST', {}, 201);
  value = await progress(); assert.equal(value.status, 'completed'); assert.equal(value.percent, 100); assert.equal(value.resumeAttemptId, retry.id);
  await api(`/api/attempts/${retry.id}/submit`, 'POST', { answers: {} });
  // The whole-paper history cap removes the earlier full result. Compact
  // retained evidence still proves completion; no result link may point at it.
  await api(`/api/attempts/${attempt.id}`, 'GET', undefined, 404);
  value = await progress(); assert.equal(value.status, 'completed'); assert.equal(value.answeredQuestions, 5); assert.equal(value.percent, 100); assert.equal(value.resultAttemptId, null); assert.equal(value.historyAvailable, false);
  const backup = await api('/api/export'); assert.ok(backup.dailyPushes[0].answerItems?.length === 5);
  const beforeReads = saves; await progress(); await progress(); assert.equal(saves, beforeReads, 'progress GETs never export or rewrite the native database');
  await runtime.close(); runtime = await createLocalRuntime(sql, seed, storage, options);
  value = await progress(); assert.equal(value.status, 'completed'); assert.equal(value.answeredPoints, 50); assert.equal(value.percent, 100);
});
