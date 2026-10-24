import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyFilters, normalizePaperFilters, normalizeQuestionFilters } from '../../web/shared/lib/learning-filters.js';

test('retired collection filters are removed when restoring a question selection draft', () => {
  const restored = normalizeQuestionFilters({
    ...emptyFilters, bankId: 'retired-bank', domainId: 'english', categoryId: 'grammar',
    tagIds: ['past-tense', 4], favorite: true, wrong: 'yes',
  });
  assert.equal('bankId' in restored, false);
  assert.equal(restored.domainId, 'english');
  assert.equal(restored.categoryId, 'grammar');
  assert.deepEqual(restored.tagIds, ['past-tense']);
  assert.equal(restored.favorite, true);
  assert.equal(restored.wrong, false);
});

test('random and AI selection retain supported constraints while discarding retired collection constraints', () => {
  assert.deepEqual(normalizePaperFilters({
    bankId: 'retired-bank', domainId: 'computer', categoryId: '',
    tagIds: ['go'], tagMode: 'any', types: ['single_choice', 'short_answer'],
    difficultyMin: 1, difficultyMax: 3, frequencyMin: 0, collection: 'general',
    arbitrary: 'not-a-selection-field',
  }), {
    tagIds: ['go'], tagMode: 'any', domainId: 'computer', types: ['single_choice', 'short_answer'],
    difficultyMin: 1, difficultyMax: 3, frequencyMin: 0, collection: 'general',
  });
});

test('new selection state has no implicit collection constraint', () => {
  assert.equal('bankId' in emptyFilters, false);
  assert.deepEqual(normalizePaperFilters(), {});
  assert.deepEqual(normalizeQuestionFilters(), emptyFilters);
});
