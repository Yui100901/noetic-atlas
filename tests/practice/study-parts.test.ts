import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../server/core/store.js';
import { buildApp } from '../../server/index.js';
import { importData, exportData } from '../../server/modules/transfer/migration.js';
import { createQuickAttempt, submitAttempt, reviewAttempt } from '../../server/modules/practice/service.js';
import { loadLeafStudies } from '../../server/modules/study/state.js';
import { studyPartKey } from '../../shared/questions/study-state.js';
import { learningQuestionKey } from '../../server/modules/practice/learning-state.js';
import type { Question } from '../../shared/models/types.js';
import { dashboardStats } from '../../server/core/read-models.js';

const stamp = '2026-10-20T00:00:00.000Z';
const question = (): Question => ({ id: 'material', title: '公共材料', type: 'group', stemMarkdown: '共同情景必须保留', answerMarkdown: '', explanationMarkdown: '', options: [], correctAnswers: [], difficulty: 1, depth: 1, frequency: 0, frequencyScope: '', frequencyBasis: '', collection: 'general', status: 'published', categoryIds: [], tagIds: [], sourceRefs: [], sourceDocument: null, sourceAnchor: null, parts: ['first', 'second'].map(id => ({ id, title: id, type: 'true_false', stemMarkdown: `${id}题干`, answerMarkdown: '正确', explanationMarkdown: '', options: [], correctAnswers: ['true'] })) });
const envelope = () => ({ schemaVersion: 1, domains: [], categories: [], tags: [], documents: [], papers: [], questions: [question()] });

test('part state never clones whole-group history and its tuple key cannot collide', t => {
  const store = new Store(':memory:'); t.after(() => store.db.close()); importData(store, envelope());
  store.putStudy({ ...store.study('material'), mastery: 3, favorite: true, notes: '原整组笔记', lastReviewedAt: stamp, nextReviewAt: stamp });
  assert.equal(store.study('material', 'first').mastery, null);
  assert.equal(store.study('material', 'first').lastReviewedAt, null);
  assert.notEqual(studyPartKey('a::b', 'c'), studyPartKey('a', 'b::c'));
  const leaves = question().parts!.map(part => ({ id: `material::${part.id}`, sourceId: 'material', partId: part.id, type: part.type }));
  store.putStudy({ ...store.study('material', 'first'), mastery: 1, notes: '仅第一小题的笔记', nextReviewAt: stamp });
  const reads = loadLeafStudies(store, leaves);
  assert.equal(reads.get(learningQuestionKey('material', 'material::first'))?.mastery, 1);
  assert.equal(reads.get(learningQuestionKey('material', 'material::second'))?.mastery, null);
  assert.equal(reads.get(learningQuestionKey('material', 'material::first'))?.favorite, true);
  assert.equal(reads.get(learningQuestionKey('material', 'material::first'))?.notes, '');
  assert.equal(loadLeafStudies(store, leaves, { includeNotes: true }).get(learningQuestionKey('material', 'material::first'))?.notes, '仅第一小题的笔记');
  assert.deepEqual(store.questions({ due: true }).map(item => item.id), ['material']);
  assert.equal(dashboardStats(store).dueCount, 1);
  store.put('questions', 'material', { ...question(), parts: [question().parts![1]!] });
  const originalRun = store.database.run; store.database.run = () => { throw new Error('learning reads must not write'); };
  assert.equal(loadLeafStudies(store, leaves).has(learningQuestionKey('material', 'material::first')), false);
  store.database.run = originalRun;
  assert.deepEqual(store.questions({ due: true }), []);
});

test('group submissions and reviews write independent part records and preserve common material', t => {
  const store = new Store(':memory:'); t.after(() => store.db.close()); importData(store, envelope());
  const attempt = createQuickAttempt(store, { questionId: 'material' });
  submitAttempt(store, attempt, { 'material::first': { value: 'false' }, 'material::second': { value: 'true' } });
  assert.equal(attempt.questions[0]?.groupStemMarkdown, '共同情景必须保留');
  assert.equal(store.study('material').wrongCount, 0);
  assert.equal(store.study('material', 'first').wrongCount, 1);
  assert.equal(store.study('material', 'second').wrongCount, 0);
  reviewAttempt(store, attempt, {}, { 'material::first': 1, 'material::second': 3 });
  assert.equal(store.study('material').mastery, null);
  assert.equal(store.study('material', 'first').mastery, 1);
  assert.equal(store.study('material', 'second').mastery, 3);
  assert.notEqual(store.study('material', 'first').nextReviewAt, store.study('material', 'second').nextReviewAt);
  const events = store.all('reviews'); assert.deepEqual(events.map(event => event.partId).sort(), ['first', 'second']);
  const backup: any = exportData(store), restored = new Store(':memory:'); t.after(() => restored.db.close()); importData(restored, backup);
  assert.equal(backup.studyParts.length, 2); assert.equal(backup.learningResults.length, 1);
  assert.equal(restored.study('material', 'first').mastery, 1);
  assert.equal(restored.all('learning_results').length, 1);
  const duplicate = structuredClone(backup); duplicate.studyParts.push(duplicate.studyParts[0]);
  assert.throws(() => importData(restored, duplicate), /重复 ID/);
});

test('manual part review and notes remain independent, favorite stays on whole question, and old reviews are readable', async t => {
  const app = await buildApp({ databasePath: ':memory:', seedPath: 'not-present-study-parts', staticRoot: 'not-present-study-parts' }); t.after(() => app.close());
  const imported = await app.inject({ method: 'POST', url: '/api/import', payload: { data: envelope(), mode: 'merge' } }); assert.equal(imported.statusCode, 200, imported.body);
  const request = async (url: string, method: 'PUT' | 'POST', payload: unknown) => { const response = await app.inject({ url, method, payload: payload as any }); assert.equal(response.statusCode, 200, response.body); return response.json(); };
  await request('/api/study/material/review', 'POST', { mastery: 2 });
  await request('/api/study/material/review', 'POST', { mastery: 1, partId: 'first' });
  await request('/api/study/material', 'PUT', { partId: 'first', notes: '独立笔记', nextReviewAt: stamp });
  await request('/api/study/material', 'PUT', { favorite: true });
  const current = (await app.inject('/api/questions/material')).json();
  assert.equal(current.study.mastery, 2); assert.equal(current.study.favorite, true);
  assert.equal(current.partStudies.find((item: any) => item.partId === 'first').notes, '独立笔记');
  assert.equal(current.partStudies.find((item: any) => item.partId === 'second').mastery, null);
  assert.equal((await app.inject('/api/reviews?questionId=material&whole=true&page=1&pageSize=20')).json().total, 1);
  assert.equal((await app.inject('/api/reviews?questionId=material&partId=first&page=1&pageSize=20')).json().total, 1);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/study/material', payload: { partId: 'first', favorite: true } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/study/material/review', payload: { partId: 'missing', mastery: 3 } })).statusCode, 404);
});

test('maximum-length parent and part IDs support snapshot reads, subjective grading and backup restore', async t => {
  const app = await buildApp({ databasePath: ':memory:', seedPath: 'not-present-study-long-ids', staticRoot: 'not-present-study-long-ids' }); t.after(() => app.close());
  const root = 'G'.repeat(160), first = 'P'.repeat(160), second = 'S'.repeat(160), firstLeaf = `${root}::${first}`, secondLeaf = `${root}::${second}`;
  assert.equal(firstLeaf.length, 322);
  const longGroup = { ...question(), id: root, parts: question().parts!.map((part, index) => ({ ...part, id: index ? second : first, type: 'short_answer', correctAnswers: [] })) };
  const call = async (url: string, method: 'GET' | 'PUT' | 'POST' = 'GET', payload?: unknown, status = 200) => { const response = await app.inject({ url, method, ...(payload === undefined ? {} : { payload: payload as any }) }); assert.equal(response.statusCode, status, response.body); return response.json(); };
  await call('/api/import', 'POST', { data: { ...envelope(), questions: [longGroup] }, mode: 'merge' });
  const paper = await call('/api/papers', 'POST', { title: '最长合法小题ID', mode: 'manual', questionIds: [root], scoring: { enabled: true, questionPoints: { [root]: 2 } } }, 201);
  const snapshot = await call(`/api/papers/${paper.id}/questions/${firstLeaf}`); assert.equal(snapshot.partId, first); assert.equal(snapshot.groupStemMarkdown, question().stemMarkdown);
  const attempt = await call(`/api/papers/${paper.id}/attempts`, 'POST', undefined, 201);
  await call(`/api/attempts/${attempt.id}/submit`, 'POST', { answers: { [firstLeaf]: { value: '第一题' }, [secondLeaf]: { value: '第二题' } } });
  const graded = await call(`/api/attempts/${attempt.id}/review`, 'PUT', { scores: { [firstLeaf]: 1, [secondLeaf]: 0 }, mastery: { [firstLeaf]: 3, [secondLeaf]: 0 } }); assert.equal(graded.subjectiveScore, 1);
  await call(`/api/study/${root}`, 'PUT', { partId: first, notes: '最长合法标识的小题笔记' });
  const backup = await call('/api/export'), restored = new Store(':memory:'); t.after(() => restored.db.close()); importData(restored, backup);
  assert.equal(restored.study(root, first).mastery, 3); assert.equal(restored.study(root, second).mastery, 0); assert.equal(restored.study(root, first).notes, '最长合法标识的小题笔记');
  assert.equal(restored.require<any>('attempts', attempt.id).questions[0].id.length, 322);
  assert.equal(restored.all('learning_results').length, 1);
  await call('/api/questions', 'POST', { ...question(), id: 'X'.repeat(161) }, 400);
});
