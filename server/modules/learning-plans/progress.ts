import type { Store } from '../../core/store.js';
import type {
  LearningDay,
  LearningDayView,
  LearningPlanProgress,
  LearningTask,
  LearningTaskResult,
  LearningPlanAnalytics,
} from '../../../shared/models/learning-plan.js';
import type { ReviewDirection } from '../../../shared/models/adaptive-review.js';
import { dailyCalendar } from '../daily-push/calendar.js';

export interface PlanEvidence {
  dayId?: string;
  questionId: string;
  partId?: string;
  direction: ReviewDirection;
  at: string;
  kind: 'answer' | 'review';
  sourceId: string;
}
/** Persist completion independently of answer-history and focus-session retention. */
export function recordPlanEvidence(
  store: Store,
  evidence: PlanEvidence[],
  onlyTaskResults?: ReadonlySet<string>,
) {
  if (!evidence.length) return;
  const db = store.database,
    x = db.expressions;
  // A broad UTC date window accommodates every valid plan time zone.
  const instants = evidence.map((e) => Date.parse(e.at)).filter(Number.isFinite);
  if (!instants.length) return;
  const lower = new Date(Math.min(...instants) - 2 * 86400000).toISOString().slice(0, 10),
    upper = new Date(Math.max(...instants) + 2 * 86400000).toISOString().slice(0, 10);
  const explicit = [...new Set(evidence.flatMap((e) => (e.dayId ? [e.dayId] : [])))];
  const days = db
    .all(
      db.query
        .selectFrom('learning_days')
        .select('data')
        .where((eb) =>
          eb.or([
            eb.and([
              eb(x.field('data', 'dateKey'), '>=', lower),
              eb(x.field('data', 'dateKey'), '<=', upper),
            ]),
            ...(explicit.length ? [x.idInJson('id', explicit)] : []),
          ]),
        ),
    )
    .map((row) => JSON.parse(row.data) as LearningDay);
  for (const day of days)
    for (const event of evidence) {
      if (
        Date.parse(event.at) < Date.parse(day.generatedAt) ||
        (event.dayId
          ? event.dayId !== day.id
          : dailyCalendar(new Date(event.at), day.timeZone).dateKey !== day.dateKey)
      )
        continue;
      for (const task of day.tasks) {
        if (onlyTaskResults && !onlyTaskResults.has(JSON.stringify([day.id, task.id]))) continue;
        if (
          task.questionId !== event.questionId ||
          task.partId !== event.partId ||
          (task.direction !== event.direction &&
            !(task.direction === 'word_to_meaning' && event.direction === 'standard'))
        )
          continue;
        const id = JSON.stringify([day.id, task.id]),
          previous = store.get<LearningTaskResult>('learning_task_results', id),
          value: LearningTaskResult = previous
            ? structuredClone(previous)
            : {
                id,
                dayId: day.id,
                taskId: task.id,
                answeredAt: null,
                reviewedAt: null,
                completedAt: null,
                attemptId: null,
                reviewId: null,
              };
        if (event.kind === 'answer' && !value.answeredAt) {
          value.answeredAt = event.at;
          value.attemptId = event.sourceId;
        }
        if (event.kind === 'review' && !value.reviewedAt) {
          value.reviewedAt = event.at;
          value.reviewId = event.sourceId;
        }
        if (!value.completedAt && (value.reviewedAt || (task.kind === 'new' && value.answeredAt)))
          value.completedAt = event.at;
        if (JSON.stringify(previous) !== JSON.stringify(value))
          store.put('learning_task_results', id, value);
      }
    }
}
export function measurePlan(
  tasks: ReadonlyArray<Pick<LearningTask, 'id' | 'points'>>,
  results: Map<string, LearningTaskResult>,
): LearningPlanProgress {
  const completed = tasks.filter((t) => results.get(t.id)?.completedAt),
    totalPoints = Number(tasks.reduce((n, t) => n + t.points, 0).toFixed(2)),
    completedPoints = Number(completed.reduce((n, t) => n + t.points, 0).toFixed(2));
  return {
    total: tasks.length,
    completed: completed.length,
    answered: tasks.filter((t) => results.get(t.id)?.answeredAt).length,
    reviewed: tasks.filter((t) => results.get(t.id)?.reviewedAt).length,
    completedPoints,
    totalPoints,
    percent: totalPoints ? Math.round((completedPoints / totalPoints) * 10000) / 100 : 0,
  };
}
export function planResults(store: Store, ids: string[]) {
  const db = store.database,
    x = db.expressions;
  return ids.length
    ? db.all(
        db.query
          .selectFrom('learning_task_results')
          .select('id')
          .select([
            x.field<string>('data', 'dayId').as('dayId'),
            x.field<string>('data', 'taskId').as('taskId'),
            ...(['answeredAt', 'reviewedAt', 'completedAt', 'attemptId', 'reviewId'] as const).map(
              (key) => x.field<string | null>('data', key).as(key),
            ),
          ])
          .where(x.field('data', 'dayId'), 'in', ids),
      )
    : [];
}
export function learningDayView(store: Store, day: LearningDay): LearningDayView {
  const db = store.database,
    x = db.expressions,
    results = new Map(planResults(store, [day.id]).map((r) => [r.taskId, r])),
    paperIds = day.goals.flatMap((g) => (g.paperId ? [g.paperId] : []));
  const available = new Map(
    paperIds.length
      ? db
          .all(
            db.query
              .selectFrom('papers')
              .select('id')
              .select(x.field<boolean>('data', 'archived').as('archived'))
              .where(x.idInJson('id', paperIds)),
          )
          .map((row) => [row.id, !row.archived])
      : [],
  );
  const drafts = db
    .all(
      db.query
        .selectFrom('focus_sessions')
        .select(x.field<string>('data', 'summary').as('summary'))
        .select(x.field<string | undefined>('data', 'learningGoalId').as('goalId'))
        .where(x.field('data', 'learningDayId'), '=', day.id)
        .where(x.field('data', 'status'), '=', 'in_progress')
        .orderBy(x.field('data', 'updatedAt'), 'desc')
        .limit(100),
    )
    .map((row) => ({ ...JSON.parse(row.summary), ...(row.goalId ? { goalId: row.goalId } : {}) }));
  const practiceDrafts = db.all(
    db.query
      .selectFrom('attempts')
      .select('id')
      .select([
        x.field<string>('data', 'paperTitle').as('title'),
        x.field<string>('data', 'updatedAt').as('updatedAt'),
        x.field<string>('data', 'learningGoalId').as('goalId'),
      ])
      .where(x.field('data', 'learningDayId'), '=', day.id)
      .where(x.field('data', 'status'), '=', 'in_progress')
      .orderBy(x.field('data', 'updatedAt'), 'desc')
      .limit(100),
  );
  return {
    ...day,
    practiceDrafts,
    progress: measurePlan(day.tasks, results),
    goalProgress: Object.fromEntries(
      day.goals.map((g) => [
        g.goal.id,
        measurePlan(
          day.tasks.filter((t) => t.goalId === g.goal.id),
          results,
        ),
      ]),
    ),
    taskProgress: Object.fromEntries(results),
    focusDrafts: drafts,
    paperAvailability: Object.fromEntries(available),
  };
}
export function learningPlanAnalytics(
  store: Store,
  from: string,
  to: string,
): LearningPlanAnalytics {
  const db = store.database,
    x = db.expressions,
    days = db
      .all(
        db.query
          .selectFrom('learning_days')
          .select('id')
          .select([
            x.field<string>('data', 'dateKey').as('dateKey'),
            x.field<number>('data', 'targetReviewPoints').as('targetReviewPoints'),
            x.field<number>('data', 'targetNewPoints').as('targetNewPoints'),
            x.field<number>('data', 'totalPoints').as('totalPoints'),
            x.learningPlanGoalHeaders('data').as('goals'),
            x.learningPlanTaskHeaders('data').as('tasks'),
          ])
          .where(x.field('data', 'dateKey'), '>=', from)
          .where(x.field('data', 'dateKey'), '<=', to)
          .orderBy(x.field('data', 'dateKey')),
      )
      .map((r) => ({
        ...r,
        goals: JSON.parse(r.goals) as Array<{
          goal: { id: string; name: string; domainId: string };
          targetReviewPoints: number;
          targetNewPoints: number;
        }>,
        tasks: JSON.parse(r.tasks) as Array<{ id: string; goalId: string; points: number }>,
      })),
    results = planResults(
      store,
      days.map((d) => d.id),
    );
  const groups = new Map<string, LearningPlanAnalytics['goals'][number]>();
  let completedDays = 0,
    completedPoints = 0;
  for (const day of days) {
    const map = new Map(results.filter((r) => r.dayId === day.id).map((r) => [r.taskId, r])),
      progress = measurePlan(day.tasks, map);
    if (progress.total && progress.total === progress.completed) completedDays++;
    completedPoints += progress.completedPoints;
    for (const goal of day.goals) {
      const value = groups.get(goal.goal.id) || {
        id: goal.goal.id,
        name: goal.goal.name,
        domainId: goal.goal.domainId,
        days: 0,
        targetPoints: 0,
        plannedPoints: 0,
        completedPoints: 0,
        completed: 0,
        total: 0,
      };
      const p = measurePlan(
        day.tasks.filter((t) => t.goalId === goal.goal.id),
        map,
      );
      value.name = goal.goal.name;
      value.domainId = goal.goal.domainId;
      value.days++;
      value.targetPoints += goal.targetReviewPoints + goal.targetNewPoints;
      value.plannedPoints += p.totalPoints;
      value.completedPoints += p.completedPoints;
      value.completed += p.completed;
      value.total += p.total;
      groups.set(goal.goal.id, value);
    }
  }
  const round = (n: number) => Number(n.toFixed(2));
  return {
    days: days.length,
    scheduledDays: days.filter((d) => d.targetReviewPoints + d.targetNewPoints > 0).length,
    restDays: days.filter((d) => d.targetReviewPoints + d.targetNewPoints === 0).length,
    completedDays,
    targetPoints: round(days.reduce((n, d) => n + d.targetReviewPoints + d.targetNewPoints, 0)),
    plannedPoints: round(days.reduce((n, d) => n + d.totalPoints, 0)),
    completedPoints: round(completedPoints),
    goals: [...groups.values()].map((g) => ({
      ...g,
      targetPoints: round(g.targetPoints),
      plannedPoints: round(g.plannedPoints),
      completedPoints: round(g.completedPoints),
    })),
  };
}
