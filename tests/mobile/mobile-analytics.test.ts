import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import initSqlJs from 'sql.js';
import { loadNativeRuntime } from '../helpers/native-runtime.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.ts';

test('native analytics retains submitted learning metrics through pruning, restarts, migration and explicit reset', async t => {


  const { createLocalRuntime } = await loadNativeRuntime();
  const sql = await initSqlJs({ locateFile: () => resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const common = { categoryIds: ['analytics-category'], status: 'published' };
  const seed = {
    schemaVersion: 1,
    domains: [{ id: 'analytics-domain', name: '统计领域', description: '', sortOrder: 0 }],
    categories: [{ id: 'analytics-category', domainId: 'analytics-domain', parentId: null, name: '基础', description: '', sortOrder: 0 }],
    tags: [], documents: [], papers: [],
    questions: [
      { ...common, id: 'ANALYTICS-TF', title: '判断', type: 'true_false', stemMarkdown: '判断命题', correctAnswers: ['true'] },
      { ...common, id: 'ANALYTICS-SA', title: '说明', type: 'short_answer', stemMarkdown: '解释概念', answerMarkdown: '参考原理' },
      { ...common, id: 'ANALYTICS-GROUP', title: '程序阅读', type: 'group', stemMarkdown: '公共材料', parts: [
        { id: 'tf', title: '判断小题', type: 'true_false', stemMarkdown: '判断材料', correctAnswers: ['true'], weight: 1 },
        { id: 'sa', title: '解释小题', type: 'short_answer', stemMarkdown: '解释材料', answerMarkdown: '参考说明', weight: 1 },
      ] },
    ],
    settings: [{ ...structuredClone(DEFAULT_SETTINGS), maxHistoryPerPaper: 1 }],
  };
  let durable: Uint8Array | undefined, saves = 0;
  const storage = { async load() { return durable?.slice(); }, async save(bytes: Uint8Array) { durable = bytes.slice(); saves++; } };
  let runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false }); t.after(() => runtime.close());
  const api = async (url: string, method = 'GET', body?: unknown, expected = 200): Promise<any> => {
    const response = await runtime.fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
  };
  const date = new Date().toISOString().slice(0, 10);
  const query = `?from=${date}&to=${date}&timeZone=UTC`;
  const analytics = () => api('/api/analytics' + query);
  const paper = await api('/api/papers', 'POST', { title: '统计练习', mode: 'manual', questionIds: ['ANALYTICS-TF', 'ANALYTICS-SA', 'ANALYTICS-GROUP'], scoring: { enabled: true, totalPoints: 10, questionPoints: { 'ANALYTICS-TF': 2, 'ANALYTICS-SA': 3, 'ANALYTICS-GROUP': 5 } } }, 201);
  const attempt = await api(`/api/papers/${paper.id}/attempts`, 'POST', {}, 201);
  await api(`/api/attempts/${attempt.id}`, 'PUT', { answers: { 'ANALYTICS-TF': { value: ['true'] } } });
  assert.equal((await analytics()).summary.answers, 0, 'saved drafts are not submitted work');
  const answers = { 'ANALYTICS-TF': { value: ['true'] }, 'ANALYTICS-SA': { value: '说明原理' }, 'ANALYTICS-GROUP::tf': { value: ['false'] }, 'ANALYTICS-GROUP::sa': { value: '解释边界' } };
  await api(`/api/attempts/${attempt.id}/submit`, 'POST', { answers });
  let report = await analytics();
  assert.equal(report.summary.answers, 4); assert.equal(report.summary.uniqueItems, 4); assert.equal(report.summary.uniqueQuestions, 3);
  assert.equal(report.summary.correct, 1); assert.equal(report.summary.incorrect, 1); assert.equal(report.summary.ungraded, 2); assert.equal(report.summary.accuracy, 50);
  assert.equal(report.summary.answeredSessions, 1); assert.equal(report.summary.timedSessions, 1); assert.equal(report.summary.missingTimeSessions, 0);
  assert.equal(report.domains.find((entry: any) => entry.id === 'analytics-domain').answers, 4);
  await api(`/api/attempts/${attempt.id}/review`, 'PUT', { scores: { 'ANALYTICS-SA': 1, 'ANALYTICS-GROUP::sa': 0 } });
  report = await analytics(); assert.equal(report.summary.partial, 1); assert.equal(report.summary.incorrect, 2); assert.equal(report.summary.ungraded, 0); assert.equal(report.summary.accuracy, 25);
  const repeat = await api(`/api/papers/${paper.id}/attempts`, 'POST', {}, 201);
  await api(`/api/attempts/${repeat.id}/submit`, 'POST', { answers: {} });
  await api(`/api/attempts/${attempt.id}`, 'GET', undefined, 404);
  report = await analytics(); assert.equal(report.summary.answers, 4); assert.equal(report.summary.sessions, 2); assert.equal(report.summary.omitted, 4); assert.equal(report.summary.timedSessions, 1);
  assert.equal(report.summary.uniqueItems, 4); assert.equal(report.types.reduce((total: number, entry: any) => total + entry.answers, 0), 4);
  const weekly = await api(`/api/analytics/weekly?week=${date}&timeZone=UTC`); assert.equal(weekly.current.summary.answers, 4); assert.equal(weekly.comparison.mode, 'matched_elapsed');
  const beforeReads = saves; await analytics(); await api(`/api/analytics/weekly?week=${date}&timeZone=UTC`); assert.equal(saves, beforeReads, 'read-only analytics never rewrites the native database');
  const backup = await api('/api/export');
  await runtime.close(); runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false });
  assert.equal((await analytics()).summary.accuracy, 25); assert.equal((await analytics()).summary.answers, 4);
  // A full JSON migration preserves compact metrics even when its full attempt
  // has been pruned and only the configured recent question details remain.
  await runtime.close(); durable = undefined;
  runtime = await createLocalRuntime(sql, backup, storage, { dailyPushScheduler: false });
  report = await analytics(); assert.equal(report.summary.answers, 4); assert.equal(report.summary.timedSessions, 1); assert.equal(report.summary.accuracy, 25);
  const preview = await api('/api/learning/reset-preview');
  await api('/api/learning/reset', 'POST', { fingerprint: preview.fingerprint, confirmed: true });
  report = await analytics(); assert.equal(report.summary.answers, 0); assert.equal(report.summary.sessions, 0); assert.equal(report.summary.reviewEvents, 0);
  const spec = await api('/api/openapi.json'); assert.ok(spec.paths['/api/analytics']); assert.ok(spec.paths['/api/analytics/weekly']);
});
