import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../server/index.js';
import { Store } from '../../server/core/store.js';
import { questionSchema } from '../../server/core/validation.js';
import {
  buildPaper,
  createAttempt,
  attemptView,
  submitAttempt,
} from '../../server/modules/practice/service.js';
import {
  paperExportDocument,
  attemptExportDocument,
} from '../../server/modules/transfer/exports.js';
import { exportData, importData } from '../../server/modules/transfer/migration.js';
import { exportShare, importShare } from '../../server/modules/sharing/service.js';
import { archiveAttemptQuestionHistory } from '../../server/modules/questions/history-store.js';
import { questionHistory, questionStatistics } from '../../server/modules/questions/history.js';
import {
  markResultReset,
  resetAllProgress,
} from '../../server/modules/maintenance/reset-progress.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';
import type { Question } from '../../shared/models/types.js';

const rubric = '说明关键步骤；允许等价表达；遗漏边界条件为部分正确。';
const questions = [
  {
    id: 'RUBRIC-Q',
    title: '事务',
    type: 'short_answer',
    stemMarkdown: '解释原子性。',
    answerMarkdown: '全部成功或全部回滚。',
    status: 'published',
  },
  {
    id: 'RUBRIC-G',
    title: '程序阅读',
    type: 'group',
    stemMarkdown: '阅读给定事务伪代码。',
    status: 'published',
    parts: [
      {
        id: 'explain',
        title: '解释',
        type: 'essay',
        stemMarkdown: '解释失败后的状态。',
        answerMarkdown: '回滚到初始状态。',
      },
      {
        id: 'check',
        title: '判断',
        type: 'true_false',
        stemMarkdown: '失败后应全部回滚。',
        correctAnswers: ['true'],
      },
    ],
  },
];
function fixture(t: test.TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  for (const raw of questions) {
    const question = questionSchema.parse(raw) as Question;
    store.put('questions', question.id, question);
  }
  return store;
}
async function apiFixture(t: test.TestContext) {
  const app = await buildApp({
    databasePath: ':memory:',
    seedPath: 'absent-rubric-test-seed',
    staticRoot: 'absent-rubric-static',
    dailyPushScheduler: false,
  });
  t.after(() => app.close());
  const api = async (
    url: string,
    method: any = 'GET',
    payload?: unknown,
    status = 200,
  ): Promise<any> => {
    const response = await app.inject({
      url,
      method,
      ...(payload === undefined ? {} : { payload }),
    });
    assert.equal(response.statusCode, status, response.body);
    return response.json();
  };
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
  return { app, api };
}
const paperInput = (extra: Record<string, unknown> = {}) => ({
  title: '题集判题标准',
  description: '',
  mode: 'manual' as const,
  questionIds: ['RUBRIC-Q', 'RUBRIC-G'],
  scoring: { enabled: false },
  ...extra,
});

test('set rubrics support manual/random previews, optional omission and explicit clearing without changing reusable questions', async (t) => {
  const { api } = await apiFixture(t);
  const before = await api('/api/questions/RUBRIC-Q');
  const preview = await api(
    '/api/papers/preview',
    'POST',
    paperInput({ gradingRequirements: `  ${rubric}\n ` }),
  );
  assert.equal(preview.gradingRequirements, rubric);
  assert.equal((await api('/api/papers')).length, 0);
  const manual = await api('/api/papers', 'POST', paperInput({ gradingRequirements: rubric }), 201);
  const random = await api(
    '/api/papers',
    'POST',
    {
      ...paperInput({ gradingRequirements: '按基础课标准评价。', mode: 'random', count: 1 }),
      questionIds: undefined,
    },
    201,
  );
  assert.equal((await api(`/api/papers/${manual.id}?summary=true`)).gradingRequirements, rubric);
  assert.equal(random.gradingRequirements, '按基础课标准评价。');
  const preserved = await api(
    `/api/papers/${manual.id}`,
    'PUT',
    paperInput({ title: '改名不改判题要求' }),
  );
  assert.equal(preserved.gradingRequirements, rubric);
  const cleared = await api(
    `/api/papers/${manual.id}`,
    'PUT',
    paperInput({ gradingRequirements: ' \n ' }),
  );
  assert.equal(cleared.gradingRequirements, '');
  const optional = await api('/api/papers', 'POST', paperInput(), 201);
  assert.equal(optional.gradingRequirements, '');
  assert.deepEqual(await api('/api/questions/RUBRIC-Q'), before);
  const exported = await api('/api/export');
  for (const question of [
    ...exported.questions,
    ...exported.papers.flatMap((p: any) => p.snapshot),
  ]) {
    assert.equal(Object.hasOwn(question, 'gradingRequirements'), false);
    for (const part of question.parts || [])
      assert.equal(Object.hasOwn(part, 'gradingRequirements'), false);
  }
});

test('practice/exam snapshots freeze their set rubric and do not expose answer-point guidance before submission', (t) => {
  const store = fixture(t),
    paper = buildPaper(store, paperInput({ gradingRequirements: rubric }));
  store.put('papers', paper.id, paper);
  const attempt = createAttempt(store, paper, { count: 1 });
  assert.equal(attempt.gradingRequirements, rubric);
  assert.equal(Object.hasOwn(attemptView(attempt), 'gradingRequirements'), false);
  const changed = buildPaper(
    store,
    paperInput({ gradingRequirements: '每一项条件均须严谨证明。' }),
    paper,
  );
  store.put('papers', paper.id, changed);
  assert.equal(store.require<any>('attempts', attempt.id).gradingRequirements, rubric);
  const newer = createAttempt(store, changed);
  assert.equal(newer.gradingRequirements, changed.gradingRequirements);
  assert.equal(newer.questions.find((q) => q.partId === 'explain')?.type, 'essay');
  store.remove('papers', paper.id);
  const submitted = submitAttempt(store, attempt, {
    'RUBRIC-Q': { value: '全部提交或全部回滚。' },
  });
  assert.equal(attemptView(submitted).gradingRequirements, rubric);
  const exam = createAttempt(store, changed, { mode: 'exam', durationMinutes: 5 });
  assert.equal(exam.gradingRequirements, changed.gradingRequirements);
  assert.equal(Object.hasOwn(attemptView(exam), 'gradingRequirements'), false);
  assert.equal(
    attemptView(submitAttempt(store, exam)).gradingRequirements,
    changed.gradingRequirements,
  );
});

test('rubrics appear in answer/completed exports but never in blank examination documents', async (t) => {
  const { app, api } = await apiFixture(t);
  const paper = await api('/api/papers', 'POST', paperInput({ gradingRequirements: rubric }), 201);
  for (const mode of ['blank', 'answers']) {
    const document = await api(`/api/papers/${paper.id}/export-document?mode=${mode}`);
    assert.equal(document.gradingRequirements, mode === 'blank' ? undefined : rubric);
    assert.equal(document.markdown.includes(rubric), mode !== 'blank');
  }
  for (const answers of [true, false]) {
    const response = await app.inject(`/api/papers/${paper.id}/export?answers=${answers}`);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.body.includes(rubric), answers);
  }
  const attempt = await api(`/api/papers/${paper.id}/attempts`, 'POST', {}, 201);
  assert.equal(Object.hasOwn(attempt, 'gradingRequirements'), false);
  await api(`/api/papers/${paper.id}`, 'PUT', paperInput({ gradingRequirements: '新卷要求。' }));
  await api(`/api/attempts/${attempt.id}/submit`, 'POST', {});
  for (const mode of ['blank', 'answers', 'completed']) {
    const document = await api(`/api/attempts/${attempt.id}/export-document?mode=${mode}`);
    assert.equal(document.gradingRequirements, mode === 'blank' ? undefined : rubric);
    assert.equal(document.markdown.includes(rubric), mode !== 'blank');
    assert.equal(document.markdown.includes('新卷要求。'), false);
  }
  const store = fixture(t),
    source = buildPaper(store, paperInput({ gradingRequirements: rubric }));
  const completed = submitAttempt(store, createAttempt(store, source));
  assert.equal(paperExportDocument(source, 'answers').gradingRequirements, rubric);
  assert.equal(attemptExportDocument(completed, 'completed').gradingRequirements, rubric);
});

test('complete migration preserves set, authoring draft and historical rubric versions; malformed rubrics roll back', async (t) => {
  const { api } = await apiFixture(t);
  const paper = await api('/api/papers', 'POST', paperInput({ gradingRequirements: rubric }), 201);
  const attempt = await api(`/api/papers/${paper.id}/attempts`, 'POST', {}, 201);
  await api(`/api/attempts/${attempt.id}/submit`, 'POST', {});
  await api(`/api/papers/${paper.id}`, 'PUT', paperInput({ gradingRequirements: '' }));
  const state = {
    title: '草稿',
    description: '',
    gradingRequirements: rubric,
    mode: 'manual',
    organization: 'other',
    domainId: '',
    questionIds: ['RUBRIC-Q'],
    filters: {},
    random: {},
    count: 1,
    enabled: false,
    total: 0,
    objectivePercent: 60,
    pointsByType: DEFAULT_SETTINGS.pointsByType,
    overrides: {},
    autoTotal: true,
  };
  const draft = await api('/api/paper-drafts', 'POST', { context: 'new', state }, 201);
  assert.equal(draft.state.gradingRequirements, rubric);
  const exported = await api('/api/export'),
    target = new Store(':memory:');
  t.after(() => target.db.close());
  importData(target, exported);
  assert.equal(target.require<any>('papers', paper.id).gradingRequirements, '');
  assert.equal(target.require<any>('attempts', attempt.id).gradingRequirements, rubric);
  assert.equal(target.require<any>('paper_drafts', draft.id).state.gradingRequirements, rubric);
  assert.equal(exportData(target).papers[0]!.gradingRequirements, '');
  for (const location of ['papers', 'attempts', 'paperDrafts']) {
    const invalid = structuredClone(exported);
    if (location === 'paperDrafts')
      invalid[location][0].state.gradingRequirements = 'x'.repeat(10001);
    else invalid[location][0].gradingRequirements = 'x'.repeat(10001);
    const empty = new Store(':memory:');
    t.after(() => empty.db.close());
    assert.throws(() => importData(empty, invalid));
    assert.equal(empty.all('questions').length, 0);
  }
});

test('share packages retain set rubrics and distinguish different standards while reusing the same source question', (t) => {
  const source = fixture(t),
    paper = buildPaper(source, paperInput({ gradingRequirements: rubric }));
  source.put('papers', paper.id, paper);
  const shared = exportShare(source, { kind: 'paper', id: paper.id });
  assert.equal(shared.papers[0]!.gradingRequirements, rubric);
  const target = new Store(':memory:');
  t.after(() => target.db.close());
  importShare(target, shared);
  assert.equal(target.require<any>('papers', paper.id).gradingRequirements, rubric);
  importShare(target, shared);
  assert.equal(target.all('papers').length, 1);
  const another = structuredClone(shared);
  another.papers[0]!.gradingRequirements = '所有条件必须逐一展开。';
  importShare(target, another);
  assert.equal(target.all('papers').length, 2);
  assert.equal(target.all('questions').length, 2);
  const invalid = structuredClone(shared);
  invalid.papers[0]!.gradingRequirements = 'x'.repeat(10001);
  assert.throws(() => importShare(target, invalid));
  assert.equal(target.all('papers').length, 2);
});

test('compact learning evidence retains one rubric snapshot for detailed single-question history after whole-paper cleanup', (t) => {
  const store = fixture(t),
    paper = buildPaper(store, paperInput({ gradingRequirements: rubric }));
  store.put('papers', paper.id, paper);
  const attempt = submitAttempt(store, createAttempt(store, paper), {
    'RUBRIC-Q': { value: '全部提交或全部回滚。' },
  });
  assert.equal(store.require<any>('learning_results', attempt.id).gradingRequirements, rubric);
  const query = { page: 1, pageSize: 10 };
  assert.equal(questionHistory(store, 'RUBRIC-Q', query).items[0]!.gradingRequirements, rubric);
  const exported = exportData(store) as any;
  const inconsistent = structuredClone(exported);
  inconsistent.learningResults[0].gradingRequirements = '与同一作答不一致的要求';
  const rejected = new Store(':memory:');
  t.after(() => rejected.db.close());
  assert.throws(() => importData(rejected, inconsistent));
  assert.equal(rejected.all('questions').length, 0);
  archiveAttemptQuestionHistory(store, attempt);
  store.remove('attempts', attempt.id);
  store.remove('papers', paper.id);
  const history = questionHistory(store, 'RUBRIC-Q', query).items[0]!;
  assert.equal(history.historyAvailable, false);
  assert.equal(history.gradingRequirements, rubric);
  assert.deepEqual(history.answer.value, attempt.answers['RUBRIC-Q']!.value);
  const restored = new Store(':memory:');
  t.after(() => restored.db.close());
  importData(restored, exportData(store));
  assert.equal(questionHistory(restored, 'RUBRIC-Q', query).items[0]!.gradingRequirements, rubric);
});

test('progress-only reset retains archived and retained rubric provenance without restoring statistics during cleanup or backup recovery', (t) => {
  const store = fixture(t),
    paper = buildPaper(store, paperInput({ gradingRequirements: rubric }));
  store.put('papers', paper.id, paper);
  const archived = submitAttempt(store, createAttempt(store, paper), {
    'RUBRIC-Q': { value: '整组提交或回滚。' },
  });
  archiveAttemptQuestionHistory(store, archived);
  store.remove('attempts', archived.id);
  const changed = buildPaper(
    store,
    paperInput({ gradingRequirements: '必须严格说明每个状态转换。' }),
    paper,
  );
  store.put('papers', paper.id, changed);
  const retained = submitAttempt(store, createAttempt(store, changed), {
    'RUBRIC-Q': { value: '事务不可部分提交。' },
  });
  assert.equal(questionStatistics(store, 'RUBRIC-Q').answered, 2);
  resetAllProgress(store);
  for (const [id, expected] of [
    [archived.id, rubric],
    [retained.id, changed.gradingRequirements],
  ] as const) {
    const marker = store.require<any>('learning_results', id);
    assert.equal(marker.reset, true);
    assert.deepEqual(marker.items, []);
    assert.deepEqual(marker.questions, []);
    assert.equal(marker.gradingRequirements, expected);
  }
  assert.equal(questionStatistics(store, 'RUBRIC-Q').answered, 0);
  archiveAttemptQuestionHistory(store, retained);
  store.remove('attempts', retained.id);
  store.remove('papers', paper.id);
  const query = { page: 1, pageSize: 10 },
    history = questionHistory(store, 'RUBRIC-Q', query).items;
  assert.equal(history.length, 2);
  assert.ok(history.every((item) => item.beforeReset && !item.historyAvailable));
  assert.equal(history.find((item) => item.attemptId === archived.id)!.gradingRequirements, rubric);
  assert.equal(
    history.find((item) => item.attemptId === retained.id)!.gradingRequirements,
    changed.gradingRequirements,
  );
  const restored = new Store(':memory:');
  t.after(() => restored.db.close());
  importData(restored, exportData(store));
  assert.equal(questionStatistics(restored, 'RUBRIC-Q').answered, 0);
  assert.deepEqual(questionHistory(restored, 'RUBRIC-Q', query).items, history);
});

test('reset tombstone fallback preserves a retained attempt rubric when compact evidence is absent', (t) => {
  const store = fixture(t),
    paper = buildPaper(store, paperInput({ gradingRequirements: rubric }));
  const attempt = submitAttempt(store, createAttempt(store, paper), {
    'RUBRIC-Q': { value: '全部完成或撤销。' },
  });
  store.remove('learning_results', attempt.id);
  markResultReset(store, attempt.id);
  assert.equal(store.require<any>('learning_results', attempt.id).gradingRequirements, rubric);
  assert.equal(questionStatistics(store, 'RUBRIC-Q').answered, 0);
  archiveAttemptQuestionHistory(store, attempt);
  store.remove('attempts', attempt.id);
  assert.equal(
    questionHistory(store, 'RUBRIC-Q', { page: 1, pageSize: 10 }).items[0]!.gradingRequirements,
    rubric,
  );
});

test('one canonical rubric constraint governs set creation, drafts and generated API contracts with optional source-question standards', async (t) => {
  const { api } = await apiFixture(t);
  for (const value of [null, 10, 'x'.repeat(10001)])
    await api('/api/papers', 'POST', paperInput({ gradingRequirements: value }), 400);
  assert.equal((await api('/api/papers')).length, 0);
  const document = await api('/api/openapi.json');
  const schemas = document.components.schemas;
  assert.equal(schemas.PaperInput.properties.gradingRequirements.maxLength, 10000);
  assert.equal(schemas.Paper.properties.gradingRequirements.maxLength, 10000);
  assert.equal(schemas.Attempt.properties.gradingRequirements.maxLength, 10000);
  assert.equal(schemas.PaperDraftState.properties.gradingRequirements.maxLength, 10000);
  assert.equal(schemas.PaperInput.required.includes('gradingRequirements'), false);
  assert.equal(schemas.QuestionInput.properties.gradingRequirements.maxLength, 10000);
});
