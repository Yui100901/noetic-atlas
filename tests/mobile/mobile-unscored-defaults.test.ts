import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import initSqlJs from 'sql.js';
import { loadNativeRuntime } from '../helpers/native-runtime.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.ts';

/** Real Android business runtime and SQLite WASM, with private test-only bytes. */
test('mobile opens old unscored type-default snapshots under new defaults and preserves them across restart', async t => {


  const { createLocalRuntime } = await loadNativeRuntime();
  const sql = await initSqlJs({ locateFile: () => resolve('node_modules/sql.js/dist/sql-wasm.wasm') });
  const stamp = '2026-10-24T00:00:00Z', submittedAt = '2026-10-24T00:00:10Z';
  const question = { id: 'OLD-MULTI', title: '独立测试多选题', type: 'multiple_choice', stemMarkdown: '选择两个正确选项。', options: [{ key: 'A', text: '正确一' }, { key: 'B', text: '正确二' }, { key: 'C', text: '错误' }], correctAnswers: ['A', 'B'], answerMarkdown: 'A、B', explanationMarkdown: '临时回归数据', status: 'published' };
  const scoring = { enabled: false, scheme: 'none', totalPoints: 0, questionPoints: { 'OLD-MULTI': 0 }, objectivePercent: 0, actualObjectivePercent: 0, objectivePoints: 0, subjectivePoints: 0, pointsByType: { ...DEFAULT_SETTINGS.pointsByType, multiple_choice: 2 } };
  const paper = { id: 'OLD-UNSCORED', title: '旧无分题集', description: '', mode: 'manual', organization: 'other', domainId: null, practiceKind: 'standard', questionIds: [question.id], questionCount: 1, snapshot: [question], filters: null, scoring, archived: false, version: 1, createdAt: stamp, updatedAt: stamp };
  const attempt = { id: 'OLD-UNSCORED-HISTORY', source: 'paper', paperId: paper.id, paperTitle: paper.title, paperVersion: 1, status: 'submitted', practiceMode: 'practice', durationMinutes: null, deadlineAt: null, elapsedSeconds: 10, autoSubmitted: false, questions: [question], answers: { 'OLD-MULTI': { value: ['A', 'B'] } }, scoring, objectiveScore: 0, subjectiveScore: 0, objectiveMax: 0, subjectiveMax: 0, startedAt: stamp, updatedAt: submittedAt, submittedAt };
  const seed = { schemaVersion: 1, domains: [], categories: [], tags: [], questions: [question], documents: [], papers: [paper], attempts: [attempt], settings: [{ ...structuredClone(DEFAULT_SETTINGS), updatedAt: stamp }] };
  let durable: Uint8Array | undefined;
  const storage = { async load() { return durable?.slice(); }, async save(bytes: Uint8Array) { durable = bytes.slice(); } };
  let runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false }); t.after(() => runtime.close());
  const api = async (path: string, method = 'GET', data?: unknown, status = 200): Promise<any> => {
    const response = await runtime.fetch(path, { method, headers: { 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const body = await response.json(); assert.equal(response.status, status, JSON.stringify(body)); return body;
  };
  const assertUnscored = (value: any) => {
    assert.equal(value.scoring.scheme, 'none'); assert.equal(value.scoring.enabled, false);
    assert.equal(value.scoring.pointsByType.multiple_choice, 2);
    assert.equal(value.scoring.totalPoints, 0); assert.deepEqual(value.scoring.questionPoints, { 'OLD-MULTI': 0 });
  };
  assert.equal((await api('/api/settings')).pointsByType.multiple_choice, 4);
  assertUnscored((await api('/api/papers?pageSize=10')).items[0]);
  assertUnscored(await api('/api/papers/' + paper.id + '?summary=true'));
  assertUnscored(await api('/api/papers/' + paper.id));
  assertUnscored(await api('/api/attempts/' + attempt.id));
  assertUnscored((await api('/api/attempts?paperId=' + paper.id)).find((value: any) => value.id === attempt.id));
  const fresh = await api('/api/papers/' + paper.id + '/attempts', 'POST', {}, 201); assertUnscored(fresh);
  assert.equal(fresh.objectiveMax, 0); assert.equal(fresh.subjectiveMax, 0);
  const submitted = await api('/api/attempts/' + fresh.id + '/submit', 'POST', { answers: { 'OLD-MULTI': { value: ['A', 'B'] } } });
  assertUnscored(submitted); assert.equal(submitted.objectiveScore, 0); assert.equal(submitted.totalScore, null); assert.equal(submitted.answerStates['OLD-MULTI'], 'correct');
  await runtime.close(); runtime = await createLocalRuntime(sql, seed, storage, { dailyPushScheduler: false });
  assert.equal((await api('/api/settings')).pointsByType.multiple_choice, 4);
  assertUnscored((await api('/api/papers?pageSize=10')).items[0]);
  assertUnscored(await api('/api/attempts/' + attempt.id)); assertUnscored(await api('/api/attempts/' + fresh.id));
});
