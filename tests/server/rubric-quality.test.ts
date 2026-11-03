import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { Store, nextStamp } from '../../server/core/store.js';
import { ApiError, questionSchema } from '../../server/core/validation.js';
import { registerContentQualityRoutes } from '../../server/modules/content-quality/routes.js';
import {
  inspectQuestionQuality,
  qualityContentFingerprint,
  qualitySignatures,
} from '../../server/modules/content-quality/rules.js';
import { createQuestionFeedback } from '../../server/modules/quality-feedback/service.js';
import {
  buildPaper,
  createAttempt,
  reviewAttempt,
  submitAttempt,
} from '../../server/modules/practice/service.js';
import { exportData, importData } from '../../server/modules/transfer/migration.js';
import {
  qualityIssueSchema,
  qualityScanSchema,
} from '../../server/modules/content-quality/schema.js';
import type { QualityIssue } from '../../shared/models/content-quality.js';
import type { Question } from '../../shared/models/types.js';
import { inspectRubricFormat } from '../../shared/questions/rubric-format.js';

const malformed = '1. 说明整体成功。\n2.\n\n- ，；\n\n```ts\nconst total = 1;';
const brokenFormula = '必要公式：$\\notAnAtlasCommand{x}$。';
const stamp = '2026-11-03T00:00:00.000Z';
const q = (id = 'RUBRIC', changes: Record<string, unknown> = {}): Question =>
  questionSchema.parse({
    id,
    title: '标准检查 ' + id,
    type: 'short_answer',
    stemMarkdown: `解释独立概念 ${id}。`,
    answerMarkdown: '整体成功，失败时整体回滚。',
    explanationMarkdown: '',
    sourceRefs: [],
    categoryIds: ['cs-core'],
    status: 'published',
    createdAt: stamp,
    updatedAt: stamp,
    ...changes,
  }) as Question;

function retainGradedAttempt(store: Store, questionId: string) {
  const paper = buildPaper(store, {
    title: '标准冻结与评分保护',
    description: '',
    mode: 'manual',
    questionIds: [questionId],
    questionGradingRequirements: { [questionId]: '冻结的题集标准：说明整体提交和整体回滚。' },
    scoring: { enabled: true, totalPoints: 4, questionPoints: { [questionId]: 4 } },
  });
  store.put('papers', paper.id, paper);
  const attempt = createAttempt(store, paper);
  submitAttempt(store, attempt, { [questionId]: { value: '操作整体成功或整体回滚。' } });
  reviewAttempt(store, attempt, { [questionId]: 3 });
  return attempt;
}
const retainedLearning = [
  'attempts',
  'papers',
  'review_events',
  'review_cards',
  'learning_results',
  'question_history',
  'reviews',
] as const;
const learningRecords = (store: Store) =>
  Object.fromEntries(retainedLearning.map((table) => [table, store.all(table)]));

async function fixture(t: test.TestContext) {
  const store = new Store(':memory:'),
    app = Fastify();
  store.put('domains', 'cs', { id: 'cs', name: '计算机', description: '', sortOrder: 0 });
  store.put('categories', 'cs-core', {
    id: 'cs-core',
    domainId: 'cs',
    parentId: null,
    name: '基础',
    description: '',
    sortOrder: 0,
  });
  app.setErrorHandler((error, _request, reply) =>
    reply.code(error instanceof ApiError ? error.status : 500).send({
      error: {
        code: error instanceof ApiError ? error.code : 'TEST_FAILURE',
        message: error.message,
      },
    }),
  );
  registerContentQualityRoutes(app, store);
  const api = async (url: string, body?: unknown, expected = 200) => {
    const response = await app.inject({
      url,
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { payload: body }),
    });
    assert.equal(response.statusCode, expected, response.body);
    return response.json();
  };
  const scan = async (filters: Record<string, unknown> = {}) => {
    let run = await api('/api/content-quality/scans', { filters }, 201);
    while (run.status === 'ready')
      run = await api(`/api/content-quality/scans/${run.id}/process`, { batchSize: 1 });
    assert.equal(qualityScanSchema.safeParse(run).success, true);
    return run;
  };
  const issues = async (suffix = ''): Promise<QualityIssue[]> =>
    (await api('/api/content-quality/issues?status=all&pageSize=100' + suffix)).items;
  t.after(async () => {
    await app.close();
    store.database.close();
  });
  return { store, app, api, scan, issues };
}

test('shared rubric findings identify original lines and snippets without rewriting the standard', () => {
  const findings = inspectRubricFormat(malformed);
  assert.ok(findings.some((issue) => issue.code === 'empty_list_item' && issue.line === 2));
  assert.ok(findings.some((issue) => issue.code === 'punctuation_only_prose'));
  assert.ok(findings.some((issue) => issue.code === 'unclosed_fence'));
  for (const issue of findings) {
    assert.ok(issue.line && issue.line >= 1);
    assert.equal(typeof issue.offset, 'number');
    assert.ok(issue.source);
    assert.equal(malformed.slice(issue.offset, issue.offset! + issue.source!.length), issue.source);
  }
  assert.deepEqual(inspectRubricFormat(''), []);
  assert.deepEqual(inspectRubricFormat('   \n'), []);
});

test('optional standards, explanations and sources stay optional and valid professional examples are preserved', () => {
  for (const gradingRequirements of [undefined, '', '  \n']) {
    const question = q('OPTIONAL', {
      gradingRequirements,
      answerMarkdown: '',
      explanationMarkdown: '',
      sourceRefs: [],
    });
    assert.deepEqual(inspectQuestionQuality(question), []);
  }
  const valid = q('VALID', {
    gradingRequirements:
      '- 用 `List<Integer>`说明泛型。\n- 标点示例为 `;`。\n\n```ts\nconst marker = "-";\n```\n\n| 项目 | 解释 |\n| --- | --- |\n| `<T>` | 类型参数 |',
  });
  const original = structuredClone(valid);
  assert.deepEqual(inspectQuestionQuality(valid), []);
  assert.deepEqual(valid, original);
});

test('only subjective standards are scanned and group findings retain their individual part identities', () => {
  for (const type of ['short_answer', 'essay']) {
    const found = inspectQuestionQuality(q(type, { type, gradingRequirements: malformed }));
    const format = found.filter((issue) => issue.rule === 'rubric_format');
    assert.equal(format.length, 1);
    assert.match(format[0].evidence, /gradingRequirements/);
    assert.match(format[0].evidence, /第2行/);
    assert.match(format[0].evidence, /const total = 1/);
  }
  const group = q('GROUP', {
    type: 'group',
    parts: [
      {
        id: 'one',
        title: '概念',
        type: 'short_answer',
        stemMarkdown: '解释概念。',
        gradingRequirements: malformed,
      },
      {
        id: 'two',
        title: '论述',
        type: 'essay',
        stemMarkdown: '论述理由。',
        gradingRequirements: '- 必要核对点：',
      },
      {
        id: 'three',
        title: '判断',
        type: 'true_false',
        stemMarkdown: '命题成立吗？',
        correctAnswers: ['true'],
      },
    ],
  });
  assert.deepEqual(
    inspectQuestionQuality(group)
      .filter((issue) => issue.rule === 'rubric_format')
      .map((issue) => issue.partId),
    ['one', 'two'],
  );
  for (const value of [
    {
      ...q('BOOL', { type: 'true_false', correctAnswers: ['true'] }),
      gradingRequirements: malformed,
    },
    { ...group, gradingRequirements: malformed },
  ]) {
    const findings = inspectQuestionQuality(value);
    assert.ok(findings.some((issue) => issue.rule === 'structure'));
    assert.ok(!findings.some((issue) => issue.rule === 'rubric_format' && !issue.partId));
  }
});

test('formula checks include effective subjective standards while respecting parent and part switches and code', () => {
  const enabled = q('MATH', { gradingRequirements: brokenFormula, mathEnabled: true });
  const math = inspectQuestionQuality(enabled).find((issue) => issue.rule === 'math_syntax');
  assert.ok(math);
  assert.match(math.evidence, /gradingRequirements/);
  assert.match(math.evidence, /第1行/);
  assert.equal(
    inspectQuestionQuality({ ...enabled, mathEnabled: false }).some(
      (issue) => issue.rule === 'math_syntax',
    ),
    false,
  );
  assert.equal(
    inspectQuestionQuality({ ...enabled, gradingRequirements: '`' + brokenFormula + '`' }).some(
      (issue) => issue.rule === 'math_syntax',
    ),
    false,
  );
  const group = q('MATH-GROUP', {
    type: 'group',
    mathEnabled: true,
    parts: [
      {
        id: 'inherit',
        title: '继承',
        type: 'short_answer',
        stemMarkdown: '解释公式。',
        gradingRequirements: brokenFormula,
      },
      {
        id: 'off',
        title: '关闭',
        type: 'short_answer',
        stemMarkdown: '解释代码。',
        gradingRequirements: brokenFormula,
        mathEnabled: false,
      },
      {
        id: 'on',
        title: '显式开启',
        type: 'essay',
        stemMarkdown: '说明公式。',
        gradingRequirements: brokenFormula,
        mathEnabled: true,
      },
    ],
  });
  assert.deepEqual(
    inspectQuestionQuality(group)
      .filter((issue) => issue.rule === 'math_syntax')
      .map((issue) => issue.partId),
    ['inherit', 'on'],
  );
  const parentOff = { ...group, mathEnabled: false };
  assert.deepEqual(
    inspectQuestionQuality(parentOff)
      .filter((issue) => issue.rule === 'math_syntax')
      .map((issue) => issue.partId),
    ['on'],
  );
});

test('different standards change content and duplicate fingerprints without changing the question or objective answer identity', () => {
  const a = q('A', { gradingRequirements: '- 说明整体成功。' }),
    b = { ...a, gradingRequirements: '- 说明整体成功和失败回滚。' };
  assert.notEqual(qualityContentFingerprint(a), qualityContentFingerprint(b));
  const left = qualitySignatures(a),
    right = qualitySignatures(b);
  assert.equal(left.promptHash, right.promptHash);
  assert.equal(left.answerHash, right.answerHash);
  assert.notEqual(left.fullHash, right.fullHash);
  const group = q('GROUP-HASH', {
    type: 'group',
    parts: [
      {
        id: 'one',
        title: '第一问',
        type: 'short_answer',
        stemMarkdown: '解释概念。',
        gradingRequirements: '解释定义。',
      },
      {
        id: 'two',
        title: '第二问',
        type: 'true_false',
        stemMarkdown: '是否成立？',
        correctAnswers: ['false'],
      },
    ],
  });
  const changed = structuredClone(group);
  changed.parts![0].gradingRequirements = '解释定义及适用边界。';
  assert.notEqual(qualitySignatures(group).fullHash, qualitySignatures(changed).fullHash);
});

test('HTTP scans group format defects, filter by rule and remain idempotent without modifying source or learning records', async (t) => {
  const f = await fixture(t),
    question = q('ROOT', { gradingRequirements: malformed });
  f.store.put('questions', question.id, question);
  const attempt = retainGradedAttempt(f.store, question.id);
  assert.equal(attempt.answers[question.id].selfScore, 3);
  assert.equal(
    attempt.questions[0].gradingRequirements,
    '冻结的题集标准：说明整体提交和整体回滚。',
  );
  f.store.putStudy({ ...f.store.study(question.id), notes: '扫描不得改写的学习笔记' });
  const protectedBefore = [
    f.store.all('questions'),
    f.store.all('study'),
    f.store.all('attempts'),
    f.store.all('papers'),
    f.store.all('review_events'),
    f.store.all('ai_runs'),
    learningRecords(f.store),
  ];
  const first = await f.scan({ questionId: question.id });
  assert.equal(first.ruleCounts.rubric_format, 1);
  const initial = await f.issues('&rule=rubric_format&domainId=cs');
  assert.equal(initial.length, 1);
  assert.equal(
    qualityIssueSchema.safeParse(f.store.require('quality_issues', initial[0].id)).success,
    true,
  );
  const second = await f.scan({ questionId: question.id });
  assert.equal(second.newIssues, 0);
  assert.equal((await f.issues('&rule=rubric_format'))[0].id, initial[0].id);
  const grouped = await f.api('/api/content-quality/questions?rule=rubric_format');
  assert.equal(grouped.total, 1);
  assert.equal(grouped.items[0].issueCount, 1);
  assert.deepEqual(
    [
      f.store.all('questions'),
      f.store.all('study'),
      f.store.all('attempts'),
      f.store.all('papers'),
      f.store.all('review_events'),
      f.store.all('ai_runs'),
      learningRecords(f.store),
    ],
    protectedBefore,
  );
});

test('fixing a standard stales its previous evidence and keeps independent feedback and history unchanged', async (t) => {
  const f = await fixture(t),
    question = q('FIX', { gradingRequirements: malformed });
  f.store.put('questions', question.id, question);
  retainGradedAttempt(f.store, question.id);
  const history = learningRecords(f.store),
    study = f.store.all('study');
  const feedback = createQuestionFeedback(f.store, {
    questionId: question.id,
    kind: 'other',
    description: '需要核对本题是否遗漏适用条件。',
  });
  await f.scan({ questionId: question.id });
  const format = (await f.issues('&rule=rubric_format'))[0];
  const report = f.store.require<QualityIssue>('quality_issues', feedback.qualityIssueId!);
  await f.api(`/api/content-quality/issues/${report.id}/resolve`, {
    status: 'confirmed',
    note: '反馈独立保留，尚待核对适用条件。',
    expectedUpdatedAt: report.updatedAt,
  });
  const fixed = {
    ...question,
    gradingRequirements: '- 必须说明整体成功或整体回滚。',
    updatedAt: nextStamp(question.updatedAt),
  };
  f.store.put('questions', fixed.id, fixed);
  assert.equal((await f.api('/api/content-quality/issues/' + format.id)).issue.sourceChanged, true);
  const fixedRun = await f.scan({ questionId: question.id });
  assert.equal(fixedRun.ruleCounts.rubric_format || 0, 0);
  assert.equal(f.store.require<QualityIssue>('quality_issues', format.id).status, 'stale');
  assert.equal(f.store.require<QualityIssue>('quality_issues', report.id).status, 'confirmed');
  const stale = f.store.require<QualityIssue>('quality_issues', format.id);
  await f.api(`/api/content-quality/issues/${stale.id}/resolve`, {
    status: 'resolved',
    note: '已修正空条目与围栏，并重新扫描当前标准。',
    expectedUpdatedAt: stale.updatedAt,
  });
  assert.equal(f.store.require<QualityIssue>('quality_issues', report.id).status, 'confirmed');
  assert.deepEqual(f.store.require('questions', question.id), fixed);
  assert.deepEqual(learningRecords(f.store), history);
  assert.deepEqual(f.store.all('study'), study);
  assert.equal(
    (await f.issues('&rule=rubric_format&search=' + encodeURIComponent('gradingRequirements')))
      .length,
    1,
  );
});

test('trusted JSON migration preserves rubric issue evidence, independent part states and valid rule counters', async (t) => {
  const f = await fixture(t);
  const group = q('MIGRATION', {
    type: 'group',
    parts: [
      {
        id: 'a',
        title: '第一问',
        type: 'short_answer',
        stemMarkdown: '解释含义。',
        gradingRequirements: malformed,
      },
      {
        id: 'b',
        title: '第二问',
        type: 'essay',
        stemMarkdown: '说明边界。',
        gradingRequirements: '- 参考答案：',
      },
    ],
  });
  f.store.put('questions', group.id, group);
  await f.scan({ questionId: group.id });
  const issues = await f.issues('&rule=rubric_format');
  assert.equal(issues.length, 2);
  await f.api(`/api/content-quality/issues/${issues[0].id}/resolve`, {
    status: 'dismissed',
    note: '当前仅用于排版示例，保留原标准。',
    expectedUpdatedAt: issues[0].updatedAt,
  });
  const data = exportData(f.store),
    recipient = new Store(':memory:');
  t.after(() => recipient.database.close());
  importData(recipient, data);
  assert.deepEqual(
    recipient.require('questions', group.id),
    f.store.require('questions', group.id),
  );
  const restored = recipient.all<QualityIssue>('quality_issues');
  assert.equal(restored.length, 2);
  assert.deepEqual(
    restored.map((issue) => [issue.id, issue.status, issue.evidence]).sort(),
    f.store
      .all<QualityIssue>('quality_issues')
      .map((issue) => [issue.id, issue.status, issue.evidence])
      .sort(),
  );
  assert.ok(
    recipient.all('quality_scans').every((run) => qualityScanSchema.safeParse(run).success),
  );
});
