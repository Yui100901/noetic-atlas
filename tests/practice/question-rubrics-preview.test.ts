import { paperDraftStateSchema } from '../../server/modules/practice/paper-drafts.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../server/index.js';
import { Store, nextStamp } from '../../server/core/store.js';
import { questionSchema, parse, ApiError } from '../../server/core/validation.js';
import {
  attemptView,
  buildPaper,
  createAttempt,
  paperPreview,
  reviewAttempt,
  submitAttempt,
  type StoredPaper,
} from '../../server/modules/practice/service.js';
import {
  paperExportDocument,
  attemptExportDocument,
} from '../../server/modules/transfer/exports.js';
import { exportShare, importShare } from '../../server/modules/sharing/routes.js';
import { exportData, importData } from '../../server/modules/transfer/migration.js';
import { questionHistory } from '../../server/modules/questions/history.js';
import { reverseVocabularyQuestion } from '../../server/modules/practice/vocabulary-practice.js';
import { reverseConceptQuestion } from '../../server/modules/practice/concept-practice.js';
import type { Question } from '../../shared/models/types.js';

const base = '必须解释整体成功或回滚，区分失败与部分提交；允许等价表达。';
const changed = '必须给出事务边界、异常路径和反例；只写结论不算完整。';
const raw = [
  {
    id: 'S',
    title: '事务',
    type: 'short_answer',
    stemMarkdown: '解释原子性。',
    answerMarkdown: '全部提交或全部回滚。',
    gradingRequirements: base,
    status: 'published',
  },
  {
    id: 'G',
    title: '事务材料',
    type: 'group',
    stemMarkdown: '阅读事务示例。',
    status: 'published',
    parts: [
      {
        id: 'subject',
        title: '说明',
        type: 'essay',
        stemMarkdown: '解释失败后的状态。',
        answerMarkdown: '恢复先前一致状态。',
        gradingRequirements: '说明日志、回滚和边界。',
      },
      {
        id: 'bool',
        title: '判断',
        type: 'true_false',
        stemMarkdown: '是否应整体回滚？',
        correctAnswers: ['true'],
      },
    ],
  },
  {
    id: 'B',
    title: '判断',
    type: 'true_false',
    stemMarkdown: '是否全有或全无？',
    correctAnswers: ['true'],
    status: 'published',
  },
];
function fixture(t: test.TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  for (const q of raw) {
    const value = questionSchema.parse(q) as Question;
    store.put('questions', value.id, value);
  }
  return store;
}
const input = (extra: Record<string, unknown> = {}) => ({
  title: '标准与预览',
  description: '',
  mode: 'manual' as const,
  questionIds: ['S', 'G', 'B'],
  scoring: { enabled: false },
  ...extra,
});
function code(fn: () => unknown, expected: string) {
  assert.throws(fn, (error) => error instanceof ApiError && error.code === expected);
}

test('source question and subjective part standards share validation while objective and group standards stay empty', (t) => {
  const store = fixture(t);
  assert.equal(store.require<Question>('questions', 'S').gradingRequirements, base);
  assert.equal(
    questionSchema.parse(raw[1]).parts?.[0]?.gradingRequirements,
    '说明日志、回滚和边界。',
  );
  assert.equal(questionSchema.safeParse({ ...raw[2], gradingRequirements: base }).success, false);
  assert.equal(questionSchema.safeParse({ ...raw[1], gradingRequirements: base }).success, false);
  assert.equal(
    questionSchema.safeParse({ ...raw[0], gradingRequirements: 'x'.repeat(10001) }).success,
    false,
  );
  assert.equal(
    questionSchema.parse({ ...raw[0], gradingRequirements: '  ' + base + '  ' })
      .gradingRequirements,
    base,
  );
});

test('set overrides and explicit clearing freeze per leaf without editing their originals or hinting during answers', (t) => {
  const store = fixture(t),
    paper = buildPaper(
      store,
      input({
        questionGradingRequirements: { S: changed, 'G::subject': '' },
        gradingRequirements: '全卷补充：不要求术语逐字一致。',
      }),
    );
  store.put('papers', paper.id, paper);
  const preview = paperPreview(paper);
  assert.equal(preview.previewQuestions[0]!.gradingRequirements, changed);
  assert.equal(preview.previewQuestions[1]!.parts![0]!.gradingRequirements, '');
  assert.equal(preview.inheritedGradingRequirements.S, base);
  assert.equal(preview.inheritedGradingRequirements['G::subject'], '说明日志、回滚和边界。');
  assert.equal(store.require<Question>('questions', 'S').gradingRequirements, base);
  assert.equal(
    store.require<Question>('questions', 'G').parts![0]!.gradingRequirements,
    '说明日志、回滚和边界。',
  );
  const attempt = createAttempt(store, paper);
  assert.equal(attempt.questions[0]!.gradingRequirements, changed);
  assert.equal(
    attemptView(attempt).questions.some((q) => Object.hasOwn(q, 'gradingRequirements')),
    false,
  );
  const submitted = submitAttempt(store, attempt, {
    S: { value: '只有整体完成' },
    'G::subject': { value: '说明' },
  });
  reviewAttempt(store, submitted, {}, {}, { S: 'incorrect' });
  assert.equal(attemptView(submitted).questions[0]!.gradingRequirements, changed);
  assert.equal(
    questionHistory(store, 'S', { page: 1, pageSize: 10 }).items[0]!.question.gradingRequirements,
    changed,
  );
  const blank = paperExportDocument(paper, 'blank'),
    answers = paperExportDocument(paper, 'answers'),
    completed = attemptExportDocument(submitted);
  assert.ok(!JSON.stringify(blank).includes(changed));
  assert.equal(answers.questions[0]!.gradingRequirements, changed);
  assert.match(answers.markdown, /本题判题要求/);
  assert.equal(completed.questions[0]!.gradingRequirements, changed);
  const inherited = buildPaper(store, input({ questionGradingRequirements: {} }), paper);
  assert.equal(inherited.snapshot[0]!.gradingRequirements, base);
});

test('overrides reject unknown questions, group roots and objective parts before saving', (t) => {
  const store = fixture(t);
  for (const id of ['missing', 'G', 'B', 'G::bool'])
    code(
      () => buildPaper(store, input({ questionGradingRequirements: { [id]: changed } })),
      'INVALID_QUESTION_RUBRIC',
    );
  assert.equal(store.all('papers').length, 0);
});

test('random preview can be saved and paged with the same IDs and rejects version, filter and count drift', (t) => {
  const store = fixture(t);
  for (let index = 0; index < 12; index++) {
    const q = questionSchema.parse({
      ...raw[0],
      id: 'R' + index,
      title: '样例' + index,
      stemMarkdown: 'PRIVATE_BODY_' + index,
    }) as Question;
    store.put('questions', q.id, q);
  }
  const config = {
    title: '随机锁定',
    description: '',
    mode: 'random' as const,
    count: 6,
    filters: { types: ['short_answer'] as Question['type'][] },
    scoring: { enabled: false },
  };
  const preview = paperPreview(buildPaper(store, config), { pageSize: 5 }),
    ids = preview.questionIds;
  const pinned = {
    ...config,
    previewQuestionIds: ids,
    expectedQuestionVersions: preview.questionVersions,
  };
  for (let index = 0; index < 3; index++)
    assert.deepEqual(buildPaper(store, pinned).questionIds, ids);
  const page2 = paperPreview(buildPaper(store, pinned), { page: 2, pageSize: 5 });
  assert.equal(page2.previewQuestions.length, 1);
  assert.equal(page2.previewQuestions[0]!.id, ids[5]);
  code(() => buildPaper(store, { ...pinned, count: 5 }), 'PAPER_PREVIEW_COUNT_MISMATCH');
  code(
    () => buildPaper(store, { ...pinned, filters: { types: ['true_false'] } }),
    'PAPER_PREVIEW_OUTDATED',
  );
  const q = store.require<Question>('questions', ids[0]!);
  store.put('questions', q.id, { ...q, updatedAt: nextStamp(q.updatedAt) });
  code(() => buildPaper(store, pinned), 'PAPER_PREVIEW_OUTDATED');
  code(
    () => buildPaper(store, { ...pinned, expectedQuestionVersions: undefined }),
    'PREVIEW_VERSIONS_REQUIRED',
  );
});

test('authoring preview APIs return bounded full bodies and all navigation metadata without writing a paper', async (t) => {
  const app = await buildApp({
    databasePath: ':memory:',
    seedPath: 'absent-question-preview-seed',
    staticRoot: 'absent-preview-static',
    dailyPushScheduler: false,
  });
  t.after(() => app.close());
  const api = async (url: string, method: any = 'GET', payload?: unknown, status = 200) => {
    const response = await app.inject({
      url,
      method,
      ...(payload === undefined ? {} : { payload }),
    });
    assert.equal(response.statusCode, status, response.body);
    return response.json() as any;
  };
  const questions = Array.from({ length: 13 }, (_, index) => ({
    ...raw[0],
    id: 'P' + index,
    title: '题' + index,
    stemMarkdown: 'BODY_CANARY_' + index,
    gradingRequirements: 'RUBRIC_CANARY_' + index,
  }));
  await api('/api/import', 'POST', {
    mode: 'merge',
    data: {
      schemaVersion: 1,
      domains: [],
      categories: [],
      tags: [],
      questions,
      documents: [],
      papers: [],
    },
  });
  const create = input({ questionIds: questions.map((q) => q.id) }),
    preview = await api('/api/papers/preview', 'POST', {
      ...create,
      previewPage: 2,
      previewPageSize: 5,
    });
  assert.equal(preview.previewTotal, 13);
  assert.equal(preview.previewPage, 2);
  assert.equal(preview.previewQuestions.length, 5);
  assert.equal(preview.questions.length, 13);
  assert.equal(Object.keys(preview.questionVersions).length, 13);
  assert.equal(Object.keys(preview.inheritedGradingRequirements).length, 5);
  assert.ok(
    preview.questions.every(
      (q: any) => !q.stemMarkdown && !q.groupStemMarkdown && !q.options.length,
    ),
  );
  assert.ok(!JSON.stringify(preview).includes('BODY_CANARY_0'));
  assert.ok(!JSON.stringify(preview).includes('RUBRIC_CANARY_0'));
  assert.equal((await api('/api/papers')).length, 0);
  const saved = await api(
      '/api/papers',
      'POST',
      { ...create, expectedQuestionVersions: preview.questionVersions },
      201,
    ),
    last = await api(`/api/papers/${saved.id}/preview?page=3&pageSize=5`);
  assert.equal(last.previewQuestions.length, 3);
  assert.equal(last.previewQuestions[0].id, 'P10');
  const docs = await api('/api/openapi.json');
  assert.ok(docs.paths['/api/papers/{id}/preview']);
  assert.ok(docs.components.schemas.PaperPreview);
});

test('sharing preserves original standards, applies recipient-local set overrides and remaps grouped identities idempotently', (t) => {
  const source = fixture(t),
    paper = buildPaper(
      source,
      input({ questionGradingRequirements: { S: changed, 'G::subject': '' } }),
    );
  source.put('papers', paper.id, paper);
  const exported = exportShare(source, { kind: 'paper', id: paper.id });
  assert.equal(exported.questions.find((q) => q.id === 'S')!.gradingRequirements, base);
  assert.equal(exported.papers[0]!.snapshot[0]!.gradingRequirements, changed);
  const target = fixture(t);
  target.put('questions', 'G', {
    ...target.require<Question>('questions', 'G'),
    stemMarkdown: '有冲突的另一份材料',
  });
  importShare(target, exported);
  const imported = target.all<StoredPaper>('papers')[0]!;
  assert.equal(imported.snapshot[0]!.gradingRequirements, changed);
  assert.equal(target.require<Question>('questions', 'S').gradingRequirements, base);
  const group = imported.snapshot.find((q) => q.type === 'group')!;
  assert.notEqual(group.id, 'G');
  assert.equal(group.parts![0]!.gradingRequirements, '');
  assert.equal(imported.questionGradingRequirements![`${group.id}::subject`], '');
  const counts = [target.all('questions').length, target.all('papers').length];
  importShare(target, exported);
  assert.deepEqual([target.all('questions').length, target.all('papers').length], counts);
  const corrupt = structuredClone(exported);
  corrupt.papers[0]!.snapshot[0]!.gradingRequirements = '未声明的另一套标准';
  code(() => importShare(target, corrupt), 'INVALID_QUESTION_RUBRIC');
});

test('trusted migration and history retain effective per-question standards and reject inconsistent override maps atomically', (t) => {
  const source = fixture(t),
    paper = buildPaper(source, input({ questionGradingRequirements: { S: changed } }));
  source.put('papers', paper.id, paper);
  const attempt = submitAttempt(source, createAttempt(source, paper), { S: { value: '整体回滚' } });
  const backup = exportData(source),
    target = new Store(':memory:');
  t.after(() => target.db.close());
  importData(target, backup);
  assert.equal(
    target.require<StoredPaper>('papers', paper.id).snapshot[0]!.gradingRequirements,
    changed,
  );
  assert.equal(
    target.require<any>('attempts', attempt.id).questions[0].gradingRequirements,
    changed,
  );
  const broken = structuredClone(backup);
  broken.papers[0]!.questionGradingRequirements!.S = '不匹配';
  const empty = new Store(':memory:');
  t.after(() => empty.db.close());
  code(() => importData(empty, broken), 'INVALID_QUESTION_RUBRIC');
  assert.equal(empty.all('questions').length, 0);
});

test('reverse vocabulary and concept objective cards never retain answer-revealing subjective standards', () => {
  const original = questionSchema.parse({
    ...raw[0],
    vocabulary: {
      language: 'en',
      headword: 'atomic',
      meaningPrompt: 'all parts act as a unit',
      acceptedAnswers: ['atomic'],
      pronunciations: [
        {
          label: '英式',
          ipa: '/əˈtɒmɪk/',
          sourceLabel: '测试',
          sourceUrl: 'https://example.com',
          license: '测试',
          method: 'manual',
        },
      ],
    },
  }) as Question;
  const reverse = reverseVocabularyQuestion(original);
  assert.equal(reverse.gradingRequirements, undefined);
  assert.equal(questionSchema.safeParse(reverse).success, true);
  assert.equal(original.gradingRequirements, base);
  const concept = questionSchema.parse({
    ...raw[0],
    concept: {
      term: '原子性',
      meaningPrompt: '全部成功或全部失败的性质',
      acceptedAnswers: ['原子性'],
    },
  }) as Question;
  const reversed = reverseConceptQuestion(concept);
  assert.equal(reversed.gradingRequirements, undefined);
  assert.equal(questionSchema.safeParse(reversed).success, true);
});

test('scored random locks preserve the selected root units and honor explicit coherent per-question points', (t) => {
  const store = fixture(t);
  for (let index = 0; index < 8; index++) {
    const q = questionSchema.parse({ ...raw[0], id: 'SCORE' + index }) as Question;
    store.put('questions', q.id, q);
  }
  const config = {
    title: '计分锁定',
    description: '',
    mode: 'random' as const,
    filters: { types: ['short_answer'] as Question['type'][] },
    scoring: { enabled: true, totalPoints: 12, pointsByType: { short_answer: 3 } },
  };
  const preview = paperPreview(buildPaper(store, config)),
    pin = {
      ...config,
      previewQuestionIds: [...preview.questionIds].reverse(),
      expectedQuestionVersions: preview.questionVersions,
    };
  const saved = buildPaper(store, pin);
  assert.deepEqual(saved.questionIds, pin.previewQuestionIds);
  assert.equal(saved.scoring!.totalPoints, 12);
  code(
    () => buildPaper(store, { ...pin, scoring: { ...pin.scoring, totalPoints: 13 } }),
    'TOTAL_POINTS_MISMATCH',
  );
  const custom = buildPaper(store, {
    ...pin,
    scoring: {
      enabled: true,
      totalPoints: 12,
      questionPoints: Object.fromEntries(
        pin.previewQuestionIds.map((id, i) => [id, [1, 2, 3, 6][i]!]),
      ),
    },
  });
  assert.equal(custom.scoring!.totalPoints, 12);
});

test('authoring drafts retain local rubric overrides and random-preview identities independently of persisted source content', () => {
  const state = {
    title: '草稿',
    description: '',
    mode: 'random',
    organization: 'other',
    domainId: '',
    questionIds: [],
    filters: {},
    random: {},
    count: 2,
    enabled: false,
    total: 10,
    objectivePercent: 60,
    pointsByType: DEFAULT_SETTINGS.pointsByType,
    overrides: {},
    autoTotal: true,
    questionGradingRequirements: { S: changed, 'G::subject': '' },
    previewQuestionIds: ['S', 'G'],
    expectedQuestionVersions: { S: '', G: '' },
  };
  const parsed = paperDraftStateSchema.parse(state);
  assert.deepEqual(parsed.questionGradingRequirements, state.questionGradingRequirements);
  assert.deepEqual(parsed.previewQuestionIds, ['S', 'G']);
  assert.deepEqual(parsed.expectedQuestionVersions, { S: '', G: '' });
  assert.equal(
    paperDraftStateSchema.safeParse({
      ...state,
      questionGradingRequirements: { S: 'x'.repeat(10001) },
    }).success,
    false,
  );
});
