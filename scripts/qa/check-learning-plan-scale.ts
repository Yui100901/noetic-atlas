/** Synthetic in-memory capacity check. No local database or AI configuration. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Store } from '../../server/core/store.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';
import { questionSchema } from '../../server/core/validation.js';
import { learningGoalSchema } from '../../server/modules/learning-plans/schema.js';
import { selectPlanTasks } from '../../server/modules/learning-plans/selection.js';
import { generateLearningDay } from '../../server/modules/learning-plans/service.js';
import { dailyPushOverview } from '../../server/modules/daily-push/service.js';

const store = new Store(':memory:');
try {
  store.put('domains', 'SCALE', { id: 'SCALE', name: '规模测试', description: '', sortOrder: 0 });
  store.put('categories', 'SCALE-C', {
    id: 'SCALE-C',
    domainId: 'SCALE',
    name: '通用基础',
    parentId: null,
    description: '',
    sortOrder: 0,
  });
  const template = questionSchema.parse({
    id: 'TEMPLATE',
    title: '知识点',
    type: 'true_false',
    stemMarkdown: 'BODY_PRIVATE_CANARY ' + '测试内容。'.repeat(180),
    answerMarkdown: 'ANSWER_PRIVATE_CANARY',
    correctAnswers: ['true'],
    categoryIds: ['SCALE-C'],
    status: 'published',
  });
  store.transaction(() => {
    for (let i = 0; i < 30000; i++)
      store.put('questions', 'SCALE-' + i, { ...template, id: 'SCALE-' + i, title: '知识点' + i });
  });
  store.database.projections.refreshAll();
  const goals = Array.from({ length: 30 }, (_, i) =>
    learningGoalSchema.parse({
      id: 'GOAL-' + i,
      name: '重叠目标' + i,
      enabled: true,
      domainId: 'SCALE',
      categoryIds: ['SCALE-C'],
      tagIds: [],
      tagMode: 'all',
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      priority: 3,
      weight: 1,
      reviewPoints: 0,
      newPoints: 2,
      mode: 'focus',
      direction: 'default',
    }),
  );
  const settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    dailyPush: { ...DEFAULT_SETTINGS.dailyPush, enabled: true, timeZone: 'UTC', goals },
  };
  store.put('settings', 'system', settings);
  const all = store.database.all.bind(store.database);
  let rows = 0;
  store.database.all = ((query: any) => {
    const result = all(query);
    rows += result.length;
    assert.doesNotMatch(JSON.stringify(result), /BODY_PRIVATE_CANARY|ANSWER_PRIVATE_CANARY/);
    return result;
  }) as typeof store.database.all;
  const at = new Date(),
    started = performance.now(),
    selected = selectPlanTasks(
      store,
      settings.dailyPush,
      settings,
      at.toISOString().slice(0, 10),
      at,
    ),
    selectionMilliseconds = performance.now() - started;
  assert.ok(selected.tasks.length <= 500);
  assert.ok(selected.tasks.reduce((n, t) => n + t.points, 0) >= 50);
  assert.equal(
    new Set(selected.tasks.map((t) => JSON.stringify([t.questionId, t.partId, t.direction]))).size,
    selected.tasks.length,
  );
  store.database.all = all;
  const generatedAt = performance.now(),
    day = generateLearningDay(store, at).plan!,
    generationMilliseconds = performance.now() - generatedAt;
  const readAt = performance.now(),
    overview = dailyPushOverview(store, at),
    overviewMilliseconds = performance.now() - readAt,
    body = JSON.stringify(overview);
  assert.doesNotMatch(body, /BODY_PRIVATE_CANARY|ANSWER_PRIVATE_CANARY/);
  assert.equal('tasks' in overview.plan!, false);
  assert.equal(overview.plan!.goals.length, 30);
  const report = {
    questions: 30000,
    overlappingGoals: 30,
    tasks: day.tasks.length,
    selectionMilliseconds: Math.round(selectionMilliseconds),
    generationMilliseconds: Math.round(generationMilliseconds),
    overviewMilliseconds: Math.round(overviewMilliseconds),
    overviewBytes: Buffer.byteLength(body),
    metadataRowsRead: rows,
  };
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/learning-plans-scale.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  store.db.close();
}
