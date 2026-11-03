import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../../server/core/store.js';
import { questionSchema } from '../../server/core/validation.js';
import {
  buildPaper,
  createAttempt,
  submitAttempt,
  attemptView,
  paperMarkdown,
} from '../../server/modules/practice/service.js';
import {
  paperExportDocument,
  attemptExportDocument,
} from '../../server/modules/transfer/exports.js';
import { questionHistory } from '../../server/modules/questions/history.js';
import { reverseCardGradingRequirements } from '../../shared/questions/directional-grading.js';
import type { Question } from '../../shared/models/types.js';

test('directional standards use frozen card rules and stay absent from active views and blank exports', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.database.close());
  const word = questionSchema.parse({
    id: 'WORD',
    title: 'atlas',
    type: 'short_answer',
    stemMarkdown: '解释atlas的含义。',
    answerMarkdown: '地图集。',
    gradingRequirements: '- 释义：地图集。',
    status: 'published',
    vocabulary: {
      language: 'en',
      headword: 'atlas',
      meaningPrompt: '收录地理图幅的图书',
      acceptedAnswers: ['atlas'],
      pronunciations: [
        {
          label: '英式',
          ipa: '/ˈætləs/',
          sourceLabel: 'fixture',
          sourceUrl: 'https://example.test/atlas',
          license: 'fixture',
          method: 'manual',
        },
      ],
    },
  }) as Question;
  const concept = questionSchema.parse({
    id: 'CONCEPT',
    title: '沉没成本',
    type: 'short_answer',
    stemMarkdown: '解释沉没成本。',
    answerMarkdown: '已经发生且无法收回的支出。',
    gradingRequirements: '- 已经发生；当前决策无法收回。',
    status: 'published',
    concept: {
      term: '沉没成本',
      meaningPrompt: '已经发生且无法收回的支出',
      acceptedAnswers: ['沉没成本', 'sunk cost'],
    },
  }) as Question;
  for (const q of [word, concept]) store.put('questions', q.id, q);
  for (const [q, kind] of [
    [word, 'vocabulary'],
    [concept, 'concept'],
  ] as const) {
    const paper = buildPaper(store, {
      title: '双向核对',
      description: '',
      mode: 'manual',
      questionIds: [q.id],
      practiceKind: kind,
      scoring: { enabled: false },
    });
    store.put('papers', paper.id, paper);
    const blank = paperExportDocument(paper, 'blank');
    assert.equal(blank.questions[0]!.gradingRequirements, undefined);
    assert.equal(blank.questions[0]!.reverseGradingRequirements, undefined);
    assert.doesNotMatch(blank.markdown, /匹配规则|可接受答案/);
    assert.match(paperMarkdown(paper, true), /正向判题标准/);
    assert.match(paperMarkdown(paper, true), /逆向判题规则/);
    assert.doesNotMatch(paperMarkdown(paper, false), /匹配规则|逆向判题规则|正向判题标准/);
    const reference = paperExportDocument(paper, 'answers');
    assert.match(reference.markdown, /正向判题标准/);
    assert.match(reference.markdown, /逆向判题规则/);
    const forward = createAttempt(store, paper, { vocabularyDirection: 'word_to_meaning' });
    submitAttempt(store, forward, { [q.id]: { value: '有效解释' } });
    const forwardDocument = attemptExportDocument(forward);
    assert.match(forwardDocument.markdown, /正向判题标准/);
    assert.doesNotMatch(forwardDocument.markdown, /逆向判题规则/);
    const reverse = createAttempt(store, paper, { vocabularyDirection: 'meaning_to_word' });
    assert.equal(reverseCardGradingRequirements(attemptView(reverse).questions[0]), '');
    const accepted = q.vocabulary?.acceptedAnswers[0] || q.concept!.acceptedAnswers[1]!;
    submitAttempt(store, reverse, { [q.id]: { value: [' ' + accepted.toUpperCase() + ' '] } });
    const before = reverseCardGradingRequirements(attemptView(reverse).questions[0]);
    assert.ok(before);
    assert.equal(attemptView(reverse).answerStates![q.id], 'correct');
    store.put('questions', q.id, {
      ...q,
      gradingRequirements: '后来修改的正向标准',
      ...(q.vocabulary
        ? { vocabulary: { ...q.vocabulary, acceptedAnswers: ['new-spelling'] } }
        : { concept: { ...q.concept!, acceptedAnswers: ['新的名称'] } }),
    });
    const document = attemptExportDocument(reverse);
    assert.equal(document.questions[0]!.reverseGradingRequirements, before);
    assert.match(document.markdown, /逆向判题规则/);
    assert.doesNotMatch(document.markdown, /正向判题标准|new-spelling|新的名称/);
    const history = questionHistory(store, q.id, { page: 1, pageSize: 10 }).items.find(
      (item) => item.attemptId === reverse.id,
    )!;
    assert.equal(reverseCardGradingRequirements(history.question), before);
  }
});
