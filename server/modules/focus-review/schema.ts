import { z } from 'zod';
import { answerSchema, id, snapshotQuestionSchema } from '../../core/validation.js';
import { practiceTimingStateSchema } from '../practice/practice-timing.js';
import { directionSchema, ratingSchema } from '../review-scheduler/schema.js';

const stamp = z.string().datetime({ offset: true });
const focusQuestion = snapshotQuestionSchema;
export const focusSummarySchema = z.object({
  learningDayId: id.optional(),
  learningGoalId: id.optional(),
  id,
  paperId: id.nullable(),
  title: z.string(),
  status: z.enum(['in_progress', 'submitted']),
  scope: z.enum(['due', 'all']),
  total: z.number().int().nonnegative(),
  rated: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  written: z.number().int().nonnegative(),
  mental: z.number().int().nonnegative(),
  ratings: z.object({
    again: z.number().int().nonnegative(),
    hard: z.number().int().nonnegative(),
    good: z.number().int().nonnegative(),
    easy: z.number().int().nonnegative(),
  }),
  elapsedSeconds: z.number().int().nonnegative(),
  startedAt: stamp,
  updatedAt: stamp,
  submittedAt: stamp.nullable(),
});
export const focusSessionSchema = z
  .object({
    id,
    learningDayId: id.optional(),
    learningGoalId: id.optional(),
    paperId: id.nullable(),
    title: z.string().min(1).max(300),
    paperVersion: z.number().int().min(1),
    scope: z.enum(['due', 'all']),
    strategy: z.enum(['fsrs', 'fixed']),
    status: z.enum(['in_progress', 'submitted']),
    practiceMode: z.literal('practice'),
    revision: z.number().int().positive(),
    index: z.number().int().min(0).max(200),
    items: z
      .array(
        z
          .object({
            paperId: id.optional(),
            paperTitle: z.string().max(300).optional(),
            paperVersion: z.number().int().positive().optional(),
            key: z.string().min(1).max(1600),
            questionId: id,
            partId: id.optional(),
            direction: directionSchema,
            sourceUpdatedAt: stamp,
            sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            startedElapsedSeconds: z.number().int().nonnegative(),
            question: focusQuestion,
            phase: z.enum(['recall', 'revealed', 'rated', 'skipped']),
            mode: z.enum(['mental', 'written']),
            answer: answerSchema.optional(),
            attemptId: id.optional(),
            rating: ratingSchema.optional(),
            dueAt: stamp.nullable().optional(),
            verdict: z.enum(['correct', 'partial', 'incorrect']).nullable().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    startedAt: stamp,
    updatedAt: stamp,
    submittedAt: stamp.nullable(),
    elapsedSeconds: z.number().int().nonnegative(),
    practiceTiming: practiceTimingStateSchema,
    reset: z.boolean().optional(),
    summary: focusSummarySchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.index > value.items.length ||
      new Set(value.items.map((item) => item.key)).size !== value.items.length ||
      value.elapsedSeconds !== Math.floor(value.practiceTiming.elapsedMilliseconds / 1000) ||
      (value.status === 'submitted' && (!value.submittedAt || value.practiceTiming.running))
    )
      ctx.addIssue({ code: 'custom', message: '专注复习进度或计时不一致' });
    for (const item of value.items)
      if (
        (item.phase === 'rated') !== !!item.rating ||
        item.question.id !==
          (item.partId ? `${item.questionId}::${item.partId}` : item.questionId) ||
        (item.question.sourceQuestionId && item.question.sourceQuestionId !== item.questionId)
      )
        ctx.addIssue({ code: 'custom', message: '专注复习题目身份或评级不一致' });
    value.items.forEach((item, index) => {
      if (
        item.question.type === 'group' ||
        item.question.partId !== item.partId ||
        'study' in item.question ||
        'partStudies' in item.question ||
        'feedbackSummary' in item.question ||
        item.startedElapsedSeconds > value.elapsedSeconds ||
        (index > value.index && item.phase !== 'recall') ||
        (item.mode === 'mental' && item.attemptId) ||
        (item.attemptId && !item.answer) ||
        (item.mode === 'written' &&
          ['revealed', 'rated'].includes(item.phase) &&
          !item.attemptId) ||
        (item.direction === 'meaning_to_word' &&
          (!(item.question.vocabulary || item.question.concept) ||
            item.question.type !== 'fill_blank' ||
            item.partId))
      )
        ctx.addIssue({ code: 'custom', message: '专注复习快照、作答或任务顺序不一致' });
    });
    if (
      (value.status === 'in_progress' && value.submittedAt) ||
      (value.reset && value.status !== 'submitted')
    )
      ctx.addIssue({ code: 'custom', message: '专注复习结束状态不一致' });
  });
export const createFocusSchema = z
  .object({
    paperId: id.optional(),
    scope: z.enum(['due', 'all']).default('due'),
    count: z.number().int().min(1).max(200).default(20),
    direction: directionSchema.optional(),
    domainId: id.optional(),
    categoryId: id.optional(),
    kind: z.enum(['all', 'overdue', 'relearning', 'today']).default('all'),
  })
  .strict();
export const focusActionSchema = z
  .object({
    index: z.number().int().min(0).max(199),
    revision: z.number().int().positive(),
    action: z.enum(['save', 'reveal', 'rate', 'skip']),
    mode: z.enum(['mental', 'written']).optional(),
    answer: z.union([z.string().max(100000), z.array(z.string().max(1000)).max(30)]).optional(),
    rating: ratingSchema.optional(),
    verdict: z.enum(['correct', 'partial', 'incorrect']).nullable().optional(),
  })
  .strict();
