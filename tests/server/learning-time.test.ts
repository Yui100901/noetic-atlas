import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../server/core/store.js';
import { questionSchema } from '../../server/core/validation.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';
import { DEFAULT_LEARNING_TIME_BUDGET } from '../../shared/models/learning-time.js';
import { dailyPushSettingsSchema } from '../../server/modules/daily-push/schema.js';
import { generateLearningDay } from '../../server/modules/learning-plans/service.js';
import { learningDaySchema } from '../../server/modules/learning-plans/schema.js';
import { learningWeek, taskTimeEstimates } from '../../server/modules/learning-plans/time.js';
import { checkDailyPush } from '../../server/modules/daily-push/service.js';
import { buildApp } from '../../server/index.js';
import { exportData, importData } from '../../server/modules/transfer/migration.js';

const at = new Date('2026-11-05T10:00:00Z');
function fixture(t: test.TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.database.close());
  store.put('domains', 'D', { id: 'D', name: '计算机', description: '', sortOrder: 0 });
  store.put('categories', 'C', {
    id: 'C',
    name: '基础',
    domainId: 'D',
    parentId: null,
    description: '',
    sortOrder: 0,
  });
  for (let index = 0; index < 15; index++) {
    const q = questionSchema.parse({
      id: 'q' + index,
      title: '判断' + index,
      type: 'true_false',
      stemMarkdown: '测试判断',
      correctAnswers: ['true'],
      status: 'published',
      categoryIds: ['C'],
    });
    store.put('questions', q.id, q);
  }
  store.put('settings', 'system', {
    ...structuredClone(DEFAULT_SETTINGS),
    dailyPush: {
      ...DEFAULT_SETTINGS.dailyPush,
      enabled: true,
      domainId: 'D',
      categoryIds: ['C'],
      timeZone: 'UTC',
      timeBudget: {
        ...DEFAULT_LEARNING_TIME_BUDGET,
        enabled: true,
        weekdayMinutes: 1,
        weekendMinutes: 2,
      },
    },
  });
  return store;
}
test('optional time configuration validates without changing the clean default point mode', () => {
  assert.equal(dailyPushSettingsSchema.parse(DEFAULT_SETTINGS.dailyPush).timeBudget, undefined);
  assert.equal(
    dailyPushSettingsSchema.safeParse({
      ...DEFAULT_SETTINGS.dailyPush,
      timeBudget: {
        ...DEFAULT_LEARNING_TIME_BUDGET,
        enabled: true,
        weekdayMinutes: 0,
        weekendMinutes: 0,
      },
    }).success,
    false,
  );
  assert.equal(
    dailyPushSettingsSchema.safeParse({
      ...DEFAULT_SETTINGS.dailyPush,
      timeBudget: { ...DEFAULT_LEARNING_TIME_BUDGET, weeklyMinutes: -1 },
    }).success,
    false,
  );
});
test('single-domain time mode creates a bounded frozen plan instead of converting points to minutes', (t) => {
  const store = fixture(t),
    day = generateLearningDay(store, at).plan!;
  assert.equal(day.tasks.length, 1);
  assert.deepEqual(day.timeBudget, {
    targetSeconds: 60,
    estimatedSeconds: 45,
    measuredTasks: 0,
    defaultTasks: 1,
    limited: true,
  });
  assert.equal(day.totalPoints, 1);
  assert.equal(day.shortfall, 0);
  assert.equal(day.tasks[0]!.estimateSource, 'default');
  assert.equal(learningDaySchema.safeParse(day).success, true);
  const settings = store.require<any>('settings', 'system');
  settings.dailyPush.timeBudget.weekdayMinutes = 10;
  store.put('settings', 'system', settings);
  assert.deepEqual(generateLearningDay(store, at).plan, day);
  assert.equal(checkDailyPush(store, at).generated, false);
});
test('measured single-item samples use a median and never divide mixed paper duration', (t) => {
  const store = fixture(t);
  for (const [index, seconds] of [18, 20, 22].entries())
    store.put('learning_results', 'sample' + index, {
      id: 'sample' + index,
      elapsedSeconds: seconds,
      submittedAt: `2026-11-04T10:0${index}:00Z`,
      items: [{ type: 'true_false', answered: true }],
    });
  store.put('learning_results', 'paper', {
    id: 'paper',
    elapsedSeconds: 1,
    submittedAt: '2026-11-04T11:00:00Z',
    items: [
      { type: 'true_false', answered: true },
      { type: 'true_false', answered: true },
    ],
  });
  assert.deepEqual(taskTimeEstimates(store)('true_false'), {
    estimatedSeconds: 20,
    estimateSource: 'measured',
  });
  const day = generateLearningDay(store, at).plan!;
  assert.equal(day.tasks.length, 3);
  assert.equal(day.timeBudget!.estimatedSeconds, 60);
  assert.equal(day.timeBudget!.measuredTasks, 3);
  assert.deepEqual(taskTimeEstimates(store)('short_answer', 'vocabulary'), {
    estimatedSeconds: 30,
    estimateSource: 'default',
  });
});
test('zero day budgets and oversize subjective tasks produce an explicit empty day without exceeding time', (t) => {
  const store = fixture(t),
    settings = store.require<any>('settings', 'system');
  settings.dailyPush.timeBudget.weekdayMinutes = 0;
  store.put('settings', 'system', settings);
  const rest = generateLearningDay(store, at).plan!;
  assert.equal(rest.tasks.length, 0);
  assert.equal(rest.timeBudget!.targetSeconds, 0);
  assert.equal(rest.goals[0]!.paperId, null);
  assert.equal(
    learningDaySchema.safeParse({
      ...rest,
      timeBudget: { ...rest.timeBudget, estimatedSeconds: 1 },
    }).success,
    false,
  );
});
test('a due review can borrow another goal share before any new task consumes the day budget', (t) => {
  const store = fixture(t),
    settings = store.require<any>('settings', 'system');
  store.put(
    'questions',
    'q0',
    questionSchema.parse({
      ...store.require<any>('questions', 'q0'),
      type: 'multiple_choice',
      options: [
        { key: 'A', text: '甲' },
        { key: 'B', text: '乙' },
      ],
      correctAnswers: ['A', 'B'],
    }),
  );
  store.put('study', 'q0', {
    questionId: 'q0',
    favorite: false,
    notes: '',
    mastery: 1,
    wrongCount: 0,
    lastReviewedAt: '2026-10-01T10:00:00Z',
    nextReviewAt: '2026-10-02T10:00:00Z',
  });
  settings.reviewScheduling.strategy = 'fixed';
  settings.dailyPush.timeBudget.weekdayMinutes = 2;
  settings.dailyPush.goals = ['G1', 'G2'].map((id) => ({
    id,
    name: id,
    enabled: true,
    domainId: 'D',
    categoryIds: ['C'],
    tagIds: [],
    tagMode: 'all',
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    priority: 3,
    weight: 1,
    reviewPoints: 30,
    newPoints: 20,
    mode: 'focus',
    direction: 'default',
  }));
  store.put('settings', 'system', settings);
  const day = generateLearningDay(store, at).plan!;
  assert.equal(day.tasks.length, 1);
  assert.equal(day.tasks[0]!.questionId, 'q0');
  assert.equal(day.tasks[0]!.kind, 'review');
  assert.equal(day.timeBudget!.estimatedSeconds, 90);
  assert.equal(new Set(day.tasks.map((task) => task.id)).size, day.tasks.length);
});
test('weekly elapsed time deduplicates retained/compact answers, excludes focus children, resets and unknown timing', (t) => {
  const store = fixture(t),
    stamp = '2026-11-04T10:00:00Z';
  store.put('learning_results', 'A', {
    id: 'A',
    submittedAt: stamp,
    elapsedSeconds: 100,
    paperTitle: '练习',
  });
  store.put('attempts', 'A', {
    id: 'A',
    status: 'submitted',
    submittedAt: stamp,
    elapsedSeconds: 100,
    paperTitle: '练习',
  });
  store.put('learning_results', 'child', {
    id: 'child',
    submittedAt: stamp,
    elapsedSeconds: 40,
    focusSessionId: 'focus',
    paperTitle: '专注复习 · 练习',
  });
  store.put('focus_sessions', 'focus', {
    id: 'focus',
    status: 'submitted',
    submittedAt: stamp,
    elapsedSeconds: 90,
  });
  store.put('learning_results', 'reset', {
    id: 'reset',
    submittedAt: stamp,
    elapsedSeconds: 999,
    reset: true,
  });
  store.put('learning_results', 'unknown', {
    id: 'unknown',
    submittedAt: stamp,
    paperTitle: '旧题',
  });
  store.put('attempts', 'draft', {
    id: 'draft',
    status: 'in_progress',
    updatedAt: stamp,
    elapsedSeconds: 25,
  });
  store.put('attempts', 'focus-draft-child', {
    id: 'focus-draft-child',
    status: 'in_progress',
    updatedAt: stamp,
    elapsedSeconds: 30,
    focusSessionId: 'focus-draft',
  });
  store.put('focus_sessions', 'focus-draft', {
    id: 'focus-draft',
    status: 'in_progress',
    updatedAt: stamp,
    elapsedSeconds: 60,
  });
  const week = learningWeek(store, undefined, at);
  assert.equal(week.from, '2026-11-02');
  assert.equal(week.to, '2026-11-08');
  assert.equal(week.targetMinutes, 9);
  assert.equal(week.elapsedSeconds, 190);
  assert.equal(week.timedSessions, 2);
  assert.equal(week.missingTimeSessions, 1);
  assert.equal(week.inProgressSeconds, 85);
  assert.equal(
    week.daily.reduce((sum, day) => sum + day.elapsedSeconds, 0),
    190,
  );
});
test('a weekly target works independently from minute-based task selection', (t) => {
  const store = fixture(t),
    settings = store.require<any>('settings', 'system');
  settings.dailyPush.timeBudget.enabled = false;
  settings.dailyPush.timeBudget.weeklyMinutes = 120;
  store.put('settings', 'system', settings);
  const week = learningWeek(store, undefined, at);
  assert.equal(week.targetMinutes, 120);
  assert.equal(week.targetSource, 'explicit');
  assert.ok(week.daily.every((day) => day.targetMinutes === 0));
  assert.equal(checkDailyPush(store, at).generated, true);
  assert.equal(store.get('learning_days', 'plan-2026-11-05'), undefined);
});
test('week boundaries use the configured time zone and explicit goal without counting future sessions', (t) => {
  const store = fixture(t),
    settings = store.require<any>('settings', 'system');
  settings.dailyPush.timeZone = 'Asia/Shanghai';
  settings.dailyPush.timeBudget.weeklyMinutes = 120;
  store.put('settings', 'system', settings);
  store.put('learning_results', 'sunday-utc', {
    id: 'sunday-utc',
    submittedAt: '2026-11-01T16:30:00Z',
    elapsedSeconds: 60,
    paperTitle: '周一',
  });
  store.put('learning_results', 'prior', {
    id: 'prior',
    submittedAt: '2026-11-01T15:59:00Z',
    elapsedSeconds: 600,
    paperTitle: '周日',
  });
  store.put('learning_results', 'future', {
    id: 'future',
    submittedAt: '2026-11-08T10:00:00Z',
    elapsedSeconds: 600,
    paperTitle: '未来',
  });
  const week = learningWeek(store, '2026-11-05', at);
  assert.equal(week.elapsedSeconds, 60);
  assert.equal(week.targetMinutes, 120);
  assert.equal(week.targetSource, 'explicit');
  assert.equal(week.daily[0]!.elapsedSeconds, 60);
});
test('time settings and frozen plan estimates survive a complete migration', (t) => {
  const store = fixture(t),
    day = generateLearningDay(store, at).plan!,
    other = new Store(':memory:');
  t.after(() => other.database.close());
  importData(other, exportData(store));
  assert.deepEqual(
    other.require<any>('settings', 'system').dailyPush.timeBudget,
    store.require<any>('settings', 'system').dailyPush.timeBudget,
  );
  assert.deepEqual(other.require('learning_days', day.id), day);
});
test('week API validates dates and remains available with an empty installation', async () => {
  const app = await buildApp({
    databasePath: ':memory:',
    seedPath: 'missing-test-seed',
    dailyPushScheduler: false,
  });
  try {
    const response = await app.inject('/api/learning-plans/week');
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().targetMinutes, 0);
    assert.equal((await app.inject('/api/learning-plans/week?date=2026-02-31')).statusCode, 400);
  } finally {
    await app.close();
  }
});
