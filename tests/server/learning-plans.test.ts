import { createFocus } from '../../server/modules/focus-review/service.js';
import { createFocusSchema } from '../../server/modules/focus-review/schema.js';
import {
  recordManualReview,
  changeReviewCard,
} from '../../server/modules/review-scheduler/service.js';
import { getSettings } from '../../server/modules/settings/service.js';
import { selectPlanTasks } from '../../server/modules/learning-plans/selection.js';
import {
  dailyPushSettingsSchema,
  validateDailyPushConfiguration,
} from '../../server/modules/daily-push/schema.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../server/core/store.js';
import { questionSchema } from '../../server/core/validation.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';
import type { LearningDay, LearningGoal } from '../../shared/models/learning-plan.js';
import type { FocusSession } from '../../shared/models/focus-review.js';
import { learningGoalSchema } from '../../server/modules/learning-plans/schema.js';
import { generateLearningDay } from '../../server/modules/learning-plans/service.js';
import {
  learningDayView,
  recordPlanEvidence,
  learningPlanAnalytics,
} from '../../server/modules/learning-plans/progress.js';
import { allocateGoalBudget } from '../../server/modules/learning-plans/selection.js';
import { startLearningDay } from '../../server/modules/learning-plans/start.js';
import { actFocus } from '../../server/modules/focus-review/service.js';
import { focusActionSchema } from '../../server/modules/focus-review/schema.js';
import { submitAttempt, type StoredAttempt } from '../../server/modules/practice/service.js';
import { questionStatistics } from '../../server/modules/questions/history.js';
import { exportData, importData } from '../../server/modules/transfer/migration.js';
import { checkDailyPush, dailyPushOverview } from '../../server/modules/daily-push/service.js';
import { learningResetPreview, resetLearningProgress } from '../../server/modules/study/reset.js';
import { buildApp } from '../../server/index.js';

const goal = (id: string, domainId: string, categoryId: string, extra = {}) =>
  learningGoalSchema.parse({
    id,
    name: id,
    enabled: true,
    domainId,
    categoryIds: [categoryId],
    tagIds: [],
    tagMode: 'all',
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    priority: 3,
    weight: 1,
    reviewPoints: 0,
    newPoints: 2,
    mode: 'focus',
    direction: 'default',
    ...extra,
  }) as LearningGoal;
function fixture(t: test.TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  for (const d of ['D1', 'D2']) {
    store.put('domains', d, { id: d, name: d, description: '', sortOrder: 0 });
    store.put('categories', 'C' + d, {
      id: 'C' + d,
      domainId: d,
      parentId: null,
      name: d,
      description: '',
      sortOrder: 0,
    });
    for (let i = 0; i < 30; i++) {
      const q = questionSchema.parse({
        id: `${d}-${i}`,
        title: `基础判断${i}`,
        type: 'true_false',
        stemMarkdown: '进程具有独立地址空间。',
        correctAnswers: ['true'],
        answerMarkdown: '参考答案隐私标记',
        domainIds: [d],
        categoryIds: ['C' + d],
        status: 'published',
      });
      store.put('questions', q.id, q);
    }
  }
  const goals = [goal('G1', 'D1', 'CD1'), goal('G2', 'D2', 'CD2')];
  store.put('settings', 'system', {
    ...structuredClone(DEFAULT_SETTINGS),
    dailyPush: {
      ...DEFAULT_SETTINGS.dailyPush,
      enabled: true,
      timeZone: 'UTC',
      goals,
      allocationMode: 'weights',
    },
  });
  const at = new Date(Date.now() - 1000),
    make = () => generateLearningDay(store, at).plan!;
  const configure = (changes: Record<string, unknown>) => {
    const settings = store.require<any>('settings', 'system');
    store.put('settings', 'system', {
      ...settings,
      dailyPush: { ...settings.dailyPush, ...changes },
    });
  };
  const act = (session: FocusSession, action: string, extra = {}) =>
    actFocus(
      store,
      store.require('focus_sessions', session.id),
      focusActionSchema.parse({
        index: session.index,
        revision: session.revision,
        action,
        ...extra,
      }),
    );
  return { store, goals, at, make, configure, act };
}
test('weighted budgets are shared, generated once and retain frozen target settings', (t) => {
  const { store, make, configure, at } = fixture(t);
  assert.deepEqual(
    allocateGoalBudget(30, [goal('A', 'D1', 'CD1', { weight: 2 }), goal('B', 'D2', 'CD2')]),
    [20, 10],
  );
  const day = make();
  assert.equal(day.targetReviewPoints, 30);
  assert.equal(day.targetNewPoints, 20);
  assert.ok(day.totalPoints >= 50);
  assert.equal(day.goals.length, 2);
  assert.equal(
    new Set(day.tasks.map((t) => JSON.stringify([t.questionId, t.partId, t.direction]))).size,
    day.tasks.length,
  );
  assert.equal(store.all('papers').length, 2);
  configure({ reviewPoints: 60, newPoints: 40 });
  assert.deepEqual(make(), day);
  assert.equal(checkDailyPush(store, at).generated, false);
  assert.equal(store.all('learning_days').length, 1);
  assert.equal(dailyPushOverview(store, at).plan!.id, day.id);
  assert.equal('tasks' in dailyPushOverview(store, at).plan!, false);
});
test('overlapping goals deduplicate by priority and may lend unused quota to another goal', (t) => {
  const { configure, make } = fixture(t);
  configure({
    allocationMode: 'fixed',
    goals: [
      goal('HIGH', 'D1', 'CD1', { priority: 5, newPoints: 2 }),
      goal('LOW', 'D1', 'CD1', { priority: 1, newPoints: 2 }),
      goal('OTHER', 'D2', 'CD2', { newPoints: 100 }),
    ],
  });
  const day = make();
  assert.equal(new Set(day.tasks.map((t) => t.questionId)).size, day.tasks.length);
  assert.equal(day.tasks[0]!.goalId, 'HIGH');
  assert.ok(day.shortfall > 0);
  assert.ok(day.goals.find((g) => g.goal.id === 'OTHER')!.reason);
});
test('weekdays and paused targets produce a stable rest day without papers', (t) => {
  const { store, configure, at, make } = fixture(t),
    weekday = at.getUTCDay() || 7;
  configure({
    goals: [
      goal('REST', 'D1', 'CD1', { weekdays: [weekday === 7 ? 1 : weekday + 1] }),
      goal('PAUSED', 'D2', 'CD2', { enabled: false }),
    ],
  });
  const day = make();
  assert.equal(day.tasks.length, 0);
  assert.equal(day.totalPoints, 0);
  assert.equal(day.targetReviewPoints + day.targetNewPoints, 0);
  assert.equal(store.all('papers').length, 0);
});
test('mental recall updates plan progress once without creating answer statistics', (t) => {
  const { store, configure, make, act } = fixture(t);
  configure({ allocationMode: 'fixed', goals: [goal('ONE', 'D1', 'CD1')] });
  const day = make(),
    started = startLearningDay(store, day, { resume: true });
  let session = store.require<FocusSession>('focus_sessions', started.id);
  assert.equal(startLearningDay(store, day, { resume: true }).id, session.id);
  assert.equal(learningDayView(store, day).progress.completed, 0);
  session = act(session, 'reveal', { mode: 'mental' });
  assert.equal(learningDayView(store, day).progress.completed, 0);
  const request = focusActionSchema.parse({
    index: 0,
    revision: session.revision,
    action: 'rate',
    rating: 'good',
  });
  session = actFocus(store, session, request);
  actFocus(store, store.require('focus_sessions', session.id), request);
  assert.equal(learningDayView(store, day).progress.completed, 1);
  assert.equal(learningDayView(store, day).progress.answered, 0);
  assert.equal(questionStatistics(store, day.tasks[0]!.questionId).answered, 0);
  assert.equal(store.all('learning_task_results').length, 1);
});
test('written answers and review ratings remain distinct while total completion is deduplicated', (t) => {
  const { store, configure, make, act } = fixture(t);
  configure({ allocationMode: 'fixed', goals: [goal('ONE', 'D1', 'CD1')] });
  const day = make();
  let session = store.require<FocusSession>(
    'focus_sessions',
    startLearningDay(store, day, { resume: true }).id,
  );
  session = act(session, 'reveal', { mode: 'written', answer: 'true' });
  assert.equal(learningDayView(store, day).progress.completed, 1);
  assert.equal(learningDayView(store, day).progress.answered, 1);
  assert.equal(learningDayView(store, day).progress.reviewed, 0);
  const attempt = store.require<StoredAttempt>('attempts', session.items[0]!.attemptId!);
  assert.equal(attempt.paperId, day.goals[0]!.paperId);
  session = act(session, 'rate', { rating: 'good' });
  assert.equal(learningDayView(store, day).progress.completed, 1);
  assert.equal(learningDayView(store, day).progress.reviewed, 1);
  store.remove('attempts', attempt.id);
  store.remove('focus_sessions', session.id);
  assert.equal(learningDayView(store, day).progress.completed, 1);
});
test('a due group part keeps shared material and an ungraded answer waits for recall feedback', (t) => {
  const { store, configure, make, act } = fixture(t);
  store.put('categories', 'CG', {
    id: 'CG',
    domainId: 'D1',
    parentId: null,
    name: '程序',
    description: '',
    sortOrder: 0,
  });
  store.put(
    'questions',
    'GROUP',
    questionSchema.parse({
      id: 'GROUP',
      title: '程序',
      type: 'group',
      stemMarkdown: '共享程序材料',
      domainIds: ['D1'],
      categoryIds: ['CG'],
      status: 'published',
      parts: [
        {
          id: 'a',
          title: '第一问',
          type: 'true_false',
          stemMarkdown: '判断',
          correctAnswers: ['true'],
        },
        {
          id: 'b',
          title: '第二问',
          type: 'short_answer',
          stemMarkdown: '解释',
          answerMarkdown: '参考解释',
        },
      ],
    }),
  );
  store.putStudy({ ...store.study('GROUP', 'b'), nextReviewAt: '2020-01-01T00:00:00.000Z' });
  configure({
    allocationMode: 'fixed',
    goals: [goal('GROUP-GOAL', 'D1', 'CG', { reviewPoints: 3, newPoints: 0 })],
  });
  const day = make();
  assert.equal(day.tasks.length, 1);
  assert.equal(day.tasks[0]!.partId, 'b');
  let session = store.require<FocusSession>(
    'focus_sessions',
    startLearningDay(store, day, { resume: true }).id,
  );
  assert.equal(session.items[0]!.question.groupStemMarkdown, '共享程序材料');
  session = act(session, 'reveal', { mode: 'written', answer: '独立解释' });
  assert.equal(learningDayView(store, day).progress.completed, 0);
  assert.equal(learningDayView(store, day).progress.answered, 1);
  act(session, 'rate', { rating: 'good' });
  assert.equal(learningDayView(store, day).progress.completed, 1);
});
test('both-direction word goals are separate tasks and ordinary practice uses compatible batches', (t) => {
  const { store, configure, make } = fixture(t);
  store.put('categories', 'CW', {
    id: 'CW',
    domainId: 'D1',
    parentId: null,
    name: '词汇',
    description: '',
    sortOrder: 0,
  });
  store.put(
    'questions',
    'WORD',
    questionSchema.parse({
      id: 'WORD',
      title: 'abandon',
      type: 'short_answer',
      stemMarkdown: 'abandon',
      answerMarkdown: '放弃',
      domainIds: ['D1'],
      categoryIds: ['CW'],
      status: 'published',
      vocabulary: {
        language: 'en',
        headword: 'abandon',
        meaningPrompt: '放弃',
        acceptedAnswers: ['abandon'],
        pronunciations: [
          {
            label: '英式',
            ipa: 'əˈbændən',
            sourceLabel: '测试',
            sourceUrl: 'https://example.test/word',
            license: '测试',
            method: 'manual',
          },
        ],
      },
    }),
  );
  configure({
    allocationMode: 'fixed',
    goals: [goal('WORDS', 'D1', 'CW', { newPoints: 100, direction: 'both', mode: 'practice' })],
  });
  const day = make();
  assert.equal(day.tasks.length, 2);
  assert.deepEqual(
    new Set(day.tasks.map((t) => t.direction)),
    new Set(['word_to_meaning', 'meaning_to_word']),
  );
  const seen = new Set<string>();
  for (let i = 0; i < 2; i++) {
    const started = startLearningDay(store, day, { resume: true }),
      attempt = store.require<StoredAttempt>('attempts', started.id);
    assert.equal(attempt.questions.length, 1);
    seen.add(attempt.vocabularyDirection!);
    assert.equal(
      attempt.questions[0]!.type,
      attempt.vocabularyDirection === 'meaning_to_word' ? 'fill_blank' : 'short_answer',
    );
    submitAttempt(store, attempt, {
      WORD: { value: attempt.vocabularyDirection === 'meaning_to_word' ? ['abandon'] : '放弃' },
    });
  }
  assert.deepEqual(seen, new Set(['word_to_meaning', 'meaning_to_word']));
  assert.equal(learningDayView(store, day).progress.completed, 2);
  const target = new Store(':memory:');
  t.after(() => target.db.close());
  importData(target, exportData(store));
  assert.equal(
    learningDayView(target, target.require('learning_days', day.id)).progress.completed,
    2,
  );
});
test('plan tasks survive migration and history cleanup, while reset clears completion and closes drafts', (t) => {
  const { store, configure, make, act } = fixture(t);
  configure({ allocationMode: 'fixed', goals: [goal('ONE', 'D1', 'CD1', { newPoints: 4 })] });
  const day = make();
  let session = store.require<FocusSession>(
    'focus_sessions',
    startLearningDay(store, day, { resume: true }).id,
  );
  session = act(session, 'reveal', { mode: 'mental' });
  session = act(session, 'rate', { rating: 'good' });
  const target = new Store(':memory:');
  t.after(() => target.db.close());
  importData(target, exportData(store));
  assert.equal(
    learningDayView(target, target.require('learning_days', day.id)).progress.completed,
    1,
  );
  const preview = learningResetPreview(target);
  resetLearningProgress(target, preview.fingerprint);
  assert.equal(
    learningDayView(target, target.require('learning_days', day.id)).progress.completed,
    0,
  );
  assert.equal(target.require<FocusSession>('focus_sessions', session.id).status, 'submitted');
});
test('progress ignores evidence from other dates, directions, parts and pre-generation answers', (t) => {
  const { store, configure, make } = fixture(t);
  configure({ allocationMode: 'fixed', goals: [goal('ONE', 'D1', 'CD1')] });
  const day = make(),
    task = day.tasks[0]!;
  for (const event of [
    {
      questionId: task.questionId,
      direction: 'meaning_to_word' as const,
      at: new Date().toISOString(),
    },
    {
      questionId: task.questionId,
      partId: 'other',
      direction: 'standard' as const,
      at: new Date().toISOString(),
    },
    { questionId: task.questionId, direction: 'standard' as const, at: '2020-01-01T00:00:00.000Z' },
  ])
    recordPlanEvidence(store, [{ ...event, kind: 'review', sourceId: 'test-evidence' }]);
  assert.equal(learningDayView(store, day).progress.completed, 0);
});
test('plan APIs are read-only when loading, paginate history, and include goal progress in analytics', async (t) => {
  const { store, make } = fixture(t),
    day = make(),
    app = await buildApp({ databasePath: ':memory:', dailyPushScheduler: false });
  t.after(() => app.close());
  const imported = await app.inject({
    method: 'POST',
    url: '/api/import',
    payload: { mode: 'merge', data: exportData(store) },
  });
  assert.equal(imported.statusCode, 200, imported.body);
  const before = (await app.inject('/api/export')).json();
  delete before.exportedAt;
  const view = await app.inject(`/api/learning-plans/${day.id}`);
  assert.equal(view.statusCode, 200);
  assert.equal(view.json().tasks.length, day.tasks.length);
  assert.doesNotMatch(view.body, /参考答案隐私标记/);
  const list = await app.inject('/api/learning-plans?page=1&pageSize=10');
  assert.equal(list.json().total, 1);
  assert.equal('tasks' in list.json().items[0], false);
  const after = (await app.inject('/api/export')).json();
  delete after.exportedAt;
  assert.deepEqual(after, before);
  const stats = learningPlanAnalytics(store, day.dateKey, day.dateKey);
  assert.equal(stats.days, 1);
  assert.equal(stats.goals.length, 2);
  assert.equal(stats.completedPoints, 0);
});

test('late work credits its original plan without completing the same card in today plan', (t) => {
  const { store, configure, at, act } = fixture(t);
  for (let i = 1; i < 30; i++) store.remove('questions', `D1-${i}`);
  configure({ allocationMode: 'fixed', goals: [goal('ONE', 'D1', 'CD1', { newPoints: 1 })] });
  const old = generateLearningDay(store, new Date(at.getTime() - 10 * 86400000)).plan!,
    today = generateLearningDay(store, at).plan!;
  assert.equal(old.tasks[0]!.questionId, today.tasks[0]!.questionId);
  let session = store.require<FocusSession>(
    'focus_sessions',
    startLearningDay(store, old, { resume: true }).id,
  );
  session = act(session, 'reveal', { mode: 'mental' });
  act(session, 'rate', { rating: 'good' });
  assert.equal(learningDayView(store, old).progress.completed, 1);
  assert.equal(learningDayView(store, today).progress.completed, 0);
});

test('daily plans include long-term reviews due later today but wait for minute-based relearning', (t) => {
  const { store, configure } = fixture(t),
    at = new Date('2026-10-20T12:00:00Z');
  recordManualReview(
    store,
    { questionId: 'D1-0', rating: 'easy', requestId: 'long-term' },
    new Date(at.getTime() - 86400000),
  );
  changeReviewCard(
    store,
    { questionId: 'D1-0', dueAt: new Date(at.getTime() + 3600000).toISOString() },
    at,
  );
  recordManualReview(store, { questionId: 'D1-1', rating: 'again', requestId: 'short-term' }, at);
  configure({
    allocationMode: 'fixed',
    goals: [goal('ONE', 'D1', 'CD1', { reviewPoints: 1, newPoints: 0 })],
  });
  const day = generateLearningDay(store, at).plan!;
  assert.ok(day.tasks.some((t) => t.questionId === 'D1-0' && t.kind === 'review'));
  assert.ok(!day.tasks.some((t) => t.questionId === 'D1-1'));
});

test('tag filters include descendant categories and selection does not load question bodies', (t) => {
  const { store, configure, at } = fixture(t);
  store.put('categories', 'CHILD', {
    id: 'CHILD',
    domainId: 'D1',
    parentId: 'CD1',
    name: '下级',
    description: '',
    sortOrder: 0,
  });
  store.put('tags', 'TAG', {
    id: 'TAG',
    name: '通用',
    color: '#abcdef',
    description: '',
    domainId: null,
    kind: 'custom',
  });
  const q = store.require<any>('questions', 'D1-0');
  store.put('questions', q.id, {
    ...q,
    stemMarkdown: 'QUESTION_BODY_PRIVATE_CANARY',
    categoryIds: ['CHILD'],
    tagIds: ['TAG'],
  });
  configure({ allocationMode: 'fixed', goals: [goal('TAGGED', 'D1', 'CD1', { tagIds: ['TAG'] })] });
  store.database.projections.refreshAll();
  const all = store.database.all.bind(store.database);
  store.database.all = ((query: any) => {
    const rows = all(query);
    assert.doesNotMatch(JSON.stringify(rows), /QUESTION_BODY_PRIVATE_CANARY/);
    return rows;
  }) as typeof store.database.all;
  const settings = getSettings(store),
    date = at.toISOString().slice(0, 10),
    selected = selectPlanTasks(store, settings.dailyPush, settings, date, at);
  assert.equal(selected.tasks.length, 1);
  assert.equal(selected.tasks[0]!.questionId, 'D1-0');
});

test('configuration validates fixed budgets and duplicate IDs without requiring fifty points per goal', (t) => {
  const { store, goals } = fixture(t);
  const config = {
    ...getSettings(store).dailyPush,
    allocationMode: 'fixed' as const,
    goals: [{ ...goals[0]!, newPoints: 1 }],
  };
  assert.doesNotThrow(() =>
    validateDailyPushConfiguration(store, dailyPushSettingsSchema.parse(config)),
  );
  assert.throws(
    () => validateDailyPushConfiguration(store, { ...config, goals: [goals[0]!, goals[0]!] }),
    /不可重复/,
  );
  assert.throws(
    () =>
      validateDailyPushConfiguration(store, {
        ...config,
        goals: [{ ...goals[0]!, newPoints: 0, reviewPoints: 0 }],
      }),
    /大于0/,
  );
  assert.throws(
    () =>
      validateDailyPushConfiguration(store, {
        ...config,
        goals: [
          { ...goals[0]!, newPoints: 10000 },
          { ...goals[1]!, newPoints: 1 },
        ],
      }),
    /10000/,
  );
});

test('invalid task references roll back imports and different same-date plans cannot mix progress', (t) => {
  const { store, make } = fixture(t),
    day = make(),
    data = exportData(store) as any,
    target = new Store(':memory:');
  t.after(() => target.db.close());
  const corrupted = structuredClone(data);
  corrupted.learningTaskResults = [
    {
      id: JSON.stringify([day.id, 'missing']),
      dayId: day.id,
      taskId: 'missing',
      answeredAt: new Date().toISOString(),
      reviewedAt: null,
      completedAt: new Date().toISOString(),
      attemptId: 'unknown',
      reviewId: null,
    },
  ];
  assert.throws(() => importData(target, corrupted));
  assert.equal(target.all('questions').length, 0);
  importData(target, data);
  const different = structuredClone(data);
  different.learningDays[0].goals[0].goal.name = '另一个同日计划';
  assert.throws(() => importData(target, different), /不同的同日学习计划/);
  assert.deepEqual(target.require('learning_days', day.id), day);
});

test('goal focus drafts retain their own paper limits without evicting global review drafts', (t) => {
  const { store, configure, make } = fixture(t);
  store.putStudy({ ...store.study('D1-0'), nextReviewAt: '2020-01-01T00:00:00.000Z' });
  const global = Array.from(
    { length: 3 },
    () => createFocus(store, createFocusSchema.parse({ count: 1 })).id,
  );
  configure({
    allocationMode: 'fixed',
    goals: Array.from({ length: 5 }, (_, i) => goal('GOAL-' + i, 'D1', 'CD1')),
  });
  const day = make();
  const sessions = day.goals.map((g) => ({
    id: startLearningDay(store, day, { goalId: g.goal.id, resume: true }).id,
    paperId: g.paperId,
  }));
  for (const item of sessions)
    assert.equal(store.require<FocusSession>('focus_sessions', item.id).paperId, item.paperId);
  for (const id of global) assert.ok(store.get('focus_sessions', id));
  const first = day.goals[0]!;
  for (let i = 0; i < 4; i++)
    startLearningDay(store, day, { goalId: first.goal.id, resume: false });
  assert.ok(store.get('focus_sessions', sessions[1]!.id));
  assert.equal(
    store.all<FocusSession>('focus_sessions').filter((s) => s.paperId === first.paperId).length,
    3,
  );
});
