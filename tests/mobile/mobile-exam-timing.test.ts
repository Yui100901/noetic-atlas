import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import initSqlJs from 'sql.js';
import { build } from 'vite';
import { nativeAliases } from '../../mobile/vite-aliases.js';
import type { SeedData } from '../../shared/models/types.js';

test('actual offline runtime persists exam deadline, auto-submission and elapsed time across restart without accepting late answers', async t => {
  const folder = resolve('test-results/native-exam-timing'); await mkdir(folder, { recursive: true });
  await build({ configFile: false, logLevel: 'error', define: { 'process.env': '{}' }, resolve: { alias: nativeAliases }, build: { outDir: folder, emptyOutDir: false, minify: false, lib: { entry: resolve('mobile/runtime.ts'), formats: ['es'], fileName: () => 'runtime.mjs' } } });
  const { createLocalRuntime } = await import(pathToFileURL(resolve(folder, 'runtime.mjs')).href);
  const sql = await initSqlJs({ locateFile: () => resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const start = Date.parse('2026-10-22T02:00:00.000Z');
  const seed: SeedData = { schemaVersion: 1, generatedAt: new Date(start).toISOString(), domains: [], categories: [], tags: [], documents: [], papers: [], questions: [{ id: 'TIMED-Q', title: '判断网络协议', type: 'true_false', stemMarkdown: 'TCP提供可靠传输', answerMarkdown: '对', explanationMarkdown: '', options: [], correctAnswers: ['true'], difficulty: 1, depth: 1, frequency: 1, frequencyScope: '', frequencyBasis: '', collection: 'general', status: 'published', categoryIds: [], tagIds: [], sourceRefs: [], sourceDocument: null, sourceAnchor: null }] };
  let durable: Uint8Array | undefined; const storage = { async load() { return durable?.slice(); }, async save(value: Uint8Array) { durable = value.slice(); } };
  let runtime = await createLocalRuntime(sql, seed, storage); t.after(() => runtime.close());
  async function api(path: string, method = 'GET', body?: unknown, expected = 200): Promise<any> { const response = await runtime.fetch(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result; }
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const paper = await api('/api/papers', 'POST', { title: '离线考试', mode: 'manual', questionIds: ['TIMED-Q'], scoring: { enabled: true, questionPoints: { 'TIMED-Q': 2 } } }, 201);
  const exam = await api(`/api/papers/${paper.id}/attempts`, 'POST', { mode: 'exam', durationMinutes: 1 }, 201);
  t.mock.timers.tick(20000); await api(`/api/attempts/${exam.id}`, 'PUT', { answers: { 'TIMED-Q': { value: 'true' } } });
  await runtime.close(); runtime = await createLocalRuntime(sql, seed, storage);
  const active = await api('/api/exams/active'); assert.equal(active.attempt.id, exam.id); assert.equal(active.attempt.deadlineAt, exam.deadlineAt);
  t.mock.timers.tick(50000); const submitted = await api(`/api/attempts/${exam.id}`, 'PUT', { answers: { 'TIMED-Q': { value: 'false' } } });
  assert.equal(submitted.status, 'submitted'); assert.equal(submitted.autoSubmitted, true); assert.equal(submitted.answers['TIMED-Q'].value, 'true'); assert.equal(submitted.elapsedSeconds, 60); assert.equal(submitted.objectiveScore, 2);
  await runtime.close(); runtime = await createLocalRuntime(sql, seed, storage);
  assert.equal((await api(`/api/attempts/${exam.id}`)).status, 'submitted'); assert.equal((await api('/api/exams/sync', 'POST')).attempt, null);
  const ordinary = await api(`/api/papers/${paper.id}/attempts`, 'POST', { mode: 'practice' }, 201); t.mock.timers.tick(12000);
  const done = await api(`/api/attempts/${ordinary.id}/submit`, 'POST', { answers: {} }); assert.equal(done.elapsedSeconds, 12); assert.equal(done.practiceMode, 'practice');
  const next = await api(`/api/papers/${paper.id}/attempts`, 'POST', { mode: 'exam', durationMinutes: 1 }, 201); t.mock.timers.tick(61000);
  assert.equal((await api('/api/exams/sync', 'POST')).attempt, null); await runtime.close(); runtime = await createLocalRuntime(sql, seed, storage);
  assert.equal((await api(`/api/attempts/${next.id}`)).autoSubmitted, true);
});
