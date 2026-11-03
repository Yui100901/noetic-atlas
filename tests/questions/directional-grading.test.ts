import assert from 'node:assert/strict';
import test from 'node:test';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { getObjectiveCorrect } from '../../shared/questions/question-utils.js';
import {
  reverseCardGradingRequirements,
  forwardCardGradingTitle,
  reverseCardGradingTitle,
} from '../../shared/questions/directional-grading.js';

test('reverse English aliases describe literal matching rather than semantic synonyms', () => {
  const q = {
    type: 'fill_blank' as const,
    vocabulary: { headword: 'atlas', acceptedAnswers: ['live-source-only'] },
    blanks: [{ id: 'word', label: '', answers: ['atlas'], trim: true, caseSensitive: false }],
  };
  const rule = reverseCardGradingRequirements(q);
  assert.match(rule, /`atlas`/);
  assert.doesNotMatch(rule, /live-source-only/);
  assert.match(rule, /去掉首尾空白/);
  assert.match(rule, /字母转小写/);
  assert.match(rule, /词内空白不合并/);
  assert.match(rule, /不转换全角／半角/);
  assert.match(rule, /未列出的同义词、其他词形不自动判对/);
  for (const value of ['atlas', ' ATLAS '])
    assert.equal(getObjectiveCorrect(q, { value: [value] }), true);
  for (const value of ['map', 'at las', 'ａｔｌａｓ', 'atlases', ''])
    assert.equal(getObjectiveCorrect(q, { value: [value] }), false);
});

test('concept aliases and per-snapshot case/whitespace flags stay precise', () => {
  const q = {
    type: 'short_answer',
    concept: { term: '沉没成本', acceptedAnswers: ['沉没成本', 'sunk cost'] },
  };
  const defaultRule = reverseCardGradingRequirements(q);
  assert.match(defaultRule, /`沉没成本`、`sunk cost`/);
  assert.match(defaultRule, /未列出的别称或近义概念不自动判对/);
  const reverse = {
    ...q,
    type: 'fill_blank' as const,
    blanks: [{ id: 'term', label: '', answers: ['Sunk Cost'], trim: false, caseSensitive: true }],
  };
  const snapshotRule = reverseCardGradingRequirements(reverse);
  assert.match(snapshotRule, /保留首尾空白，区分大小写/);
  assert.doesNotMatch(snapshotRule, /`沉没成本`、/);
  assert.equal(getObjectiveCorrect(reverse, { value: ['Sunk Cost'] }), true);
  for (const value of [' Sunk Cost ', 'sunk cost', 'Sunk  Cost'])
    assert.equal(getObjectiveCorrect(reverse, { value: [value] }), false);
  assert.match(forwardCardGradingTitle(q), /看概念写释义/);
  assert.match(reverseCardGradingTitle(q), /看描述写概念/);
});

test('aliases containing Markdown, quotes and control whitespace cannot introduce empty or broken lists', () => {
  const aliases = ['C++', 'O(n)', '*', '[x]', '`', 'a``b', 'quote"', 'line\nname', '\tterm'];
  const markdown = reverseCardGradingRequirements({
    type: 'short_answer',
    vocabulary: { headword: 'C++', acceptedAnswers: aliases },
  });
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as any;
  assert.doesNotMatch(markdown, /`\"C\+\+\"`/);
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0].type, 'list');
  assert.equal(tree.children[0].children.length, 4);
  const inline: string[] = [];
  const visit = (node: any) => {
    if (node.type === 'inlineCode') inline.push(node.value);
    for (const child of node.children || []) visit(child);
  };
  visit(tree);
  for (const value of aliases)
    assert.ok(
      inline.includes(
        value.replace(/[\u0000-\u001f\u007f]/g, (character) =>
          JSON.stringify(character).slice(1, -1),
        ),
      ),
      value,
    );
  assert.equal(
    reverseCardGradingRequirements({
      type: 'fill_blank',
      vocabulary: { headword: 'secret', acceptedAnswers: ['secret'] },
      blanks: [{ trim: true, caseSensitive: false }],
    }),
    '',
  );
  assert.equal(
    reverseCardGradingRequirements({
      type: 'group',
      vocabulary: { headword: 'wrong', acceptedAnswers: ['wrong'] },
    }),
    '',
  );
});
