import { randomInt } from 'node:crypto';
import type { Store } from '../../core/store.js';
import type { LearningGoal, LearningTask } from '../../../shared/models/learning-plan.js';
import type { DailyPushSettings } from '../../../shared/models/daily-push.js';
import type { QuestionType } from '../../../shared/models/types.js';
import type { SystemSettings } from '../../../shared/models/settings.js';
import { dailyCalendar } from '../daily-push/calendar.js';
import { reviewQueue } from '../review-scheduler/service.js';
import { learningMetadata } from '../practice/learning-results.js';
import { taskIdentity } from './schema.js';
import { createHash } from 'node:crypto';

interface Metadata {
  id: string;
  title: string;
  type: QuestionType;
  categoryIds: string[];
  tagIds: string[];
  parts?: Array<{ id: string; type: Exclude<QuestionType, 'group'> }>;
}
interface Candidate extends Omit<LearningTask, 'id' | 'goalId'> {
  key: string;
  dueRank: number;
  containerSlots: number;
}
const shuffle = <T>(a: T[]) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};
/** Integer cents and largest remainders keep a shared budget deterministic. */
export function allocateGoalBudget(total: number, goals: LearningGoal[]) {
  const cents = Math.round(total * 100),
    sum = goals.reduce((n, g) => n + g.weight, 0),
    values = goals.map((g, index) => {
      const raw = sum ? (cents * g.weight) / sum : 0;
      return { index, cents: Math.floor(raw), rest: raw - Math.floor(raw) };
    });
  const left = cents - values.reduce((n, v) => n + v.cents, 0);
  [...values]
    .sort((a, b) => b.rest - a.rest || a.index - b.index)
    .slice(0, left)
    .forEach((v) => v.cents++);
  return values.map((v) => v.cents / 100);
}
export function selectPlanTasks(
  store: Store,
  config: DailyPushSettings,
  settings: SystemSettings,
  dateKey: string,
  at: Date,
) {
  const day = new Date(dateKey + 'T12:00:00Z').getUTCDay() || 7;
  const goals = (config.goals || [])
    .filter((g) => g.enabled && g.weekdays.includes(day))
    .sort((a, b) => b.priority - a.priority || b.weight - a.weight || a.id.localeCompare(b.id));
  const fixed = config.allocationMode === 'fixed';
  const reviews = fixed
      ? goals.map((g) => g.reviewPoints)
      : allocateGoalBudget(config.reviewPoints, goals),
    fresh = fixed ? goals.map((g) => g.newPoints) : allocateGoalBudget(config.newPoints, goals);
  const domainCache = new Map<string, Metadata[]>();
  const scoped = goals.map((goal) => {
    const categories = new Set(
      goal.categoryIds.flatMap((id) => [...store.categoryDescendants(id)]),
    );
    if (!domainCache.has(goal.domainId))
      domainCache.set(
        goal.domainId,
        store.questionMetadata({ domainId: goal.domainId, status: 'published' }) as Metadata[],
      );
    return domainCache
      .get(goal.domainId)!
      .filter(
        (q) =>
          q.categoryIds.some((id) => categories.has(id)) &&
          (!goal.tagIds.length ||
            (goal.tagMode === 'all'
              ? goal.tagIds.every((id) => q.tagIds.includes(id))
              : goal.tagIds.some((id) => q.tagIds.includes(id)))),
      );
  });
  const ids = [...new Set(scoped.flatMap((rows) => rows.map((q) => q.id)))],
    db = store.database,
    x = db.expressions;
  const flags = new Map(
    ids.length
      ? db
          .all(
            db.query
              .selectFrom('questions')
              .select('id')
              .select([
                x.nestedField<string | null>('data', ['vocabulary', 'language']).as('word'),
                x.nestedField<string | null>('data', ['concept', 'term']).as('concept'),
                x
                  .nestedField<number | null>('data', ['vocabulary', 'reverseEnabled'])
                  .as('reverseEnabled'),
              ])
              .where(x.idInJson('id', ids)),
          )
          .map((row) => [
            row.id,
            {
              structured: !!(row.word || row.concept),
              reverseEnabled: !row.word || row.reverseEnabled !== 0,
            },
          ])
      : [],
  );
  const normalize = (v: { questionId: string; partId?: string | null; direction?: string }) =>
    taskIdentity({
      questionId: v.questionId,
      ...(v.partId ? { partId: v.partId } : {}),
      direction:
        v.direction === 'meaning_to_word'
          ? 'meaning_to_word'
          : !v.partId && flags.get(v.questionId)?.structured
            ? 'word_to_meaning'
            : 'standard',
    });
  const cards = db.all(
    db.query
      .selectFrom('review_cards')
      .select([
        x.field<string>('data', 'questionId').as('questionId'),
        x.field<string | null>('data', 'partId').as('partId'),
        x.field<string>('data', 'direction').as('direction'),
        x.nestedField<number>('data', ['memory', 'reps']).as('reps'),
        x.nestedField<number>('data', ['memory', 'state']).as('memoryState'),
        x.field<string | null>('data', 'dueAt').as('dueAt'),
        x.field<boolean>('data', 'suspended').as('suspended'),
      ]),
  );
  const known = new Set<string>(),
    represented = new Set<string>(),
    suspended = new Set<string>();
  for (const card of cards) {
    const key = normalize(card);
    represented.add(JSON.stringify([card.questionId, card.partId || null]));
    if (card.reps > 0) known.add(key);
    if (card.suspended) suspended.add(key);
  }
  const legacy = new Map<string, { known: boolean; due: boolean }>();
  for (const table of ['study', 'study_parts'] as const)
    for (const row of db.all(
      db.query
        .selectFrom(table)
        .select([
          x.field<string>('data', 'questionId').as('questionId'),
          x.field<string | null>('data', 'partId').as('partId'),
          x.field<number | null>('data', 'mastery').as('mastery'),
          x.field<string | null>('data', 'lastReviewedAt').as('reviewed'),
          x.field<string | null>('data', 'nextReviewAt').as('due'),
        ]),
    )) {
      legacy.set(JSON.stringify([row.questionId, row.partId || null]), {
        known: row.mastery !== null || !!row.reviewed || !!row.due,
        due:
          !!row.due &&
          (Date.parse(row.due) <= at.getTime() ||
            dailyCalendar(new Date(row.due), config.timeZone).dateKey <= dateKey),
      });
    }
  for (const result of learningMetadata(store))
    if (result.status === 'submitted')
      for (const item of result.items)
        if (
          item.answered === true ||
          (item.answered === undefined && item.judgment && item.judgment !== 'unanswered')
        )
          known.add(
            normalize({
              questionId: item.sourceQuestionId || item.id,
              partId: item.partId,
              direction: result.vocabularyDirection,
            }),
          );
  const due = new Map<string, number>();
  if (settings.reviewScheduling.strategy === 'fsrs')
    reviewQueue(store, { page: 1, pageSize: 1_500_000, kind: 'all' }, at).items.forEach(
      (item, index) => due.set(normalize(item), index),
    );
  if (settings.reviewScheduling.strategy === 'fsrs') {
    for (const card of cards)
      if (
        !card.suspended &&
        card.dueAt &&
        card.memoryState === 2 &&
        dailyCalendar(new Date(card.dueAt), config.timeZone).dateKey <= dateKey &&
        !due.has(normalize(card))
      )
        due.set(normalize(card), 1_000_000 + Date.parse(card.dueAt) / 1e12);
    for (const [key, state] of legacy)
      if (state.due && !represented.has(key)) {
        const [questionId, partId] = JSON.parse(key);
        const normalized = normalize({ questionId, partId });
        if (!due.has(normalized)) due.set(normalized, 2_000_000);
      }
  }
  const candidateCache = new Map<string, Candidate | null>();
  const pools = scoped.map((rows, index) => {
    const goal = goals[index]!,
      values: Candidate[] = [];
    for (const q of rows) {
      const parts =
        q.type === 'group'
          ? (q.parts || []).map((p, i) => ({ ...p, title: `${q.title} · 小题${i + 1}` }))
          : [{ id: '', type: q.type as Exclude<QuestionType, 'group'>, title: q.title }];
      for (const part of parts) {
        const partId = part.id || undefined,
          structured = !partId && flags.get(q.id)?.structured,
          directions = structured
            ? goal.direction === 'both'
              ? ['word_to_meaning', 'meaning_to_word']
              : goal.direction === 'meaning_to_word'
                ? ['meaning_to_word']
                : ['word_to_meaning']
            : goal.direction === 'meaning_to_word'
              ? []
              : ['standard'];
        for (const direction of directions) {
          if (direction === 'meaning_to_word' && !flags.get(q.id)?.reverseEnabled) continue;
          const identity = {
              questionId: q.id,
              ...(partId ? { partId } : {}),
              direction: direction as LearningTask['direction'],
            },
            key = taskIdentity(identity);
          if (candidateCache.has(key)) {
            const cached = candidateCache.get(key);
            if (cached) values.push(cached);
            continue;
          }
          if (suspended.has(key)) {
            candidateCache.set(key, null);
            continue;
          }
          const leafKey = JSON.stringify([q.id, partId || null]),
            state =
              legacy.get(leafKey) ||
              (partId ? legacy.get(JSON.stringify([q.id, null])) : undefined);
          const learned =
            known.has(key) ||
            (!represented.has(leafKey) && direction !== 'meaning_to_word' && !!state?.known);
          const isDue = settings.reviewScheduling.strategy === 'fsrs' ? due.has(key) : !!state?.due;
          if (learned && !isDue) {
            candidateCache.set(key, null);
            continue;
          }
          const points =
            settings.pointsByType[direction === 'meaning_to_word' ? 'fill_blank' : part.type];
          if (points <= 0) {
            candidateCache.set(key, null);
            continue;
          }
          const value: Candidate = {
            ...identity,
            key,
            title:
              direction === 'meaning_to_word' ? '看描述或释义回忆名称' : part.title.slice(0, 300),
            type: direction === 'meaning_to_word' ? 'fill_blank' : part.type,
            points,
            kind: learned ? 'review' : 'new',
            dueRank: due.get(key) ?? Number.MAX_SAFE_INTEGER,
            containerSlots: q.type === 'group' ? q.parts?.length || 0 : 1,
          };
          candidateCache.set(key, value);
          values.push(value);
        }
      }
    }
    const review = values.filter((c) => c.kind === 'review').sort((a, b) => a.dueRank - b.dueRank),
      newItems = shuffle(values.filter((c) => c.kind === 'new'));
    return { review, newItems };
  });
  const used = new Set<string>(),
    tasks: LearningTask[] = [];
  let totalCents = 0;
  const rootSets = goals.map(() => new Set<string>()),
    containerCounts = goals.map(() => 0);
  const selected = goals.map((goal, index) => ({
    goal,
    paperId: null as string | null,
    targetReviewPoints: reviews[index]!,
    targetNewPoints: fresh[index]!,
    reviewPoints: 0,
    newPoints: 0,
    totalPoints: 0,
    shortfall: 0,
    reason: '',
  }));
  const add = (index: number, c: Candidate) => {
    if (
      used.has(c.key) ||
      tasks.length >= 500 ||
      totalCents + Math.round(c.points * 100) > 1_000_000 ||
      (!rootSets[index]!.has(c.questionId) && containerCounts[index]! + c.containerSlots > 500)
    )
      return false;
    used.add(c.key);
    totalCents += Math.round(c.points * 100);
    if (!rootSets[index]!.has(c.questionId)) {
      rootSets[index]!.add(c.questionId);
      containerCounts[index]! += c.containerSlots;
    }
    const { key, dueRank: _rank, containerSlots: _slots, ...value } = c;
    const goal = selected[index]!;
    tasks.push({
      ...value,
      id:
        'task-' +
        createHash('sha256')
          .update(dateKey + key)
          .digest('hex')
          .slice(0, 32),
      goalId: goal.goal.id,
    });
    goal[c.kind === 'review' ? 'reviewPoints' : 'newPoints'] += c.points;
    return true;
  };
  selected.forEach((goal, index) => {
    const pool = pools[index]!,
      available = pool.review.filter((c) => !used.has(c.key)).reduce((n, c) => n + c.points, 0),
      reallocated =
        settings.reviewScheduling.strategy === 'fsrs' &&
        settings.reviewScheduling.reduceNewWhenOverdue
          ? Math.min(goal.targetNewPoints, Math.max(0, available - goal.targetReviewPoints))
          : 0;
    const reviewTarget = goal.targetReviewPoints + reallocated;
    for (const c of pool.review) {
      if (
        Math.round(goal.reviewPoints * 100) >= Math.round(reviewTarget * 100) ||
        tasks.length >= 500
      )
        break;
      add(index, c);
    }
    const transfer = Math.max(0, reviewTarget - goal.reviewPoints),
      newTarget = goal.targetNewPoints - reallocated + transfer;
    for (const c of pool.newItems) {
      if (Math.round(goal.newPoints * 100) >= Math.round(newTarget * 100) || tasks.length >= 500)
        break;
      add(index, c);
    }
    if (transfer) goal.reason += `复习不足，${Number(transfer.toFixed(2))}分补给新题。`;
    if (reallocated)
      goal.reason += `复习积压，${Number(reallocated.toFixed(2))}分新题额度用于复习。`;
  });
  const totalTarget = reviews.reduce((n, v) => n + v, 0) + fresh.reduce((n, v) => n + v, 0);
  selected.forEach((goal, index) => {
    let borrowed = 0;
    for (const c of [...pools[index]!.newItems, ...pools[index]!.review]) {
      if (totalCents >= Math.round(totalTarget * 100) || tasks.length >= 500) break;
      if (add(index, c)) borrowed += c.points;
    }
    if (borrowed)
      goal.reason = `部分目标题量不足，本目标补充${Number(borrowed.toFixed(2))}分。` + goal.reason;
  });
  selected.forEach((goal) => {
    goal.reviewPoints = Number(goal.reviewPoints.toFixed(2));
    goal.newPoints = Number(goal.newPoints.toFixed(2));
    goal.totalPoints = Number((goal.reviewPoints + goal.newPoints).toFixed(2));
    goal.shortfall = Number(
      Math.max(0, goal.targetReviewPoints + goal.targetNewPoints - goal.totalPoints).toFixed(2),
    );
    if (goal.shortfall)
      goal.reason +=
        '范围内新题或到期任务不足，也可能与其他目标重叠或达到题集容量限制；保留实际缺口。';
  });
  return {
    goals: selected,
    tasks,
    targetReviewPoints: reviews.reduce((n, v) => n + v, 0),
    targetNewPoints: fresh.reduce((n, v) => n + v, 0),
  };
}
