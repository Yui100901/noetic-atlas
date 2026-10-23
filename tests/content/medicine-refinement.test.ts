import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validatePack } from '../../scripts/content/manage.js';
import { planMedicineRefinement } from '../../scripts/content/medicine/refinement.js';
import { enrichKnowledgePack, OUTDATED_TAG, OBSOLETE_TAG } from '../../shared/questions/knowledge-tags.js';

function fixture() {
  const pack = validatePack(JSON.parse(readFileSync('tests/fixtures/driving-content.json', 'utf8')));
  const category = { ...pack.categories[0], id: 'medical', domainId: 'medicine-pharmacy' };
  const question = { ...pack.questions[0], id: 'MED-DRUG-000001', categoryIds: ['medical'],
    tagIds: ['med-pharm-source-review'], stemMarkdown: '介绍阿司匹林的机制。',
    explanationMarkdown: '具体机制、相互作用及来源。', sourceRefs: [{ label: '已核验来源', url: 'https://example.org/source' }] };
  return { pack, category, question };
}

test('stable medical concepts and statistical thresholds receive no blanket validity warning', () => {
  const { pack, category, question } = fixture();
  const inputs = [
    { ...question, id: 'TERM-MED-homeostasis', title: '稳态' },
    { ...question, id: 'TERM-MEDCL-sensitivity', title: '敏感度与阈值', stemMarkdown: '阈值如何影响敏感度和特异度？' },
    { ...question, title: '药理机制与警示、禁忌' },
  ];
  const tagged = enrichKnowledgePack({ ...pack, categories: [category], tags: [], questions: inputs.map(q => ({ ...q, tagIds: [] })) });
  assert.ok(tagged.questions.every(q => !q.tagIds.includes(OUTDATED_TAG)));
  assert.deepEqual(enrichKnowledgePack(tagged), tagged);
});

test('explicit medical validity tags remain under ordinary enrichment', () => {
  const { pack, category, question } = fixture();
  const tagged = enrichKnowledgePack({ ...pack, categories: [category], tags: [], questions: [{ ...question, tagIds: [OUTDATED_TAG, OBSOLETE_TAG] }] });
  assert.ok(tagged.questions[0].tagIds.includes(OUTDATED_TAG));
  assert.ok(tagged.questions[0].tagIds.includes(OBSOLETE_TAG));
});

test('catalog refinement changes only the reviewed explanation and legacy tag, and is idempotent', () => {
  const { category, question } = fixture();
  const previous = { ...question, tagIds: [...question.tagIds, OUTDATED_TAG], explanationMarkdown: '机制。重复分子式模板。' };
  const local = { ...previous, status: 'published' as const, tagIds: [...previous.tagIds, 'my-reading-tag'] };
  const result = planMedicineRefinement([local], [previous], [question], [category]);
  assert.equal(result.changed.length, 1);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.changed[0], { ...local, explanationMarkdown: question.explanationMarkdown, tagIds: ['med-pharm-source-review', 'my-reading-tag'] });
  assert.deepEqual(planMedicineRefinement(result.changed, [previous], [question], [category]), { changed: [], skipped: [] });
});

test('refinement protects local edits, confirmed obsolete evidence, unknown questions and nonmedical chemistry', () => {
  const { category, question } = fixture();
  const previous = { ...question, tagIds: [...question.tagIds, OUTDATED_TAG] };
  for (const local of [
    { ...previous, answerMarkdown: '用户补充的内容。' },
    { ...previous, tagIds: [...previous.tagIds, OBSOLETE_TAG] },
  ]) {
    const result = planMedicineRefinement([local], [previous], [question], [category]);
    assert.equal(result.changed.length, 0); assert.equal(result.skipped.length, 1);
  }
  const unknown = { ...previous, id: 'USER-MED-1', explanationMarkdown: '为什么同分异构体的分子式相同？' };
  assert.deepEqual(planMedicineRefinement([unknown], [previous], [question], [category]), { changed: [], skipped: [] });
  assert.throws(() => planMedicineRefinement([previous], [previous], [question], [{ ...category, domainId: 'chemistry' }]));
});

test('refinement rejects source revisions that change answers, sources or unrelated tags', () => {
  const { category, question } = fixture();
  for (const revised of [
    { ...question, answerMarkdown: '不同答案' },
    { ...question, sourceRefs: [] },
    { ...question, tagIds: [] },
    { ...question, tagIds: [...question.tagIds, OUTDATED_TAG] },
  ]) assert.throws(() => planMedicineRefinement([question], [question], [revised], [category]));
  assert.throws(() => planMedicineRefinement([], [question], [], [category]));
});
