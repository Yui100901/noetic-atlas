import test from 'node:test';
import assert from 'node:assert/strict';
import type { AiDocumentBlock } from '../../shared/ai/ai-document.js';
import { documentFilesDraft, documentPreviewDraft, previewDraftEdit, previewDraftMatches } from '../../web/features/ai/ai-document-draft-state.js';

const block: AiDocumentBlock = { id: 'chapter-1', sourceName: '教材', label: '第一章', characters: 100, title: '事务', summary: '原子性', topics: ['事务'], planStatus: 'completed', generationStatus: 'completed', planAttempts: 1, generationAttempts: 1, generationRunId: 'generation-1', questions: [{ title: '什么是事务', type: 'short_answer', stemMarkdown: '说明事务的含义。', answerMarkdown: '整体执行的一组操作。' }], importedQuestionIds: [] };

test('extracted document drafts restore original source text and page boundaries without file handles', () => {
  const value = { sections: [{ text: '  code();\n\n中文😀', label: '第2–3页', sourceName: '课本.pdf', pageStart: 2, pageEnd: 3 }], sourceName: '课本.pdf', characters: 14, bytes: 25, files: 1, pages: 2, warnings: ['第4页无正文'] };
  assert.deepEqual(documentFilesDraft(value), value);
  assert.equal(documentFilesDraft(null), null);
  assert.equal(documentFilesDraft({ sections: [{ text: 123 }] }), null);
});

test('manual preview drafts apply only to the same unimported immutable generation', () => {
  const edit = previewDraftEdit({ json: '[{"title":"未写完', selected: [0] }, block);
  assert.equal(previewDraftMatches(edit, structuredClone(block)), true);
  assert.equal(previewDraftMatches(edit, { ...block, generationRunId: 'generation-2' }), false);
  assert.equal(previewDraftMatches(edit, { ...block, questions: [{ ...block.questions[0], answerMarkdown: '已修改答案' }] }), false);
  assert.equal(previewDraftMatches(edit, { ...block, importedQuestionIds: ['QUESTION-1'] }), false);
  assert.equal(previewDraftMatches(edit), false);
  assert.equal(previewDraftMatches({ ...edit, baseQuestions: '' }, block), false);
  assert.equal(edit.json, '[{"title":"未写完');
  assert.deepEqual(edit.selected, [0]);
});

test('preview restoration preserves incomplete JSON but cannot mutate object prototypes', () => {
  const value = JSON.parse('{"chapter-1":{"json":"unfinished {","selected":[0,2,-1,1.5,"3"],"baseQuestions":"[]","baseRunId":"generation-1"},"__proto__":{"json":"kept literally","selected":[]}}');
  const restored = documentPreviewDraft(value);
  assert.equal(Object.getPrototypeOf(restored), null);
  assert.deepEqual(restored['chapter-1'], { json: 'unfinished {', selected: [0, 2], baseQuestions: '[]', baseRunId: 'generation-1' });
  assert.equal(restored.__proto__.json, 'kept literally');
  assert.equal(({} as { json?: string }).json, undefined);
});
