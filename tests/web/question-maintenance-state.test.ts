import test from 'node:test';
import assert from 'node:assert/strict';
import { questionSchema } from '../../server/core/validation.js';
import type { QuestionInput } from '../../shared/models/types.js';
import {
  questionContentDifferences,
  questionDiffExcerpt,
  questionDraftForm,
  questionDraftSignature,
  questionRevisionForm,
} from '../../web/features/questions/question-maintenance-state.js';

const form = (): QuestionInput =>
  questionSchema.parse({
    id: 'Q',
    type: 'short_answer',
    title: '当前题',
    stemMarkdown: '题干',
    status: 'published',
  });
test('editing drafts exclude identity and learning data while preserving incomplete authoring and raw sources', () => {
  const original = {
    ...form(),
    title: '',
    stemMarkdown: '',
    options: [{ key: 'A', text: '' }],
    study: { notes: 'private' },
    updatedAt: 'not-authoring',
  };
  const saved = questionDraftForm(original);
  assert.equal(saved.title, '');
  assert.equal(saved.options[0].text, '');
  for (const key of ['id', 'study', 'updatedAt']) assert.equal(Object.hasOwn(saved, key), false);
  assert.notEqual(
    questionDraftSignature(original, 'unfinished |', ''),
    questionDraftSignature(original, 'unfinished |', '说明'),
  );
  assert.notEqual(
    questionDraftSignature(original, 'unfinished |', ''),
    questionDraftSignature(original, 'unfinished | URL', ''),
  );
  original.options[0].text = 'later';
  assert.equal(saved.options[0].text, '');
});
test('revision load preserves current identity and admission but removes newer optional structures', () => {
  const current = {
    ...form(),
    vocabulary: {
      language: 'en' as const,
      headword: 'atlas',
      acceptedAnswers: ['atlas'],
      pronunciations: [],
      meaningPrompt: '图书',
    },
  };
  const { id: _id, status: _status, ...content } = form();
  const loaded = questionRevisionForm({ ...content, title: '旧题' }, current);
  assert.equal(loaded.id, 'Q');
  assert.equal(loaded.status, 'published');
  assert.equal(loaded.title, '旧题');
  assert.equal(loaded.vocabulary, undefined);
});
test('field differences ignore bookkeeping and object key order, but preserve array order and actual standards', () => {
  assert.deepEqual(
    questionContentDifferences(
      { id: 'Q', status: 'published', object: { a: 1, b: 2 } },
      { id: 'Z', status: 'pending', object: { b: 2, a: 1 } },
    ),
    [],
  );
  assert.deepEqual(
    questionContentDifferences(
      { gradingRequirements: '整体回滚', options: ['A', 'B'] },
      { gradingRequirements: '只需说明回滚', options: ['B', 'A'] },
    ).map((item) => item.field),
    ['gradingRequirements', 'options'],
  );
});
test('long Markdown comparison is bounded while retaining changed lines and context', () => {
  const spaced = questionDiffExcerpt('开头\n\n原文\n\n结尾', '开头\n\n修改\n\n结尾');
  assert.equal(spaced.before, '开头\n\n原文\n\n结尾');
  assert.equal(spaced.after, '开头\n\n修改\n\n结尾');
  const before = Array.from({ length: 10000 }, (_, index) => 'unchanged ' + index).join('\n');
  const after = before.replace('unchanged 5000', '新增必要条件');
  const excerpt = questionDiffExcerpt(before, after);
  assert.match(excerpt.before, /unchanged 5000/);
  assert.match(excerpt.after, /新增必要条件/);
  assert.ok(excerpt.before.length < 1000);
  assert.ok(excerpt.after.length < 1000);
  assert.match(excerpt.before, /省略/);
});
