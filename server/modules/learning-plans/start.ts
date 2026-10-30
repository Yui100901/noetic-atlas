import type { Store } from '../../core/store.js';
import { makeId, now } from '../../core/store.js';
import { fail } from '../../core/validation.js';
import type { LearningDay, LearningTask } from '../../../shared/models/learning-plan.js';
import { createFocus, createFocusItems, type FocusIdentity } from '../focus-review/service.js';
import { createFocusSchema } from '../focus-review/schema.js';
import { planResults } from './progress.js';
import { applyAttemptRetention } from '../settings/service.js';
import { initialPracticeTiming } from '../practice/practice-timing.js';
import { normalizeScoring } from '../practice/scoring.js';
import type { StoredAttempt } from '../practice/service.js';
import type { Question } from '../../../shared/models/types.js';
import { isSubjectiveType } from '../../../shared/questions/question-utils.js';

export function startLearningDay(
  store: Store,
  day: LearningDay,
  input: { goalId?: string; resume: boolean; mode?: 'focus' | 'practice' },
) {
  if (input.goalId && !day.goals.some((g) => g.goal.id === input.goalId))
    fail(400, 'PLAN_GOAL_NOT_FOUND', '目标不属于本日计划');
  const db = store.database,
    x = db.expressions;
  if (input.resume) {
    const drafts: Array<{ id: string; updatedAt: string; kind: 'focus' | 'practice' }> = [];
    for (const [table, kind] of [
      ['focus_sessions', 'focus'],
      ['attempts', 'practice'],
    ] as const) {
      if (input.mode && kind !== input.mode) continue;
      let query = db.query
        .selectFrom(table)
        .select('id')
        .select(x.field<string>('data', 'updatedAt').as('updatedAt'))
        .where(x.field('data', 'learningDayId'), '=', day.id)
        .where(x.field('data', 'status'), '=', 'in_progress');
      if (input.goalId) query = query.where(x.field('data', 'learningGoalId'), '=', input.goalId);
      drafts.push(...db.all(query).map((r) => ({ ...r, kind })));
    }
    drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (drafts[0]) return { ...drafts[0], resumed: true };
  }
  const completed = new Set(
    planResults(store, [day.id])
      .filter((r) => r.completedAt)
      .map((r) => r.taskId),
  );
  let pending = day.tasks.filter(
    (t) => !completed.has(t.id) && (!input.goalId || t.goalId === input.goalId),
  );
  if (!pending.length) fail(422, 'PLAN_FINISHED', '当前范围内的计划任务已经完成');
  const mode = input.mode || day.goals.find((g) => g.goal.id === pending[0]!.goalId)!.goal.mode;
  if (mode === 'practice' || (!input.mode && !input.goalId))
    pending = pending.filter((t) => t.goalId === pending[0]!.goalId);
  const identities = (tasks: LearningTask[]): FocusIdentity[] =>
    tasks.map((task) => {
      const goal = day.goals.find((g) => g.goal.id === task.goalId)!;
      return {
        questionId: task.questionId,
        partId: task.partId,
        direction: task.direction,
        paperId: goal.paperId || undefined,
        paperTitle: `${day.dateKey} 每日推荐 · ${goal.goal.name}`.slice(0, 300),
        paperVersion: 1,
      };
    });
  // Drop unavailable live sources from this launch, leaving their tasks pending.
  // This permits other valid tasks to proceed without inventing completion.
  const sources = new Map<string, Question | undefined>();
  pending = pending.filter((task) => {
    if (!sources.has(task.questionId))
      sources.set(task.questionId, store.get<Question>('questions', task.questionId));
    const q = sources.get(task.questionId);
    return (
      q?.status === 'published' && (!task.partId || q.parts?.some((p) => p.id === task.partId))
    );
  });
  if (!pending.length)
    fail(
      422,
      'PLAN_SOURCES_UNAVAILABLE',
      '剩余任务的原题已删除或未发布，请先修复题目；原计划进度保留',
    );
  const goalId =
    input.goalId ||
    (new Set(pending.map((t) => t.goalId)).size === 1 ? pending[0]!.goalId : undefined);
  const title =
    `${day.title}${goalId ? ' · ' + day.goals.find((g) => g.goal.id === goalId)!.goal.name : ''}`.slice(
      0,
      300,
    );
  if (mode === 'focus') {
    const session = createFocus(
      store,
      createFocusSchema.parse({ scope: 'all', count: Math.min(200, pending.length) }),
      {
        learningDayId: day.id,
        ...(goalId
          ? { paperId: day.goals.find((g) => g.goal.id === goalId)?.paperId || undefined }
          : {}),
        ...(goalId ? { learningGoalId: goalId } : {}),
        title,
        identities: identities(pending),
      },
    );
    return { id: session.id, kind: 'focus' as const, resumed: false };
  }
  // One ordinary attempt has one direction/kind. Both-direction goals continue
  // in compatible batches, preserving unique leaf IDs and existing history rules.
  const sample = pending[0]!,
    sampleQ = sources.get(sample.questionId)!;
  const kind = (q: Question) => (q.concept ? 'concept' : q.vocabulary ? 'vocabulary' : 'standard');
  pending = pending
    .filter(
      (t) => t.direction === sample.direction && kind(sources.get(t.questionId)!) === kind(sampleQ),
    )
    .slice(0, 500);
  const questions = createFocusItems(store, identities(pending)).map((i) => i.question),
    stamp = now(),
    paperId = day.goals.find((g) => g.goal.id === sample.goalId)!.paperId!;
  const questionPoints = Object.fromEntries(
    pending.map((t) => [t.partId ? `${t.questionId}::${t.partId}` : t.questionId, t.points]),
  );
  const scoring = normalizeScoring(questions, {
    enabled: true,
    totalPoints: pending.reduce((n, t) => n + t.points, 0),
    questionPoints,
  });
  const attempt: StoredAttempt = {
    id: makeId('attempt'),
    learningDayId: day.id,
    learningGoalId: sample.goalId,
    paperId,
    paperTitle: title,
    paperVersion: 1,
    source: 'paper',
    status: 'in_progress',
    practiceMode: 'practice',
    practiceKind: kind(sampleQ),
    ...(sample.direction !== 'standard' ? { vocabularyDirection: sample.direction } : {}),
    practiceTiming: initialPracticeTiming(),
    elapsedSeconds: 0,
    questions,
    answers: {},
    scoring,
    objectiveScore: 0,
    objectiveMax: questions
      .filter((q) => !isSubjectiveType(q.type))
      .reduce((n, q) => n + questionPoints[q.id]!, 0),
    subjectiveScore: 0,
    subjectiveMax: questions
      .filter((q) => isSubjectiveType(q.type))
      .reduce((n, q) => n + questionPoints[q.id]!, 0),
    startedAt: stamp,
    updatedAt: stamp,
    submittedAt: null,
  };
  store.transaction(() => {
    store.insert('attempts', attempt.id, attempt);
    applyAttemptRetention(store, attempt);
  });
  return { id: attempt.id, kind: 'practice' as const, resumed: false };
}
