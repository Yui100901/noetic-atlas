import { z } from 'zod';
import { DEFAULT_DAILY_PUSH, type DailyPushSettings } from '../../../shared/models/daily-push.js';
import { id, leafId, types, typePointsSchema, fail } from '../../core/validation.js';
import type { Store } from '../../core/store.js';
import type { Category } from '../../../shared/models/types.js';

const points = z.number().finite().min(0).max(10000).refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, '分值最多两位小数');
export const dailyPushSettingsSchema = z.object({
  enabled: z.boolean().default(false), domainId: id.nullable().default(null), categoryIds: z.array(id).max(100).refine(ids => new Set(ids).size === ids.length, '分类不可重复').default([]),
  reviewPoints: points.default(30), newPoints: points.default(20),
  scheduleTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, '触发时间须为HH:mm').default('00:00'),
  timeZone: z.string().min(1).max(100).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }).format(); return true; } catch { return false; } }, '时区无效').default('Asia/Shanghai'),
}).strict().superRefine((value, context) => {
  if (value.enabled && (value.reviewPoints + value.newPoints < 50 || value.reviewPoints + value.newPoints > 10000)) context.addIssue({ code: 'custom', path: ['reviewPoints'], message: '复习与新题目标总分须为50至10000分' });
  if (value.enabled && (!value.domainId || !value.categoryIds.length)) context.addIssue({ code: 'custom', path: ['categoryIds'], message: '开启每日推题前请选择领域和至少一个分类' });
}).default(() => structuredClone(DEFAULT_DAILY_PUSH));

export function validateDailyPushConfiguration(store: Store, value: DailyPushSettings): void {
  // Disabled configurations may retain choices for later use or portable import.
  // Their references become mandatory again before the feature is enabled.
  if (!value.enabled) return;
  if (!value.domainId || !store.get('domains', value.domainId) || !value.categoryIds.length) fail(400, 'DAILY_PUSH_SCOPE_REQUIRED', '每日推题领域不存在或尚未选择分类，请先建立或重新选择学习范围');
  for (const id of value.categoryIds) {
    const category = store.get<Category>('categories', id);
    if (!category || category.domainId !== value.domainId) fail(400, 'DAILY_PUSH_CATEGORY_MISMATCH', '每日推题分类不存在或不属于所选领域，请重新选择');
  }
}

const stamp = z.string().datetime({ offset: true });
export const dailyPushAnswerItemSchema = z.object({ id: leafId, sourceQuestionId: id, partId: id.optional(), type: types.exclude(['group']), points }).strict();
export const dailyPushRecordSchema = z.object({
  id, dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), generatedAt: stamp, paperId: id.nullable(), title: z.string().min(1).max(300),
  domainId: id, categoryIds: z.array(id).min(1).max(100),
  targetReviewPoints: points, baseNewPoints: points, targetNewPoints: points, targetTotalPoints: points, transferredPoints: points,
  reviewPoints: points, newPoints: points, totalPoints: points,
  reviewCount: z.number().int().min(0).max(500), newCount: z.number().int().min(0).max(500),
  questionIds: z.array(id).max(500), reviewQuestionIds: z.array(id).max(500), newQuestionIds: z.array(id).max(500), pointsByType: typePointsSchema.required(),
  shortfall: points, reason: z.string().max(1000), readAt: stamp.nullable(),
  answerItems: z.array(dailyPushAnswerItemSchema).max(500).optional(),
}).strict().superRefine((record, context) => {
  const same = (a: number, b: number) => Math.round(a * 100) === Math.round(b * 100);
  const unique = new Set(record.questionIds);
  const calendarDate = new Date(record.dateKey + 'T00:00:00Z');
  if (!Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== record.dateKey) context.addIssue({ code: 'custom', path: ['dateKey'], message: '每日推题日期不是有效日历日期' });
  if (record.id !== `daily-${record.dateKey}` || unique.size !== record.questionIds.length || record.reviewCount !== record.reviewQuestionIds.length || record.newCount !== record.newQuestionIds.length || record.reviewCount + record.newCount !== record.questionIds.length || new Set([...record.reviewQuestionIds, ...record.newQuestionIds]).size !== unique.size || [...record.reviewQuestionIds, ...record.newQuestionIds].some(id => !unique.has(id))) context.addIssue({ code: 'custom', message: '每日推题日期或题目身份不一致' });
  if (!same(record.reviewPoints + record.newPoints, record.totalPoints) || !same(record.targetReviewPoints + record.baseNewPoints, record.targetTotalPoints) || !same(record.baseNewPoints + record.transferredPoints, record.targetNewPoints) || !same(Math.max(0, record.targetTotalPoints - record.totalPoints), record.shortfall) || (!!record.paperId !== !!record.questionIds.length)) context.addIssue({ code: 'custom', message: '每日推题分值或题集引用不一致' });
  if (record.answerItems) {
    const keys = record.answerItems.map(item => JSON.stringify([item.sourceQuestionId, item.id]));
    const roots = new Set(record.answerItems.map(item => item.sourceQuestionId));
    if (new Set(keys).size !== keys.length || roots.size !== record.questionIds.length || record.questionIds.some(id => !roots.has(id)) || record.answerItems.some(item => item.partId ? item.id !== `${item.sourceQuestionId}::${item.partId}` : item.id !== item.sourceQuestionId) || !same(record.answerItems.reduce((sum, item) => sum + item.points, 0), record.totalPoints)) context.addIssue({ code: 'custom', message: '每日推荐作答项身份或满分合计与原推荐不一致' });
  }
});
