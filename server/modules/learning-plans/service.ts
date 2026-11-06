import type { Store } from '../../core/store.js';
import { makeId } from '../../core/store.js';
import { parse } from '../../core/validation.js';
import type { LearningDay } from '../../../shared/models/learning-plan.js';
import { getSettings } from '../settings/service.js';
import { dailyCalendar, isDailyPushDue } from '../daily-push/calendar.js';
import { buildPaper } from '../practice/service.js';
import { validateGoalReferences, learningDaySchema } from './schema.js';
import { selectPlanTasks } from './selection.js';
import { configuredGoals } from './time.js';

/** The day is claimed under one transaction; goals/settings are frozen once. */
export function generateLearningDay(store: Store, at = new Date()) {
  const settings = getSettings(store),
    config = settings.dailyPush,
    dateKey = dailyCalendar(at, config.timeZone).dateKey,
    id = `plan-${dateKey}`;
  const current = store.get<LearningDay>('learning_days', id);
  if (
    current ||
    !configuredGoals(config).length ||
    !isDailyPushDue(config, at) ||
    store.get('daily_pushes', `daily-${dateKey}`)
  )
    return { generated: false, plan: current || null };
  return store.transaction(() => {
    const locked = getSettings(store);
    if (
      locked.updatedAt !== settings.updatedAt ||
      !configuredGoals(locked.dailyPush).length ||
      !isDailyPushDue(locked.dailyPush, at) ||
      dailyCalendar(at, locked.dailyPush.timeZone).dateKey !== dateKey ||
      store.get('daily_pushes', `daily-${dateKey}`)
    )
      return { generated: false, plan: null };
    const previous = store.get<LearningDay>('learning_days', id);
    if (previous) return { generated: false, plan: previous };
    validateGoalReferences(store, configuredGoals(config));
    const selection = selectPlanTasks(store, config, settings, dateKey, at);
    for (const goal of selection.goals) {
      const tasks = selection.tasks.filter((t) => t.goalId === goal.goal.id);
      if (!tasks.length) continue;
      const questionIds = [...new Set(tasks.map((t) => t.questionId))],
        questionPoints = Object.fromEntries(
          questionIds.map((id) => [
            id,
            Number(
              tasks
                .filter((t) => t.questionId === id)
                .reduce((n, t) => n + t.points, 0)
                .toFixed(2),
            ),
          ]),
        );
      const paper = buildPaper(store, {
        id: makeId('daily-goal'),
        title: `${dateKey} 每日推荐 · ${goal.goal.name}`.slice(0, 300),
        description: `学习目标：${goal.goal.name}。具体小题与词卡方向请从每日学习计划进入；题集保留完整材料。${goal.reason}`,
        mode: 'manual',
        organization: 'domain',
        domainId: goal.goal.domainId,
        questionIds,
        scoring: {
          enabled: true,
          totalPoints: goal.totalPoints,
          questionPoints,
          pointsByType: { ...settings.pointsByType },
        },
      });
      store.insert('papers', paper.id, paper);
      goal.paperId = paper.id;
    }
    const totalPoints = Number(selection.tasks.reduce((n, t) => n + t.points, 0).toFixed(2));
    const plan = parse(learningDaySchema, {
      id,
      dateKey,
      generatedAt: at.toISOString(),
      timeZone: config.timeZone,
      title: `${dateKey} 每日学习计划`,
      readAt: null,
      allocationMode: config.allocationMode || 'weights',
      ...selection,
      totalPoints,
      shortfall: Number(
        Math.max(0, selection.targetReviewPoints + selection.targetNewPoints - totalPoints).toFixed(
          2,
        ),
      ),
    }) as LearningDay;
    store.insert('learning_days', id, plan);
    return { generated: true, plan };
  });
}
