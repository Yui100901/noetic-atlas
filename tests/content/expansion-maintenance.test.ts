import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../server/core/store.js';
import { questionSchema } from '../../server/core/validation.js';
import type { Question, VocabularyData } from '../../shared/models/types.js';
import { planVocabularySupplement, applyExpansion } from '../../scripts/content/expansion-2026-10/apply-expansion.js';

const vocabulary: VocabularyData = { language: 'en', headword: 'abandon', meaningPrompt: '放弃；遗弃', acceptedAnswers: ['abandon'], pronunciations: [{ label: '美式', ipa: '/əˈbændən/', sourceLabel: 'Test source', sourceUrl: 'https://example.org/readings', license: 'MIT', method: 'source' }] };
const patch = (v = vocabulary) => ({ format: 'noetic-atlas-vocabulary-supplement' as const, schemaVersion: 1 as const, questions: [{ id: 'EN-V-1', vocabulary: v, sourceRefsAdded: [{ label: 'Test source', url: 'https://example.org/readings' }] }] });
function fixture(t: test.TestContext) {
  const store = new Store(':memory:'); t.after(() => store.db.close());
  const question = questionSchema.parse({ id: 'EN-V-1', title: 'abandon', type: 'short_answer', stemMarkdown: '用户定制题干', answerMarkdown: '用户修改释义', explanationMarkdown: '用户修改例句', status: 'published', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z' }) as Question;
  store.put('questions', question.id!, question);
  store.putStudy({ questionId: question.id!, favorite: true, mastery: 2, notes: '个人笔记必须原样保留', nextReviewAt: null, lastReviewedAt: null, wrongCount: 3 });
  return { store, question };
}

test('vocabulary maintenance preserves user text, status, timestamps and study; repeat is idempotent', t => {
  const { store, question } = fixture(t), study = store.study(question.id!);
  const plan = planVocabularySupplement(store, patch()); assert.equal(plan.updates.length, 1);
  assert.equal(store.require<Question>('questions', question.id!).vocabulary, undefined, 'dry plan does not write');
  const result = applyExpansion(store, [], patch()); assert.equal(result.vocabularyUpdated, 1);
  const updated = store.require<Question>('questions', question.id!);
  const { vocabulary: added, sourceRefs, ...original } = updated;
  const { sourceRefs: oldSources, ...old } = question;
  assert.deepEqual(original, old); assert.deepEqual(added, vocabulary); assert.equal(sourceRefs.length, oldSources.length + 1);
  assert.deepEqual(store.study(question.id!), study);
  assert.equal(applyExpansion(store, [], patch()).vocabularyUnchanged, 1);
});

test('identity collisions, literal answer hints, duplicate IDs and existing metadata conflicts reject before writing', t => {
  const { store, question } = fixture(t);
  for (const bad of [patch({ ...vocabulary, headword: 'different' }), patch({ ...vocabulary, meaningPrompt: 'abandon' }), { ...patch(), questions: [...patch().questions, ...patch().questions] }]) assert.throws(() => applyExpansion(store, [], bad));
  assert.deepEqual(store.require<Question>('questions', question.id!), question);
  applyExpansion(store, [], patch());
  assert.throws(() => applyExpansion(store, [], patch({ ...vocabulary, meaningPrompt: '另一种个人提示' })), /differs/);
  assert.deepEqual(store.require<Question>('questions', question.id!).vocabulary, vocabulary);
});

test('Japanese identity accepts the original fixed card suffix and rejects a different word', t => {
  const { store, question } = fixture(t);
  const id = 'JA-V-1', ja: VocabularyData = { language: 'ja', headword: '学校', meaningPrompt: '供学生学习的机构', acceptedAnswers: ['学校', 'がっこう'], pronunciations: [{ label: '假名与罗马音', kana: 'がっこう', romaji: 'gakkou', sourceLabel: 'Test source', sourceUrl: 'https://example.org/readings', license: 'CC-BY-SA-4.0', method: 'transliteration' }] };
  store.put('questions', id, { ...question, id, title: '学校｜日语单词' });
  const supplement = { ...patch(), questions: [{ id, vocabulary: ja, sourceRefsAdded: [] }] };
  assert.equal(planVocabularySupplement(store, supplement).updates.length, 1);
  store.put('questions', id, { ...question, id, title: '学院｜日语单词' });
  assert.throws(() => planVocabularySupplement(store, supplement), /identity mismatch/);
});
