import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Question } from '../../shared/models/types.js';
import { Store } from '../../server/core/store.js';
import { parse, questionSchema } from '../../server/core/validation.js';
import { buildApp } from '../../server/index.js';
import { legacyBankPaper, migrateLegacyBanks } from '../../server/modules/banks/legacy-banks.js';
import { exportData, importData } from '../../server/modules/transfer/migration.js';
import { exportShare, importShare, planShareImport } from '../../server/modules/sharing/routes.js';
import { buildPaper, createAttempt } from '../../server/modules/practice/service.js';

const stamp = '2026-10-21T00:00:00.000Z';
const question = (id: string, status: Question['status'] = 'published'): Question => ({ ...parse(questionSchema, { id, title: id, type: 'short_answer', stemMarkdown: '解释边界', answerMarkdown: '参考定义', status }), id, createdAt: stamp, updatedAt: stamp });
function fixture(t: test.TestContext) { const store = new Store(':memory:'); t.after(() => store.db.close()); return store; }
function legacy(store: Store, id: string, questionIds: string[]) { const bank = { id, name: '跨领域学习', description: '原有说明\n第二行', questionIds, createdAt: stamp, updatedAt: stamp }; store.put('question_banks', id, bank); return bank; }

test('legacy references become one unscored set with original order, empty/unpublished sets archived, and migration is idempotent', t => {
  const store = fixture(t);
  for (const q of [question('second'), question('first'), question('pending', 'pending')]) store.put('questions', q.id, q);
  const bank = legacy(store, 'old-bank', ['second', 'first']);
  legacy(store, 'review-bank', ['pending', 'first']); legacy(store, 'empty-bank', []);
  assert.equal(migrateLegacyBanks(store), 3);
  const paper = store.require('papers', bank.id);
  assert.equal(paper.title, bank.name); assert.equal(paper.description, bank.description);
  assert.deepEqual(paper.questionIds, bank.questionIds); assert.deepEqual(paper.snapshot.map((q: Question) => q.id), bank.questionIds);
  assert.equal(paper.createdAt, stamp); assert.equal(paper.updatedAt, stamp); assert.equal(paper.scoring.enabled, false); assert.equal(paper.scoring.totalPoints, 0);
  assert.equal(paper.archived, false); assert.equal(store.require('papers', 'review-bank').archived, true); assert.equal(store.require('papers', 'empty-bank').archived, true);
  assert.deepEqual(store.all('question_banks'), []); assert.equal(migrateLegacyBanks(store), 0);
  store.put('papers', bank.id, { ...paper, title: '本地调整后的题集', version: 4 }); legacy(store, bank.id, bank.questionIds);
  migrateLegacyBanks(store); assert.equal(store.all('papers').length, 3); assert.equal(store.require('papers', bank.id).version, 4);
});

test('migration preserves existing paper and attempt history and rolls every change back on a dangling member', t => {
  const store = fixture(t), q = question('source'); store.put('questions', q.id, q);
  const paper = buildPaper(store, { id: 'collision', title: '已保存题集', description: '', mode: 'manual', questionIds: [q.id], scoring: { enabled: false } });
  store.put('papers', paper.id, paper); const attempt = createAttempt(store, paper); store.put('attempts', attempt.id, attempt);
  legacy(store, 'collision', [q.id]); legacy(store, 'bad', ['missing']);
  assert.throws(() => migrateLegacyBanks(store)); assert.equal(store.all('papers').length, 1); assert.equal(store.all('question_banks').length, 2);
  store.remove('question_banks', 'bad'); migrateLegacyBanks(store);
  assert.deepEqual(store.require('papers', paper.id), paper); assert.deepEqual(store.require('attempts', attempt.id), attempt);
  const converted = store.all('papers').find(p => p.legacyBankId === 'collision'); assert.ok(converted); assert.notEqual(converted.id, paper.id);
});

test('legacy filter cleanup loads only affected paper and draft bodies, including explicitly null obsolete fields', t => {
  const store = fixture(t);
  store.put('papers', 'modern', { id: 'modern', title: '现代题集', filters: { domainId: 'computer' }, snapshot: [{ stemMarkdown: '无需读取'.repeat(1000) }] });
  store.put('papers', 'legacy', { id: 'legacy', title: '旧题集', filters: { bankId: null, domainId: 'computer' } });
  store.put('paper_drafts', 'modern-draft', { id: 'modern-draft', state: { filters: {}, random: {} } });
  store.put('paper_drafts', 'legacy-draft', { id: 'legacy-draft', state: { filters: { bankId: '' }, random: { bankId: 'old-bank', count: 20 } } });
  const all = store.all.bind(store), get = store.get.bind(store), bodyReads: string[] = [];
  store.all = function <T>(table: Parameters<Store['all']>[0]): T[] { assert.ok(!['papers', 'paper_drafts'].includes(table)); return all<T>(table); };
  store.get = function <T>(table: Parameters<Store['get']>[0], id: string): T | undefined { if (table === 'papers' || table === 'paper_drafts') bodyReads.push(id); return get<T>(table, id); };
  assert.equal(migrateLegacyBanks(store), 2); assert.deepEqual(bodyReads, ['legacy', 'legacy-draft']);
  assert.deepEqual(get('papers', 'legacy').filters, { domainId: 'computer' });
  assert.deepEqual(get('paper_drafts', 'legacy-draft').state, { filters: {}, random: { count: 20 } });
  bodyReads.length = 0; assert.equal(migrateLegacyBanks(store), 0); assert.deepEqual(bodyReads, []);
});

test('legacy JSON imports convert collections without losing large membership, preserve review status and export only sets', t => {
  const source = fixture(t), target = fixture(t);
  const questions = Array.from({ length: 1001 }, (_, index) => question(`term-${index}`));
  for (const q of questions) source.put('questions', q.id, q);
  const bank = { id: 'large', name: '完整术语题集', description: '保留全部顺序', questionIds: questions.map(q => q.id).reverse(), createdAt: stamp, updatedAt: stamp };
  const data = { ...exportData(source), questionBanks: [bank] };
  importData(target, data);
  assert.deepEqual(target.require('papers', bank.id).questionIds, bank.questionIds); assert.equal(target.require('papers', bank.id).questionCount, 1001);
  assert.equal(target.require('questions', questions[0]!.id).status, 'published'); assert.deepEqual(target.all('question_banks'), []);
  const exported = exportData(target) as any; assert.deepEqual(exported.questionBanks, []); assert.equal(exported.papers.length, 1);
  importData(target, data); assert.equal(target.all('papers').length, 1);
  const restored = fixture(t); importData(restored, exported); assert.deepEqual(restored.require('papers', bank.id).questionIds, bank.questionIds);
  const broken = fixture(t); assert.throws(() => importData(broken, { ...data, questionBanks: [{ ...bank, questionIds: [...bank.questionIds, 'missing'] }] })); assert.equal(broken.all('questions').length, 0);
});

test('old sharing packages stage collections as sets, remap collisions, require review and remain idempotent', t => {
  const source = fixture(t), target = fixture(t), q = question('same-id'); source.put('questions', q.id, q);
  target.put('questions', q.id, { ...q, title: '本地不同题目' });
  const data = { ...exportShare(source, { kind: 'questions', ids: [q.id] }), questionBanks: [{ id: 'shared-old', name: '共享集合', description: '说明', questionIds: [q.id] }] };
  const preview = planShareImport(target, data); assert.equal(preview.records.some(record => record.table === 'question_banks'), false); assert.equal(target.all('papers').length, 0);
  importShare(target, data); const paper = target.require('papers', 'shared-old');
  assert.notEqual(paper.questionIds[0], q.id); assert.equal(paper.snapshot[0].status, 'pending'); assert.equal(paper.archived, true); assert.equal(paper.scoring.enabled, false);
  assert.deepEqual(target.all('question_banks'), []); assert.equal(importShare(target, data).counts.papers!.added, 0);
  const modern = exportShare(target, { kind: 'paper', id: paper.id }); assert.deepEqual(modern.questionBanks, []); assert.equal(modern.papers.length, 1);
  const bad = { ...data, questionBanks: [{ ...data.questionBanks[0], questionIds: ['missing'] }] }; assert.throws(() => importShare(target, bad)); assert.equal(target.all('papers').length, 1);
});

test('large and empty migrated sets also survive modern sharing JSON round trips', t => {
  const source = fixture(t), target = fixture(t), qs = Array.from({ length: 501 }, (_, index) => question(`shared-${index}`));
  for (const q of qs) source.put('questions', q.id, q);
  for (const [id, questions] of [['large', qs], ['empty', []]] as const) {
    const bank = { id, name: id, description: '', questionIds: questions.map(q => q.id) }, paper = legacyBankPaper(bank, [...questions]); source.put('papers', id, paper);
    importShare(target, exportShare(source, { kind: 'paper', id })); assert.deepEqual(target.require('papers', id).questionIds, bank.questionIds);
  }
});

test('application startup upgrades a persisted legacy database and signals mobile durable persistence once', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-legacy-banks-')), path = join(directory, 'test.sqlite');
  t.after(() => { assert.ok(directory.startsWith(join(tmpdir(), 'atlas-legacy-banks-'))); rmSync(directory, { recursive: true, force: true }); });
  const original = new Store(path), q = question('boot'); original.put('questions', q.id, q); legacy(original, 'boot-bank', [q.id]); original.db.close();
  let migrations = 0;
  const app = await buildApp({ databasePath: path, staticRoot: join(directory, 'no-web'), onDataMigrated: () => migrations++ });
  assert.equal(migrations, 1); assert.equal((await app.inject('/api/papers/boot-bank')).statusCode, 200); assert.equal((await app.inject('/api/question-banks')).statusCode, 404); await app.close();
  const reopened = await buildApp({ databasePath: path, staticRoot: join(directory, 'no-web'), onDataMigrated: () => migrations++ }); assert.equal(migrations, 1); await reopened.close();
});

test('large reviewed legacy sets restore without the editor limit, refresh references in order and never rewrite past attempts', async t => {
  const app = await buildApp({ databasePath: ':memory:', staticRoot: 'test-results/no-legacy-restore-web' }); t.after(() => app.close());
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown, expected = 200) => { const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) }); assert.equal(response.statusCode, expected, response.body); return response.json(); };
  const source = fixture(t), questions = Array.from({ length: 501 }, (_, index) => question(`restore-${index}`, 'pending'));
  const questionIds = questions.map(q => q.id).reverse();
  await call('POST', '/api/import', { mode: 'merge', data: { ...exportData(source), questions, questionBanks: [{ id: 'review-large', name: '审核后练习', description: '全部501题', questionIds }] } });
  await call('POST', '/api/papers/review-large/restore', { confirmed: false }, 400);
  await call('POST', '/api/papers/review-large/restore', { confirmed: true }, 409);
  const firstId = questionIds[0]!, first = await call('GET', `/api/questions/${firstId}`);
  await call('PUT', `/api/questions/${firstId}`, { ...first, stemMarkdown: '经过审核校对的题干' });
  const incoming = (await call('GET', '/api/export')).questions;
  for (let start = 0; start < incoming.length; start += 500) { const batch = incoming.slice(start, start + 500); await call('POST', '/api/questions/review', { ids: batch.map((q: Question) => q.id), action: 'approve', confirmed: true, expectedUpdatedAt: Object.fromEntries(batch.map((q: Question) => [q.id, q.updatedAt])) }); }
  const restored = await call('POST', '/api/papers/review-large/restore', { confirmed: true });
  assert.equal(restored.archived, false); assert.equal(restored.version, 2); assert.equal(restored.questionCount, 501); assert.deepEqual(restored.questionIds, questionIds);
  assert.equal((await call('GET', `/api/papers/review-large/questions/${firstId}`)).stemMarkdown, '经过审核校对的题干');
  assert.equal((await call('POST', '/api/papers/review-large/restore', { confirmed: true })).version, 2);
  const attempt = await call('POST', '/api/papers/review-large/attempts', { count: 3, selection: 'ordered' }, 201);
  assert.deepEqual(attempt.questions.map((q: Question) => q.id), questionIds.slice(0, 3));
  await call('DELETE', '/api/papers/review-large');
  const reviewed = await call('GET', `/api/questions/${firstId}`); await call('PUT', `/api/questions/${firstId}`, { ...reviewed, stemMarkdown: '后来修订的新题干' });
  await call('POST', '/api/papers/review-large/restore', { confirmed: true });
  assert.equal((await call('GET', `/api/papers/review-large/questions/${firstId}`)).stemMarkdown, '经过审核校对的题干');
  assert.equal((await call('GET', '/api/papers/review-large')).version, 2);
  assert.deepEqual((await call('GET', `/api/attempts/${attempt.id}`)).questions, attempt.questions);
  assert.equal((await call('GET', `/api/attempts/${attempt.id}`)).paperVersion, 2);
  const spec = await call('GET', '/api/openapi.json');
  assert.deepEqual(spec.paths['/api/papers/{id}/restore'].post.requestBody.content['application/json'].schema.required, ['confirmed']);
  assert.equal(spec.paths['/api/papers/{id}/attempts'].post.requestBody.content['application/json'].schema.properties.count.maximum, 500);
  assert.ok(spec.paths['/api/papers/{id}'].get.parameters.some((parameter: any) => parameter.name === 'summary'));
  assert.ok(spec.paths['/api/papers/{id}/questions/{questionId}'].get.responses[200].content['application/json'].schema.properties.answerMarkdown);
});

test('restoring ordinary scored sets keeps the authored snapshot and points; empty or unpublished sets remain archived', async t => {
  const source = fixture(t), original = question('frozen'); source.put('questions', original.id, original);
  const paper = buildPaper(source, { id: 'scored', title: '评分题集', description: '', mode: 'manual', questionIds: [original.id], scoring: { enabled: true, totalPoints: 8, questionPoints: { frozen: 8 } } }); source.put('papers', paper.id, { ...paper, archived: true });
  for (const enabled of [true, false]) { const authored = buildPaper(source, { id: `edited-legacy-${enabled}`, title: '迁移后已编辑', description: '', mode: 'manual', questionIds: [original.id], scoring: enabled ? { enabled, totalPoints: 8, questionPoints: { frozen: 8 } } : { enabled } }); source.put('papers', authored.id, { ...authored, legacyBankId: `legacy-${enabled}`, version: 2, archived: true }); }
  source.put('questions', original.id, { ...original, stemMarkdown: '新的源题内容' }); legacy(source, 'empty', []);
  const app = await buildApp({ databasePath: ':memory:', staticRoot: 'test-results/no-ordinary-restore-web' }); t.after(() => app.close());
  let response = await app.inject({ method: 'POST', url: '/api/import', payload: { mode: 'merge', data: exportData(source) } }); assert.equal(response.statusCode, 200, response.body);
  response = await app.inject({ method: 'POST', url: '/api/papers/scored/restore', payload: { confirmed: true } }); assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().scoring.totalPoints, 8); assert.equal(response.json().version, paper.version);
  const snapshot = (await app.inject('/api/papers/scored/questions/frozen')).json(); assert.equal(snapshot.stemMarkdown, original.stemMarkdown);
  for (const enabled of [true, false]) { const restored = await app.inject({ method: 'POST', url: `/api/papers/edited-legacy-${enabled}/restore`, payload: { confirmed: true } }); assert.equal(restored.statusCode, 200, restored.body); assert.equal(restored.json().version, 2); assert.equal(restored.json().scoring.enabled, enabled); assert.equal(restored.json().scoring.totalPoints, enabled ? 8 : 0); assert.equal((await app.inject(`/api/papers/edited-legacy-${enabled}/questions/frozen`)).json().stemMarkdown, original.stemMarkdown); }
  response = await app.inject({ method: 'POST', url: '/api/papers/empty/restore', payload: { confirmed: true } }); assert.equal(response.statusCode, 409);
  assert.equal((await app.inject('/api/papers/empty')).json().archived, true);
});
