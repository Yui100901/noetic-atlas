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
  const app = await fixture(t); await approved(app, 'existing');
  const conflict = result(await bulk(app, [minimal('must-rollback'), minimal('existing')]), 409);
  assert.equal(conflict.error.code, 'ID_EXISTS'); result(await app.inject('/api/questions/must-rollback'), 404);
  assert.equal(result(await app.inject('/api/questions/existing')).status, 'published');
  result(await bulk(app, [minimal('duplicate'), minimal('duplicate')]), 400);
  result(await bulk(app, [minimal('valid'), minimal('invalid', { tagIds: ['missing-tag'] })]), 400);
  result(await app.inject('/api/questions/valid'), 404);
  result(await bulk(app, [minimal('unexpected', { study: { mastery: 3 } })]), 400);
  result(await bulk(app, [minimal('bad-choice', { type: 'single_choice', options: [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }], correctAnswers: ['C'] })]), 400);
  result(await bulk(app, Array.from({ length: 501 }, () => minimal())), 400);
  result(await bulk(app, [minimal('missing-bank')], 'absent'), 400); result(await app.inject('/api/questions/missing-bank'), 404);
  const success = result(await bulk(app, [minimal('incoming-published', { status: 'published' }), minimal('incoming-draft', { status: 'draft' })]), 201);
  assert.ok(success.items.every((q: any) => q.status === 'pending'));
});

test('new custom question IDs cannot collide with UI or template routes and rejected batches remain atomic', async t => {
  const app = await fixture(t);
  for (const reserved of ['new', 'review', 'import', 'import-template']) {
    const single = result(await app.inject({ method: 'POST', url: '/api/questions', payload: minimal(reserved) }), 400);
    assert.equal(single.error.code, 'QUESTION_ID_RESERVED');
    const batch = result(await bulk(app, [minimal('rollback-' + reserved), minimal(reserved)]), 400);
    assert.equal(batch.error.code, 'QUESTION_ID_RESERVED');
    result(await app.inject('/api/questions/rollback-' + reserved), 404);
  }
  assert.equal(result(await app.inject('/api/questions?status=all')).total, 0);
  const single = result(await app.inject({ method: 'POST', url: '/api/questions', payload: minimal('MY-CUSTOM-001') }), 201);
  const batch = result(await bulk(app, [minimal('MY-CUSTOM-002')]), 201);
  assert.equal(single.status, 'pending'); assert.equal(batch.items[0].status, 'pending');
  assert.equal(result(await app.inject('/api/questions/MY-CUSTOM-001')).id, single.id);
  assert.equal(result(await app.inject('/api/questions/MY-CUSTOM-002')).id, batch.items[0].id);
  assert.equal(result(await app.inject('/api/questions/import-template')).format, 'learning-new-questions');
});

test('removed collection CRUD is absent, and obsolete filters cannot silently broaden new requests', async t => {
  const app = await fixture(t);
  for (const method of ['GET', 'POST', 'PUT', 'DELETE'] as const) result(await app.inject({method, url: '/api/question-banks' + (method === 'PUT' || method === 'DELETE' ? '/old' : ''), ...(method === 'POST' || method === 'PUT' ? {payload: {name: 'old', questionIds: []}} : {})}), 404);
  result(await app.inject('/api/questions?bankId=old'), 400);
  result(await app.inject({method: 'POST',url: '/api/papers/preview',payload: {title:'obsolete',mode:'random',count:1,filters:{bankId:'old'}}}),400);
});
