import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../server/index.js';

type App = Awaited<ReturnType<typeof buildApp>>;
function result(response: { statusCode: number; json: () => any }, expected = 200) {
  assert.equal(response.statusCode, expected, JSON.stringify(response.json())); return response.json();
}
const minimal = (id?: string, overrides: Record<string, unknown> = {}) => ({ ...(id ? { id } : {}), title: '新题：验证条件与反例', type: 'short_answer', stemMarkdown: '请说明适用条件，并给出反例。', answerMarkdown: '先核对前提，再验证边界。', ...overrides });
const envelope = (questions: unknown[]) => ({ format: 'learning-new-questions', schemaVersion: 1, questions });
const bulk = (app: App, questions: unknown[], bankId?: string) => app.inject({ method: 'POST', url: '/api/questions/bulk-import', payload: { data: envelope(questions), confirmed: true, ...(bankId ? { bankId } : {}) } });
async function fixture(t: test.TestContext) {
  const app = await buildApp({ databasePath: ':memory:', seedPath: 'test-results/nonexistent-bank-seed.json', staticRoot: 'test-results/nonexistent-bank-web' });
  t.after(() => app.close()); return app;
}
async function approved(app: App, id: string, overrides: Record<string, unknown> = {}) {
  const q = result(await app.inject({ method: 'POST', url: '/api/questions', payload: minimal(id, overrides) }), 201);
  result(await app.inject({ method: 'POST', url: '/api/questions/review', payload: { ids: [q.id], action: 'approve', confirmed: true, expectedUpdatedAt: { [q.id]: q.updatedAt } } }));
  return result(await app.inject('/api/questions/' + id));
}
const bank = async (app: App, id: string, questionIds: string[] = []) => result(await app.inject({ method: 'POST', url: '/api/question-banks', payload: { id, name: id, description: '引用集合', questionIds } }), 201);

test('new-question JSON template imports all seven types as pending and cannot bypass explicit confirmation', async t => {
  const app = await fixture(t); const template = result(await app.inject('/api/questions/import-template'));
  assert.equal(template.format, 'learning-new-questions'); assert.equal(template.questions.length, 7);
  assert.equal(new Set(template.questions.map((q: any) => q.type)).size, 7);
  assert.ok(template.questions.every((q: any) => !q.id && !q.categoryIds.length && !q.tagIds.length && q.frequency === 0));
  result(await app.inject({ method: 'POST', url: '/api/questions/bulk-import', payload: { data: template, confirmed: false } }), 400);
  const imported = result(await app.inject({ method: 'POST', url: '/api/questions/bulk-import', payload: { data: template, confirmed: true } }), 201);
  assert.equal(imported.added, 7); assert.equal(new Set(imported.items.map((q: any) => q.id)).size, 7);
  assert.ok(imported.items.every((q: any) => q.status === 'pending' && q.updatedAt));
  assert.equal(result(await app.inject('/api/questions')).total, 0);
  assert.equal(result(await app.inject('/api/questions?status=pending')).total, 7);
  result(await app.inject({ method: 'POST', url: '/api/import', payload: { data: template, mode: 'merge' } }), 400);
});

test('bulk new questions are atomic on ID conflicts, invalid references, strict fields and batch limits', async t => {
  const app = await fixture(t); await approved(app, 'existing'); const collection = await bank(app, 'batch-bank');
  const conflict = result(await bulk(app, [minimal('must-rollback'), minimal('existing')], collection.id), 409);
  assert.equal(conflict.error.code, 'ID_EXISTS'); result(await app.inject('/api/questions/must-rollback'), 404);
  assert.equal(result(await app.inject('/api/questions/existing')).status, 'published');
  result(await bulk(app, [minimal('duplicate'), minimal('duplicate')]), 400);
  result(await bulk(app, [minimal('valid'), minimal('invalid', { tagIds: ['missing-tag'] })], collection.id), 400);
  result(await app.inject('/api/questions/valid'), 404);
  result(await bulk(app, [minimal('unexpected', { study: { mastery: 3 } })]), 400);
  result(await bulk(app, [minimal('bad-choice', { type: 'single_choice', options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }], correctAnswers: ['C'] })]), 400);
  result(await bulk(app, Array.from({ length: 501 }, () => minimal())), 400);
  result(await bulk(app, [minimal('missing-bank')], 'absent'), 404); result(await app.inject('/api/questions/missing-bank'), 404);
  assert.deepEqual(result(await app.inject('/api/question-banks/batch-bank')), collection);
  const success = result(await bulk(app, [minimal('incoming-published', { status: 'published' }), minimal('incoming-draft', { status: 'draft' })], collection.id), 201);
  assert.ok(success.items.every((q: any) => q.status === 'pending'));
  const updated = result(await app.inject('/api/question-banks/batch-bank'));
  assert.deepEqual(updated.questionIds, ['incoming-published', 'incoming-draft']); assert.notEqual(updated.updatedAt, collection.updatedAt);
});

test('new custom question IDs cannot collide with UI or template routes and rejected batches remain atomic', async t => {
  const app = await fixture(t); const collection = await bank(app, 'reserved-check');
  for (const reserved of ['new', 'review', 'import', 'import-template']) {
    const single = result(await app.inject({ method: 'POST', url: '/api/questions', payload: minimal(reserved) }), 400);
    assert.equal(single.error.code, 'QUESTION_ID_RESERVED');
    const batch = result(await bulk(app, [minimal('rollback-' + reserved), minimal(reserved)], collection.id), 400);
    assert.equal(batch.error.code, 'QUESTION_ID_RESERVED');
    result(await app.inject('/api/questions/rollback-' + reserved), 404);
  }
  assert.equal(result(await app.inject('/api/questions?status=all')).total, 0);
  assert.deepEqual(result(await app.inject('/api/question-banks/' + collection.id)), collection);
  const single = result(await app.inject({ method: 'POST', url: '/api/questions', payload: minimal('MY-CUSTOM-001') }), 201);
  const batch = result(await bulk(app, [minimal('MY-CUSTOM-002')], collection.id), 201);
  assert.equal(single.status, 'pending'); assert.equal(batch.items[0].status, 'pending');
  assert.equal(result(await app.inject('/api/questions/MY-CUSTOM-001')).id, single.id);
  assert.equal(result(await app.inject('/api/questions/MY-CUSTOM-002')).id, batch.items[0].id);
  assert.equal(result(await app.inject('/api/questions/import-template')).format, 'learning-new-questions');
});

test('banks support cross-domain many-to-many membership with immutable IDs and optimistic updates', async t => {
  const app = await fixture(t);
  for (const id of ['computer', 'language']) {
    result(await app.inject({ method: 'POST', url: '/api/domains', payload: { id, name: id } }), 201);
    result(await app.inject({ method: 'POST', url: '/api/categories', payload: { id: id + '-base', name: '基础', domainId: id } }), 201);
  }
  await approved(app, 'technical', { categoryIds: ['computer-base'] }); await approved(app, 'english', { categoryIds: ['language-base'] });
  const first = await bank(app, 'mixed', ['technical', 'english']); await bank(app, 'second', ['technical']);
  assert.equal(result(await app.inject('/api/question-banks')).length, 2);
  assert.equal(result(await app.inject('/api/questions?bankId=mixed')).total, 2);
  result(await app.inject({ method: 'POST', url: '/api/question-banks', payload: { name: '不存在', questionIds: ['absent'] } }), 404);
  result(await app.inject({ method: 'PUT', url: '/api/question-banks/mixed', payload: { ...first, id: 'renamed' } }), 400);
  result(await app.inject({ method: 'PUT', url: '/api/question-banks/mixed', payload: { ...first, questionIds: ['technical', 'technical'] } }), 400);
  const revised = result(await app.inject({ method: 'PUT', url: '/api/question-banks/mixed', payload: { ...first, name: '已调整', questionIds: ['english'] } }));
  assert.notEqual(revised.updatedAt, first.updatedAt);
  const stale = result(await app.inject({ method: 'PUT', url: '/api/question-banks/mixed', payload: first }), 409); assert.equal(stale.error.code, 'BANK_VERSION_CONFLICT');
  assert.deepEqual(result(await app.inject('/api/question-banks/mixed')).questionIds, ['english']);
  result(await app.inject({ method: 'DELETE', url: '/api/question-banks/second' })); assert.equal(result(await app.inject('/api/questions/technical')).status, 'published');
});

test('question-bank filtering and random assembly intersect published state and ordinary filters', async t => {
  const app = await fixture(t); await approved(app, 'ready'); await approved(app, 'outside');
  const pending = result(await bulk(app, [minimal('pending')]), 201).items[0]; await bank(app, 'chosen', ['ready', 'pending']);
  assert.deepEqual(result(await app.inject('/api/questions?bankId=chosen')).items.map((q: any) => q.id), ['ready']);
  assert.equal(result(await app.inject('/api/questions?bankId=chosen&status=all')).total, 2);
  result(await app.inject('/api/questions?bankId=missing'), 404);
  const request = { title: '题库内随机', mode: 'random', count: 1, filters: { bankId: 'chosen', types: ['short_answer'] }, scoring: { enabled: false } };
  const preview = result(await app.inject({ method: 'POST', url: '/api/papers/preview', payload: request })); assert.deepEqual(preview.questionIds, ['ready']);
  result(await app.inject({ method: 'POST', url: '/api/papers', payload: { ...request, count: 2 } }), 422);
  result(await app.inject({ method: 'POST', url: '/api/papers/preview', payload: { ...request, filters: { bankId: 'chosen', types: ['true_false'] } } }), 422);
  result(await app.inject({ method: 'POST', url: '/api/questions/review', payload: { ids: [pending.id], action: 'approve', confirmed: true, expectedUpdatedAt: { [pending.id]: pending.updatedAt } } }));
  const paper = result(await app.inject({ method: 'POST', url: '/api/papers', payload: { ...request, count: 2 } }), 201);
  assert.deepEqual([...paper.questionIds].sort(), ['pending', 'ready']); assert.equal(paper.filters.bankId, 'chosen');
});

test('deleting source questions removes all bank references and advances timestamps', async t => {
  const app = await fixture(t); await approved(app, 'delete-me'); await approved(app, 'keep');
  const a = await bank(app, 'a', ['delete-me', 'keep']); const b = await bank(app, 'b', ['delete-me']);
  result(await app.inject({ method: 'DELETE', url: '/api/questions/delete-me' }));
  const afterA = result(await app.inject('/api/question-banks/a')); const afterB = result(await app.inject('/api/question-banks/b'));
  assert.deepEqual(afterA.questionIds, ['keep']); assert.deepEqual(afterB.questionIds, []);
  assert.notEqual(afterA.updatedAt, a.updatedAt); assert.notEqual(afterB.updatedAt, b.updatedAt);
  result(await app.inject('/api/questions/delete-me'), 404);
});

test('backups preserve bank references and review states, accept old backups and reject dangling bank graphs atomically', async t => {
  const app = await fixture(t); await approved(app, 'ready'); result(await bulk(app, [minimal('pending')]), 201); await bank(app, 'portable', ['ready', 'pending']);
  const backup = result(await app.inject('/api/export')); assert.equal(backup.schemaVersion, 1); assert.equal(backup.questionBanks.length, 1); assert.equal(backup.question_banks, undefined);
  const target = await fixture(t); const imported = result(await target.inject({ method: 'POST', url: '/api/import', payload: { data: backup, mode: 'merge' } })); assert.equal(imported.counts.questionBanks.added, 1);
  assert.deepEqual(result(await target.inject('/api/question-banks/portable')).questionIds, ['ready', 'pending']);
  assert.equal(result(await target.inject('/api/questions/pending')).status, 'pending'); assert.equal(result(await target.inject('/api/questions')).total, 1);
  const { questionBanks: _omitted, ...old } = backup; const oldTarget = await fixture(t);
  result(await oldTarget.inject({ method: 'POST', url: '/api/import', payload: { data: old, mode: 'merge' } })); assert.deepEqual(result(await oldTarget.inject('/api/question-banks')), []);
  const bad = { ...backup, questions: [...backup.questions, minimal('rollback-new')], questionBanks: [{ ...backup.questionBanks[0], questionIds: ['absent'] }] };
  const empty = await fixture(t); result(await empty.inject({ method: 'POST', url: '/api/import', payload: { data: bad, mode: 'merge' } }), 404);
  assert.equal(result(await empty.inject('/api/questions?status=all')).total, 0); assert.deepEqual(result(await empty.inject('/api/question-banks')), []);
  result(await empty.inject({ method: 'POST', url: '/api/import', payload: { data: { ...backup, questionBanks: [backup.questionBanks[0], backup.questionBanks[0]] }, mode: 'merge' } }), 400);
});

test('deleting a bank preserves saved paper and attempt snapshots and detaches the obsolete filter', async t => {
  const app = await fixture(t); await approved(app, 'ready'); await bank(app, 'temporary', ['ready']);
  const paper = result(await app.inject({ method: 'POST', url: '/api/papers', payload: { title: '固定快照', mode: 'random', count: 1, filters: { bankId: 'temporary' }, scoring: { enabled: false } } }), 201);
  const attempt = result(await app.inject({ method: 'POST', url: `/api/papers/${paper.id}/attempts` }), 201);
  result(await app.inject({ method: 'DELETE', url: '/api/question-banks/temporary' }));
  const after = result(await app.inject('/api/papers/' + paper.id)); assert.deepEqual(after.questionIds, paper.questionIds); assert.equal(after.version, paper.version); assert.equal(after.filters.bankId, undefined);
  assert.deepEqual(result(await app.inject('/api/attempts/' + attempt.id)), attempt);
  assert.equal(result(await app.inject('/api/questions/ready')).status, 'published');
  const target = await fixture(t); result(await target.inject({ method: 'POST', url: '/api/import', payload: { data: result(await app.inject('/api/export')), mode: 'merge' } }));
  assert.deepEqual(result(await target.inject('/api/papers/' + paper.id)).questionIds, paper.questionIds);
});
