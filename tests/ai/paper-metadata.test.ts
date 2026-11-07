import test from 'node:test';
import assert from 'node:assert/strict';
import { paperMetadataForCount } from '../../shared/ai/paper-metadata.js';

test('whole-paper count normalization preserves proficiency levels and unrelated facts', () => {
  const result = paperMetadataForCount(
    { title: '日语常用词50题（N5→N1）', description: '本批选50道常用词汇题，N5→N1。' },
    200,
    { providerBatch: true },
  );
  assert.equal(result.title, '日语常用词200题（N5→N1）');
  assert.match(result.description, /200道题目/);
  assert.doesNotMatch(result.description, /本批|50/);
  assert.equal(result.adjusted, true);
  assert.deepEqual(
    paperMetadataForCount(
      { title: 'N5到N1词汇基础', description: '2025年教材，第50章，正确率80%。' },
      200,
    ),
    { title: 'N5到N1词汇基础', description: '2025年教材，第50章，正确率80%。', adjusted: false },
  );
});

test('selected question changes update only explicit count phrases in preview metadata', () => {
  const result = paperMetadataForCount(
    { title: '日语200题（N5→N1）', description: '包含200道题目；参考第50章。' },
    175,
  );
  assert.equal(result.title, '日语175题（N5→N1）');
  assert.equal(result.description, '包含175道题目；参考第50章。');
});

test('changing a selection total preserves a different subset count in the description', () => {
  const result = paperMetadataForCount(
    { title: '共200题（其中50题阶段复习）', description: '本题集200题，其中50题用于阶段复习。' },
    175,
    { previousCount: 200 },
  );
  assert.equal(result.description, '本题集175题，其中50题用于阶段复习。');
  assert.equal(result.title, '共175题（其中50题阶段复习）');
});
