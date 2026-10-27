import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../server/core/store.js';
import { questionSchema } from '../../server/core/validation.js';
import type { Question } from '../../shared/models/types.js';
import { validatePack } from '../../scripts/content/manage.js';
import { applyKnowledgeExpansion, conceptSourceFingerprint } from '../../scripts/content/apply-knowledge-expansion.js';

function fixture(t: test.TestContext) {
  const store = new Store(':memory:'); t.after(() => store.db.close());
  const domain = { id: 'economics', name: '经济学', description: '', sortOrder: 0 };
  const category = { id: 'econ', name: '经济概念', domainId: domain.id, parentId: null, description: '', sortOrder: 0 };
  const tags = ['topic', 'user-tag'].map(id => ({ id, name: id, domainId: domain.id, kind: 'topic', color: '#123456', description: '' }));
  store.put('domains', domain.id, domain); store.put('categories', category.id, category); for (const tag of tags) store.put('tags', tag.id, tag);
  const old = { ...questionSchema.parse({ id: 'OLD', title: '沉没成本', type: 'short_answer', stemMarkdown: '沉没成本', answerMarkdown: '已发生且无法收回的支出。', explanationMarkdown: '决策只比较可改变的未来后果。', categoryIds: ['econ'], tagIds: ['topic'], sourceRefs: [{ label: 'OpenStax', url: 'https://openstax.org/' }], status: 'published' }), id: 'OLD' } as Question;
  store.put('questions', old.id, old);
  const newQuestion = { ...old, id: 'NEW', title: '新概念', stemMarkdown: '新概念', status: 'pending' };
  const pack = validatePack({ schemaVersion: 1, domains: [domain], categories: [category], tags, questions: [newQuestion], documents: [], papers: [] });
  const supplement = { format: 'noetic-atlas-concept-supplement' as const, schemaVersion: 1 as const, generatedAt: new Date().toISOString(), questions: [{ id: old.id, sourceFingerprint: conceptSourceFingerprint(old), concept: { term: '沉没成本', meaningPrompt: '已经发生且无论之后选择如何均无法收回的支出', acceptedAnswers: ['沉没成本'] } }] };
  return { store, old, pack, supplement };
}

/** Models a second local service committing just before this process begins
 * its maintenance transaction; it must not be overwritten by a stale preload. */
function injectBeforeTransaction(store: Store, operation: () => void) {
  const original = store.transaction.bind(store); let first = true;
  store.transaction = <T,>(run: () => T): T => { if (first) { first = false; operation(); } return original(run); };
}

test('metadata expansion preserves publication, taxonomy and sources committed immediately before transaction', t => {
  const f = fixture(t);
  const latest = { ...f.old, status: 'draft' as const, tagIds: ['topic', 'user-tag'], sourceRefs: [...f.old.sourceRefs, { label: '用户补充', url: 'https://example.org/new-source' }], updatedAt: '2026-10-26T16:00:00.000Z' };
  injectBeforeTransaction(f.store, () => f.store.put('questions', 'OLD', latest));
  const result = applyKnowledgeExpansion(f.store, [f.pack], f.supplement);
  assert.equal(result.conceptMetadataUpdated, 1);
  const actual = f.store.require<Question>('questions', 'OLD');
  const { concept: _concept, updatedAt: _stamp, ...content } = actual;
  const { updatedAt: _oldStamp, ...expected } = latest;
  assert.deepEqual(content, expected); assert.equal(actual.concept!.term, '沉没成本');
});

test('a newly committed source edit aborts before adding any new content instead of restoring the old answer', t => {
  const f = fixture(t), latest = { ...f.old, answerMarkdown: '用户刚修改的答案，应保留并重新核查元数据。' };
  injectBeforeTransaction(f.store, () => f.store.put('questions', 'OLD', latest));
  assert.throws(() => applyKnowledgeExpansion(f.store, [f.pack], f.supplement), /source changed/i);
  assert.deepEqual(f.store.require('questions', 'OLD'), latest); assert.equal(f.store.get('questions', 'NEW'), undefined);
});

test('a deleted source cannot be resurrected by a stale metadata preload', t => {
  const f = fixture(t); injectBeforeTransaction(f.store, () => f.store.remove('questions', 'OLD'));
  assert.throws(() => applyKnowledgeExpansion(f.store, [f.pack], f.supplement), /记录不存在|source|not found/i);
  assert.equal(f.store.get('questions', 'OLD'), undefined); assert.equal(f.store.get('questions', 'NEW'), undefined);
});

test('learning committed before the maintenance transaction is the protected baseline, not a false mutation by expansion', t => {
  const f = fixture(t), state = { ...f.store.study('OLD'), notes: '用户刚保存的学习笔记', favorite: true };
  injectBeforeTransaction(f.store, () => f.store.putStudy(state));
  const result = applyKnowledgeExpansion(f.store, [f.pack], f.supplement);
  assert.equal(result.protectedRecordsUnchanged, true); assert.deepEqual(f.store.study('OLD'), state);
});
