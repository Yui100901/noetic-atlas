import { z } from 'zod';
import { id, types, fail } from '../../core/validation.js';
import type { Store } from '../../core/store.js';
import type {
  LearningDay,
  LearningGoal,
  LearningTask,
} from '../../../shared/models/learning-plan.js';
import type { Category, Tag } from '../../../shared/models/types.js';
import { directionSchema } from '../review-scheduler/schema.js';

export const planPoints = z
  .number()
  .finite()
  .min(0)
  .max(10000)
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, '分值最多两位小数');
const ids = z
  .array(id)
  .max(100)
  .refine((a) => new Set(a).size === a.length, '引用不可重复');
export const learningGoalSchema = z
  .object({
    id,
    name: z.string().trim().min(1).max(100),
    enabled: z.boolean(),
    domainId: id,
    categoryIds: ids.min(1),
    tagIds: ids,
    tagMode: z.enum(['all', 'any']),
    weekdays: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .refine((a) => new Set(a).size === a.length, '学习日期不可重复'),
    priority: z.number().int().min(1).max(5),
    weight: z.number().int().min(1).max(100),
    reviewPoints: planPoints,
    newPoints: planPoints,
    mode: z.enum(['focus', 'practice']),
    direction: z.enum(['default', 'word_to_meaning', 'meaning_to_word', 'both']),
  })
  .strict();
export const learningTaskSchema = z
  .object({
    estimatedSeconds: z.number().int().min(1).max(86400).optional(),
    estimateSource: z.enum(['measured', 'default']).optional(),
    id,
    goalId: id,
    questionId: id,
    partId: id.optional(),
    direction: directionSchema,
    type: types.exclude(['group']),
    title: z.string().max(300),
    points: planPoints,
    kind: z.enum(['review', 'new']),
  })
  .strict();
const goalDaySchema = z
  .object({
    goal: learningGoalSchema,
    paperId: id.nullable(),
    targetReviewPoints: planPoints,
    targetNewPoints: planPoints,
    reviewPoints: planPoints,
    newPoints: planPoints,
    totalPoints: planPoints,
    shortfall: planPoints,
    reason: z.string().max(2000),
  })
  .strict();
const stamp = z.string().datetime({ offset: true });
export const learningDaySchema = z
  .object({
    timeBudget: z
      .object({
        targetSeconds: z.number().int().min(0).max(86400),
        estimatedSeconds: z.number().int().min(0).max(86400),
        measuredTasks: z.number().int().min(0).max(500),
        defaultTasks: z.number().int().min(0).max(500),
        limited: z.boolean(),
      })
      .strict()
      .optional(),
    id,
    dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    generatedAt: stamp,
    timeZone: z.string().max(100),
    title: z.string().min(1).max(300),
    readAt: stamp.nullable(),
    allocationMode: z.enum(['weights', 'fixed']),
    targetReviewPoints: planPoints,
    targetNewPoints: planPoints,
    totalPoints: planPoints,
    shortfall: planPoints,
    goals: z.array(goalDaySchema).max(30),
    tasks: z.array(learningTaskSchema).max(500),
  })
  .strict()
  .superRefine((day, ctx) => {
    const equal = (a: number, b: number) => Math.round(a * 100) === Math.round(b * 100),
      date = new Date(day.dateKey + 'T00:00:00Z');
    if (
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 10) !== day.dateKey ||
      day.id !== `plan-${day.dateKey}`
    )
      ctx.addIssue({ code: 'custom', message: '学习计划日期或身份无效' });
    try {
      new Intl.DateTimeFormat('en', { timeZone: day.timeZone }).format();
    } catch {
      ctx.addIssue({ code: 'custom', message: '学习计划时区无效' });
    }
    const goalIds = new Set(day.goals.map((g) => g.goal.id)),
      keys = day.tasks.map(taskIdentity);
    if (
      day.timeBudget &&
      (day.timeBudget.estimatedSeconds > day.timeBudget.targetSeconds ||
        day.tasks.some((t) => !t.estimatedSeconds || !t.estimateSource) ||
        day.tasks.reduce((n, t) => n + (t.estimatedSeconds || 0), 0) !==
          day.timeBudget.estimatedSeconds ||
        day.tasks.filter((t) => t.estimateSource === 'measured').length !==
          day.timeBudget.measuredTasks ||
        day.tasks.filter((t) => t.estimateSource === 'default').length !==
          day.timeBudget.defaultTasks)
    )
      ctx.addIssue({ code: 'custom', message: '计划时间估计与任务或预算不一致' });
    if (
      goalIds.size !== day.goals.length ||
      new Set(day.tasks.map((t) => t.id)).size !== day.tasks.length ||
      new Set(keys).size !== keys.length ||
      day.tasks.some((t) => !goalIds.has(t.goalId) || t.points <= 0)
    )
      ctx.addIssue({ code: 'custom', message: '学习目标或任务重复、引用无效' });
    if (
      !equal(
        day.tasks.reduce((n, t) => n + t.points, 0),
        day.totalPoints,
      ) ||
      !equal(
        Math.max(0, day.targetReviewPoints + day.targetNewPoints - day.totalPoints),
        day.shortfall,
      ) ||
      !equal(
        day.goals.reduce((n, g) => n + g.targetReviewPoints, 0),
        day.targetReviewPoints,
      ) ||
      !equal(
        day.goals.reduce((n, g) => n + g.targetNewPoints, 0),
        day.targetNewPoints,
      )
    )
      ctx.addIssue({ code: 'custom', message: '学习计划分值合计不一致' });
    for (const g of day.goals) {
      const tasks = day.tasks.filter((t) => t.goalId === g.goal.id),
        r = tasks.filter((t) => t.kind === 'review').reduce((n, t) => n + t.points, 0),
        n = tasks.filter((t) => t.kind === 'new').reduce((n, t) => n + t.points, 0);
      if (
        !equal(r, g.reviewPoints) ||
        !equal(n, g.newPoints) ||
        !equal(r + n, g.totalPoints) ||
        !equal(Math.max(0, g.targetReviewPoints + g.targetNewPoints - r - n), g.shortfall) ||
        !!tasks.length !== !!g.paperId
      )
        ctx.addIssue({ code: 'custom', message: '学习目标任务与题集、分值不一致' });
    }
  });
export const learningTaskResultSchema = z
  .object({
    id: z.string().min(1).max(1500),
    dayId: id,
    taskId: id,
    answeredAt: stamp.nullable(),
    reviewedAt: stamp.nullable(),
    completedAt: stamp.nullable(),
    attemptId: id.nullable(),
    reviewId: z.string().max(1600).nullable(),
  })
  .strict();
export const planStartSchema = z
  .object({
    mode: z.enum(['focus', 'practice']).optional(),
    goalId: id.optional(),
    resume: z.boolean().default(true),
  })
  .strict();
export function taskIdentity(task: Pick<LearningTask, 'questionId' | 'partId' | 'direction'>) {
  return JSON.stringify([task.questionId, task.partId ?? null, task.direction]);
}
export function validateGoalReferences(store: Store, goals: LearningGoal[]) {
  if (new Set(goals.map((g) => g.id)).size !== goals.length)
    fail(400, 'PLAN_DUPLICATE_GOAL', '学习目标ID不可重复');
  for (const goal of goals.filter((g) => g.enabled)) {
    store.require('domains', goal.domainId);
    for (const id of goal.categoryIds) {
      const category = store.require<Category>('categories', id);
      if (category.domainId !== goal.domainId)
        fail(400, 'PLAN_CATEGORY_MISMATCH', '学习目标的分类不属于所选领域');
    }
    for (const id of goal.tagIds) {
      const tag = store.require<Tag>('tags', id);
      if (tag.domainId && tag.domainId !== goal.domainId)
        fail(400, 'PLAN_TAG_MISMATCH', '学习目标标签不属于所选领域');
    }
  }
}
export function validatePlanResult(
  day: LearningDay,
  result: z.infer<typeof learningTaskResultSchema>,
) {
  const task = day.tasks.find((t) => t.id === result.taskId);
  if (
    !task ||
    result.dayId !== day.id ||
    result.id !== JSON.stringify([day.id, task.id]) ||
    (!result.answeredAt && !result.reviewedAt) ||
    !!result.completedAt !== !!(result.reviewedAt || (task.kind === 'new' && result.answeredAt))
  )
    fail(400, 'PLAN_RESULT_INVALID', '学习计划任务进度引用或完成状态不一致');
  if (
    !!result.answeredAt !== !!result.attemptId ||
    !!result.reviewedAt !== !!result.reviewId ||
    [result.answeredAt, result.reviewedAt, result.completedAt].some(
      (value) => value && Date.parse(value) < Date.parse(day.generatedAt),
    ) ||
    (result.completedAt &&
      result.completedAt !== result.reviewedAt &&
      !(task!.kind === 'new' && result.completedAt === result.answeredAt))
  )
    fail(400, 'PLAN_RESULT_INVALID', '学习任务进度时间或来源不一致');
  return result;
}

export function validateLearningDayMerge(store: Store, day: LearningDay) {
  const current = store.get<LearningDay>('learning_days', day.id);
  if (current) {
    const { readAt: _old, ...old } = current,
      { readAt: _new, ...next } = day;
    if (JSON.stringify(old) !== JSON.stringify(next))
      fail(
        409,
        'PLAN_IMPORT_CONFLICT',
        '目标库已有不同的同日学习计划，不能混合任务进度；请使用SQLite完整恢复替换数据',
      );
  }
  return day;
}
