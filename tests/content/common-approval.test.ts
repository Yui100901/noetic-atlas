import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../server/core/store.js';
import { questionSchema } from '../../server/core/validation.js';
import { validatePack } from '../../scripts/content/manage.js';
import { planCommonApproval, applyCommonApproval } from '../../scripts/content/common-2026-10/apply-common.js';

function fixture(t: test.TestContext) {
  const store = new Store(':memory:'); t.after(() => store.db.close());
  const domain = { id: 'testing-common', name: '测试领域', description: '', sortOrder: 1 };
  const category = { id: 'testing-common-category', domainId: domain.id, parentId: null, name: '基础', description: '', sortOrder: 1 };
  const tag = { id: 'testing-common-topic', domainId: domain.id, kind: 'topic', name: '基础', color: '#123456', description: '' };
  const question = questionSchema.parse({ id: 'PREVIOUS', title: '旧批题', type: 'true_false', stemMarkdown: '旧批断言', answerMarkdown: '正确', explanationMarkdown: '旧批解释保持原样', correctAnswers: ['true'], categoryIds: [category.id], tagIds: [tag.id], sourceRefs: [{ label: '来源', url: 'https://example.org/foundation' }], status: 'pending', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' });
  store.put('domains', domain.id, domain); store.put('categories', category.id, category); store.put('tags', tag.id, tag); store.put('questions', 'PREVIOUS', question);
  store.put('questions', 'UNRELATED', { ...question, id: 'UNRELATED', title: '用户另建题' });
  store.putStudy({ questionId: 'PREVIOUS', favorite: true, mastery: 2, notes: '个人笔记', nextReviewAt: null, lastReviewedAt: null, wrongCount: 1 });
  const pack = validatePack({ schemaVersion: 1, domains: [domain], categories: [category], tags: [tag], questions: [{ ...question, id: 'NEW', title: '新批题', stemMarkdown: '新批断言' }], documents: [], papers: [], assets: [], questionBanks: [] });
  return { store, question, pack };
}
test('common approval publishes only authorized batches and preserves local edits, notes and unrelated pending items', t => {
  const { store, question, pack } = fixture(t);
  store.put('questions', 'PREVIOUS', { ...question, explanationMarkdown: '用户后来修订的解释' });
  const study = store.study('PREVIOUS');
  assert.deepEqual(planCommonApproval(store, [pack], ['PREVIOUS']).counts, { add: 1, approve: 2, published: 0, targets: 2 });
  assert.equal(store.get('questions', 'NEW'), undefined);
  const result = applyCommonApproval(store, [pack], ['PREVIOUS']); assert.equal(result.approved, 2);
  assert.equal(store.require<any>('questions', 'PREVIOUS').explanationMarkdown, '用户后来修订的解释');
  assert.equal(store.require<any>('questions', 'NEW').status, 'published'); assert.equal(store.require<any>('questions', 'UNRELATED').status, 'pending');
  assert.deepEqual(store.study('PREVIOUS'), study);
  assert.equal(applyCommonApproval(store, [pack], ['PREVIOUS']).approved, 0);
});
test('missing, archived and colliding targets fail before import; invalid references roll back the entire batch', t => {
  const { store, question, pack } = fixture(t);
  assert.throws(() => applyCommonApproval(store, [pack], ['MISSING']), /missing/); assert.equal(store.get('questions', 'NEW'), undefined);
  store.put('questions', 'PREVIOUS', { ...question, status: 'archived' });
  assert.throws(() => applyCommonApproval(store, [pack], ['PREVIOUS']), /archived/); assert.equal(store.get('questions', 'NEW'), undefined);
  store.put('questions', 'PREVIOUS', { ...question, collection: 'personal' });
  assert.throws(() => applyCommonApproval(store, [pack], ['PREVIOUS']), /personal/); assert.equal(store.get('questions', 'NEW'), undefined);
  store.put('questions', 'PREVIOUS', question);
  store.put('questions', 'NEW', { ...pack.questions[0], stemMarkdown: '同题号的不同本地内容' });
  assert.throws(() => applyCommonApproval(store, [pack], ['PREVIOUS']), /不同内容/);
  store.remove('questions', 'NEW');
  store.put('questions', 'PREVIOUS', { ...question, categoryIds: ['BROKEN'] });
  assert.throws(() => applyCommonApproval(store, [pack], ['PREVIOUS'])); assert.equal(store.get('questions', 'NEW'), undefined);
  assert.equal(store.require<any>('questions', 'PREVIOUS').status, 'pending');
});
