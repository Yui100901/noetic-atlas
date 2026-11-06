import type { Store } from '../../core/store.js';
import type { DailyPushSettings } from '../../../shared/models/daily-push.js';
import type { LearningGoal } from '../../../shared/models/learning-plan.js';
import type { LeafQuestionType } from '../../../shared/models/types.js';
import {
  DEFAULT_TASK_SECONDS,
  type LearningWeekSummary,
} from '../../../shared/models/learning-time.js';
import { addDays, calendar, monday } from '../analytics/calendar.js';
import { getSettings } from '../settings/service.js';

export function configuredGoals(config: DailyPushSettings): LearningGoal[] {
  if (config.goals?.length) return config.goals;
  if (!config.timeBudget?.enabled || !config.domainId || !config.categoryIds.length) return [];
  return [
    {
      id: 'single-time-goal',
      name: '每日学习',
      enabled: true,
      domainId: config.domainId,
      categoryIds: config.categoryIds,
      tagIds: [],
      tagMode: 'all',
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      priority: 3,
      weight: 1,
      reviewPoints: config.reviewPoints,
      newPoints: config.newPoints,
      mode: 'focus',
      direction: 'default',
    },
  ];
}
export function dailyMinutes(config: DailyPushSettings, date: string): number {
  if (!config.timeBudget?.enabled) return 0;
  const weekday = new Date(date + 'T12:00:00Z').getUTCDay() || 7;
  if (!configuredGoals(config).some((goal) => goal.enabled && goal.weekdays.includes(weekday)))
    return 0;
  return weekday >= 6 ? config.timeBudget.weekendMinutes : config.timeBudget.weekdayMinutes;
}
const validSeconds = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

/** Learn from actual timed single-item answers, not a division of paper time.
 * Only compact columns are read and the recent sample pool is bounded. */
export function taskTimeEstimates(store: Store) {
  const db = store.database,
    x = db.expressions,
    samples = new Map<string, number[]>();
  const rows = db.all(
    db.query
      .selectFrom('learning_results')
      .select([
        x.field<string>('data', 'items').as('items'),
        x.field<number | null>('data', 'elapsedSeconds').as('seconds'),
        x.field<string | null>('data', 'practiceKind').as('kind'),
      ])
      .where(x.field('data', 'reset'), 'is', null)
      .orderBy(x.field('data', 'submittedAt'), 'desc')
      .limit(300),
  );
  for (const row of rows) {
    if (!validSeconds(row.seconds) || row.seconds < 5 || row.seconds > 3600) continue;
    const items = JSON.parse(row.items || '[]');
    if (
      items.length !== 1 ||
      items[0].answered !== true ||
      !Object.hasOwn(DEFAULT_TASK_SECONDS, items[0].type)
    )
      continue;
    const key = `${row.kind || 'standard'}:${items[0].type}`;
    const values = samples.get(key) || [];
    values.push(row.seconds);
    samples.set(key, values);
  }
  return (
    type: LeafQuestionType,
    kind: 'standard' | 'vocabulary' | 'concept' = 'standard',
  ): { estimatedSeconds: number; estimateSource: 'measured' | 'default' } => {
    const values = (samples.get(`${kind}:${type}`) || []).sort((a, b) => a - b);
    // Three independent observations avoid presenting a single outlier as a
    // reliable calibration. Median is conservative against accidental pauses.
    return values.length >= 3
      ? {
          estimatedSeconds: Math.ceil(values[Math.floor(values.length / 2)]!),
          estimateSource: 'measured',
        }
      : {
          estimatedSeconds:
            kind === 'vocabulary' ? 30 : kind === 'concept' ? 90 : DEFAULT_TASK_SECONDS[type],
          estimateSource: 'default',
        };
  };
}

/** Whole sessions are assigned to their submission date. Focus children never
 * add time on top of their parent; compact and retained answers share one ID. */
export function learningWeek(store: Store, date?: string, at = new Date()): LearningWeekSummary {
  const config = getSettings(store).dailyPush,
    clock = calendar(config.timeZone),
    today = clock.date(at),
    from = monday(date || today),
    to = addDays(from, 6);
  const start = clock.start(from),
    end = Math.min(clock.start(addDays(to, 1)), at.getTime() + 1),
    db = store.database,
    x = db.expressions;
  const daily = Array.from({ length: 7 }, (_, index) => ({
    date: addDays(from, index),
    targetMinutes: dailyMinutes(config, addDays(from, index)),
    elapsedSeconds: 0,
  }));
  const byDate = new Map(daily.map((value) => [value.date, value]));
  const targetMinutes =
    config.timeBudget?.weeklyMinutes || daily.reduce((sum, value) => sum + value.targetMinutes, 0);
  const targetSource = config.timeBudget?.weeklyMinutes
    ? 'explicit'
    : targetMinutes
      ? 'daily_budgets'
      : 'none';
  let elapsedSeconds = 0,
    timedSessions = 0,
    missingTimeSessions = 0,
    inProgressSeconds = 0;
  const lower = addDays(from, -2) + 'T',
    upper = addDays(to, 2) + 'T';
  const fields = [
    x.field<string>('data', 'submittedAt').as('submittedAt'),
    x.field<number | null>('data', 'elapsedSeconds').as('seconds'),
    x.field<string | null>('data', 'focusSessionId').as('focusId'),
    x.field<string>('data', 'paperTitle').as('title'),
    x.field<boolean | null>('data', 'reset').as('reset'),
  ];
  const compact = db.all(
    db.query
      .selectFrom('learning_results')
      .select('id')
      .select(fields)
      .where(x.field('data', 'submittedAt'), '>=', lower)
      .where(x.field('data', 'submittedAt'), '<', upper),
  );
  const retained = db.all(
    db.query
      .selectFrom('attempts')
      .select('id')
      .select(fields)
      .where(x.field('data', 'status'), '=', 'submitted')
      .where(x.field('data', 'submittedAt'), '>=', lower)
      .where(x.field('data', 'submittedAt'), '<', upper),
  );
  const retainedMap = new Map(retained.map((value) => [value.id, value]));
  const sessions = new Map(retained.map((value) => [value.id, value]));
  for (const row of compact) {
    const fallback = retainedMap.get(row.id);
    sessions.set(row.id, {
      ...row,
      focusId: row.focusId || fallback?.focusId || null,
      seconds: validSeconds(row.seconds) ? row.seconds : (fallback?.seconds ?? null),
    });
  }
  const count = (seconds: unknown, submittedAt: string) => {
    const instant = Date.parse(submittedAt);
    if (!Number.isFinite(instant) || instant < start || instant >= end) return;
    if (!validSeconds(seconds)) {
      missingTimeSessions++;
      return;
    }
    elapsedSeconds += seconds;
    timedSessions++;
    byDate.get(clock.date(instant))!.elapsedSeconds += seconds;
  };
  for (const row of sessions.values()) {
    if (row.reset || row.focusId) continue;
    // Genuine old records may predate focusSessionId. Conservatively exclude
    // the generated child title instead of counting parent and child twice.
    if (row.title?.startsWith('专注复习 ·')) {
      const instant = Date.parse(row.submittedAt);
      if (instant >= start && instant < end) missingTimeSessions++;
      continue;
    }
    count(row.seconds, row.submittedAt);
  }
  const focus = db.all(
    db.query
      .selectFrom('focus_sessions')
      .select([
        x.field<string>('data', 'submittedAt').as('submittedAt'),
        x.field<number | null>('data', 'elapsedSeconds').as('seconds'),
        x.field<boolean | null>('data', 'reset').as('reset'),
      ])
      .where(x.field('data', 'status'), '=', 'submitted')
      .where(x.field('data', 'submittedAt'), '>=', lower)
      .where(x.field('data', 'submittedAt'), '<', upper),
  );
  for (const row of focus) if (!row.reset) count(row.seconds, row.submittedAt);
  for (const table of ['attempts', 'focus_sessions'] as const) {
    const rows = db.all(
      db.query
        .selectFrom(table)
        .select([
          x.field<number | null>('data', 'elapsedSeconds').as('seconds'),
          x.field<string>('data', 'updatedAt').as('updatedAt'),
          x.field<boolean | null>('data', 'reset').as('reset'),
          x.field<string | null>('data', 'focusSessionId').as('focusId'),
          x.field<string | null>('data', 'paperTitle').as('title'),
        ])
        .where(x.field('data', 'status'), '=', 'in_progress')
        .where(x.field('data', 'updatedAt'), '>=', lower)
        .where(x.field('data', 'updatedAt'), '<', upper),
    );
    for (const row of rows) {
      const time = Date.parse(row.updatedAt);
      if (
        !row.reset &&
        !(table === 'attempts' && (row.focusId || row.title?.startsWith('专注复习 ·'))) &&
        time >= start &&
        time < end &&
        validSeconds(row.seconds)
      )
        inProgressSeconds += row.seconds;
    }
  }
  return {
    from,
    to,
    timeZone: config.timeZone,
    targetMinutes,
    targetSource,
    elapsedSeconds,
    remainingSeconds: Math.max(0, targetMinutes * 60 - elapsedSeconds),
    percent: targetMinutes
      ? Math.min(100, Math.round((elapsedSeconds / (targetMinutes * 60)) * 100))
      : 0,
    timedSessions,
    missingTimeSessions,
    inProgressSeconds,
    daily,
    note: '统计全部学习的已完成会话有效计时，按提交日归属；跨日会话不拆分，进行中的已保存时长另列。缺计时或无法识别的旧专注子记录不估填；清理专注会话历史后不补造其耗时。',
  };
}
