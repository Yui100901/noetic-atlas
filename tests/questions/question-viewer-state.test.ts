import assert from 'node:assert/strict';
import test from 'node:test';
import type { Question } from '../../shared/models/types.js';
import { matchesQuestionSnapshot } from '../../web/features/questions/question-viewer-state.js';

const question = (): Question => ({ id: 'q', title: 'HTTP 缓存', type: 'single_choice', stemMarkdown: '选择正确描述。', options: [{ key: 'A', text: '浏览器缓存' }, { key: 'B', text: '数据库缓存' }], correctAnswers: ['A'], answerMarkdown: 'A', explanationMarkdown: '原解析', categoryIds: [], tagIds: [], difficulty: 1, depth: 2, frequency: 3, frequencyScope: '', frequencyBasis: '', collection: 'general', status: 'published', sourceRefs: [], sourceDocument: null, sourceAnchor: null });

test('AI source tools may share unchanged snapshot content despite independent study updates', () => {
  const snapshot = question();
  const live = { ...question(), updatedAt: '2026-10-23', study: { questionId: 'q', favorite: true, mastery: 3, notes: '自己的笔记', nextReviewAt: null, lastReviewedAt: null, wrongCount: 0 } };
  assert.equal(matchesQuestionSnapshot(snapshot, live), true);
});

test('do not explain immutable set snapshots with changed live answers, options, or material', () => {
  const snapshot = question();
  const changed: Question[] = [
    { ...question(), correctAnswers: ['B'] },
    { ...question(), explanationMarkdown: '修改后的解析' },
    { ...question(), stemMarkdown: '另一个问题' },
    { ...question(), options: [{ key: 'A', text: '新选项' }, { key: 'B', text: '数据库缓存' }] },
    { ...question(), sourceRefs: [{ label: '更换资料', url: 'https://example.com' }] },
  ];
  for (const current of changed) assert.equal(matchesQuestionSnapshot(snapshot, current), false);
  assert.equal(snapshot.explanationMarkdown, '原解析');
  assert.deepEqual(snapshot.correctAnswers, ['A']);
});

test('fill blank aliases and combination subquestion answers are part of snapshot identity', () => {
  const fill = { ...question(), type: 'fill_blank' as const, blanks: [{ id: 'b1', label: '协议', answers: ['HTTP'], caseSensitive: false, trim: true }] };
  assert.equal(matchesQuestionSnapshot(fill, { ...fill, blanks: [{ ...fill.blanks[0], answers: ['HTTPS'] }] }), false);
  const group = { ...question(), type: 'group' as const, parts: [{ id: 'p1', title: '小题', type: 'short_answer' as const, stemMarkdown: '为什么', options: [], correctAnswers: [], answerMarkdown: '原答案', explanationMarkdown: '原解析' }] };
  assert.equal(matchesQuestionSnapshot(group, { ...group, parts: [{ ...group.parts[0], answerMarkdown: '新答案' }] }), false);
});
