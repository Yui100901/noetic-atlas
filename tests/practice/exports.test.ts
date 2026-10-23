import test from 'node:test';
import assert from 'node:assert/strict';
import type { Question } from '../../shared/models/types.js';
import { Store } from '../../server/core/store.js';
import { buildPaper, createAttempt, reviewAttempt, submitAttempt } from '../../server/modules/practice/service.js';
import { attemptExportDocument, paperExportDocument } from '../../server/modules/transfer/exports.js';

function setup(scored = true) {
  const store = new Store(':memory:');
  const question = (id: string, type: Question['type']): Question => ({ id, type, title: `历史题目 ${id}`, stemMarkdown: `题干 ${id}`, answerMarkdown: `参考秘密-${id}`, explanationMarkdown: `解释秘密-${id}`, options: type === 'single_choice' ? [{ key: 'A', text: '旧选项A' }, { key: 'B', text: '旧选项B' }] : [], correctAnswers: type === 'single_choice' ? ['A'] : [], difficulty: 2, depth: 3, frequency: 3, frequencyScope: '测试', frequencyBasis: '测试', collection: 'general', status: 'published', categoryIds: [], tagIds: [], sourceRefs: [], sourceDocument: null, sourceAnchor: null });
  for (const q of [question('q-objective', 'single_choice'), question('q-subjective', 'short_answer')]) store.put('questions', q.id, q);
  const paper = buildPaper(store, { title: '历史练习卷', description: '导出回归', mode: 'manual', questionIds: ['q-objective', 'q-subjective'], scoring: scored ? { enabled: true, totalPoints: 5.5, questionPoints: { 'q-objective': 2.5, 'q-subjective': 3 } } : { enabled: false } });
  return { store, paper };
}
test('blank export omits answers in both JSON and Markdown, retains options and write-in space', () => {
  const { store, paper } = setup(); try {
    const blank = paperExportDocument(paper, 'blank'); const encoded = JSON.stringify(blank);
    assert.doesNotMatch(encoded, /参考秘密|解释秘密|correctAnswers|answerMarkdown|explanationMarkdown/);
    assert.match(blank.markdown, /答题区/); assert.match(blank.markdown, /旧选项A/); assert.match(blank.markdown, /卷面总分：5.5 分/);
    const answers = paperExportDocument(paper, 'answers'); assert.match(answers.markdown, /参考秘密-q-subjective/); assert.match(answers.markdown, /解释秘密-q-objective/);
  } finally { store.db.close(); }
});
test('completed export uses submitted history, distinguishes pending from a graded zero, and ignores later edits', () => {
  const { store, paper } = setup(); try {
    const attempt = createAttempt(store, paper);
    assert.throws(() => attemptExportDocument(attempt), /请先交卷/);
    submitAttempt(store, attempt, { 'q-objective': { value: 'A' }, 'q-subjective': { value: '历史个人回答' } });
    const current = store.require<Question>('questions', 'q-objective'); store.put('questions', current.id, { ...current, title: '后续改题', correctAnswers: ['B'] });
    paper.snapshot[0]!.title = '后续改卷'; paper.title = '后续新卷名';
    let complete = attemptExportDocument(attempt);
    assert.equal(complete.title, '历史练习卷'); assert.equal(complete.questions[0]!.title, '历史题目 q-objective');
    assert.equal(complete.questions[0]!.earnedPoints, 2.5); assert.equal(complete.questions[0]!.correct, true);
    assert.equal(complete.questions[1]!.userAnswer, '历史个人回答'); assert.equal(complete.questions[1]!.earnedPoints, null); assert.equal(complete.summary!.totalScore, null);
    assert.match(complete.markdown, /最终总分：待主观题阅卷完成/); assert.match(complete.markdown, /阅卷：待阅/);
    reviewAttempt(store, attempt, { 'q-subjective': 0 }); complete = attemptExportDocument(attempt);
    assert.equal(complete.questions[1]!.grading, 'graded'); assert.equal(complete.questions[1]!.earnedPoints, 0); assert.equal(complete.summary!.totalScore, 2.5);
    assert.match(complete.markdown, /人工阅卷：0 \/ 3 分/);
    reviewAttempt(store, attempt, { 'q-subjective': null }); assert.equal(attemptExportDocument(attempt).summary!.totalScore, null);
    attempt.answers['q-subjective']!.value = 'false';
    assert.match(attemptExportDocument(attempt).markdown, /### 我的作答\n\nfalse\n/);
  } finally { store.db.close(); }
});
test('unscored completed export reports correctness without inventing point totals', () => {
  const { store, paper } = setup(false); try {
    const attempt = createAttempt(store, paper); submitAttempt(store, attempt, { 'q-objective': { value: 'B' } });
    const complete = attemptExportDocument(attempt);
    assert.equal(complete.scoring.enabled, false); assert.equal(complete.questions[0]!.earnedPoints, null); assert.equal(complete.questions[1]!.points, null);
    assert.match(complete.markdown, /本次练习不计分/); assert.match(complete.markdown, /错误或未作答/);
    assert.doesNotMatch(complete.markdown, /最终总分|得分 0|卷面总分/);
  } finally { store.db.close(); }
});

test('learning instructions and dictionary attribution become one complete export appendix without changing stored snapshots', () => {
  const { store, paper } = setup(false); try {
    const abandon = {
      stemMarkdown:'**abandon**\n\n请回忆其英文含义、中文释义、主要词性及使用方式；可尝试先口头或书面造句，再查看释义与来源用例。',
      answerMarkdown:'**verb / 动词 · 02228031-v**\n\nEnglish: leave behind\n\n中文义项：抛弃',
      explanationMarkdown:'### 使用方式／搭配\n- abandon：某人 + 动词 + 某物（WordNet 框架 8；义项 02228031-v）\n\n### 数据许可与完整署名声明\n以下声明随单题一并保留。全包来源与变更记录另见随包 english-NOTICE.md。\n\n```text\nECDICT metadata only\nMIT License\n\nCopyright (c) Test Fixture\nPermission is hereby granted, free of charge, to use this fixture.\n```',
      sourceRefs:[{label:'数据来源',url:'https://example.test/dictionary'}],
    };
    for (const question of paper.snapshot) Object.assign(question, {stemMarkdown:abandon.stemMarkdown,answerMarkdown:abandon.answerMarkdown,explanationMarkdown:abandon.explanationMarkdown,sourceRefs:abandon.sourceRefs});
    const raw = JSON.stringify(paper);
    const answers = paperExportDocument(paper,'answers');
    const [body, appendix] = answers.markdown.split('## 学习说明与资料许可');
    assert.ok(appendix); assert.doesNotMatch(body!, /MIT License|WordNet 框架|可尝试先口头/);
    assert.match(body!, /某人（sb\.）/); assert.match(body!, /动词（v\.）/); assert.match(body!, /某物（sth\.）/);
    assert.equal((appendix!.match(/MIT License/g)||[]).length,1);
    assert.match(appendix!, /WordNet 框架/); assert.match(appendix!, /适用题号：1、2/);
    assert.match(appendix!, /Permission is hereby granted/); assert.equal(JSON.stringify(paper),raw);
    const blank = paperExportDocument(paper,'blank');
    assert.doesNotMatch(blank.markdown,/MIT License|WordNet 框架|English:|中文义项/);
    assert.match(blank.markdown,/学习说明与资料许可/); // Only the visible stem's practice instruction is retained.
    assert.equal(JSON.stringify(paper),raw);
  } finally { store.db.close(); }
});
