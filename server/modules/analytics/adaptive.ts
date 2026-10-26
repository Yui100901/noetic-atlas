import type { AdaptiveAnalytics, AdaptiveRecallMetrics } from '../../../shared/models/analytics.js';
import type { FsrsMemory, ReviewRating } from '../../../shared/models/adaptive-review.js';
import type { Store } from '../../core/store.js';
import { addDays, calendar } from './calendar.js';

const percentage = (successes: number, total: number) => total ? Math.round(successes / total * 10000) / 100 : null;
const emptyRecall = (): AdaptiveRecallMetrics => ({ feedbackEvents: 0, recallSuccesses: 0, recallSuccessRate: null });
const identity = (questionId: string, partId: string | null) => JSON.stringify([questionId, partId ?? null]);

/** All queries project scheduling/identity metadata; no question or answer bodies
 * are materialized, and legacy study dates cannot double-count FSRS directions. */
function liveQueue(store: Store, at: Date, timeZone: string): AdaptiveAnalytics['queue'] {
  const d = store.database, x = d.expressions, clock = calendar(timeZone), today = clock.date(at);
  const cards = d.all(d.query.selectFrom('review_cards').select('id').select([
    x.field<string>('data', 'questionId').as('questionId'), x.field<string | null>('data', 'partId').as('partId'),
    x.field<string>('data', 'direction').as('direction'), x.field<string | null>('data', 'dueAt').as('dueAt'),
    x.field<boolean | number>('data', 'suspended').as('suspended'), x.field<string>('data', 'memory').as('memory'),
    x.field<string>('data', 'createdAt').as('createdAt'), x.field<string | null>('data', 'lastReviewedAt').as('lastReviewedAt'),
  ]));
  // An imported future exposure can overwrite today's card. Its prior manual
  // due/suspension state is not retained, so omitting that card would silently
  // undercount the backlog. Withhold the snapshot rather than fabricate one.
  if (cards.some(card => Date.parse(card.createdAt) > at.getTime() || card.lastReviewedAt && Date.parse(card.lastReviewedAt) > at.getTime())) return null;
  const represented = new Set(cards.map(card => identity(card.questionId, card.partId)));
  const legacyQuery = (table: 'study' | 'study_parts') => d.query.selectFrom(table).select([
    x.field<string>('data', 'questionId').as('questionId'), x.field<string | null>('data', 'partId').as('partId'),
    x.field<string | null>('data', 'nextReviewAt').as('dueAt'),
  ]);
  const legacyRows = d.all(legacyQuery('study').where(x.field('data', 'nextReviewAt'), 'is not', null).unionAll(legacyQuery('study_parts')));
  const explicitParts = new Set(legacyRows.filter(row => !!row.partId).map(row => identity(row.questionId, row.partId)));
  const legacy = legacyRows
    .filter(row => !represented.has(identity(row.questionId, row.partId)) && row.dueAt && Date.parse(row.dueAt) <= at.getTime());
  const eligibleCards = cards.filter(card => Date.parse(card.createdAt) <= at.getTime() && (!card.lastReviewedAt || Date.parse(card.lastReviewedAt) <= at.getTime()) && (card.suspended || card.dueAt && Date.parse(card.dueAt) <= at.getTime()));
  const wanted = [...new Set([...eligibleCards, ...legacy].map(row => row.questionId))];
  const sources = new Map(wanted.length ? d.all(d.query.selectFrom('questions').select('id').select([
    x.field<string>('data', 'type').as('type'), x.questionLearningLeaves('data').as('leaves'),
  ]).select(eb => eb.case().when(x.field('data', 'vocabulary'), 'is', null).then(0).else(1).end().as('hasVocabulary'))
    .where(x.idInJson('id', wanted)).where(x.field('data', 'status'), '=', 'published'))
    .map(row => [row.id, { ...row, parts: new Set((JSON.parse(row.leaves) as Array<{ partId?: string }>).flatMap(leaf => leaf.partId ? [leaf.partId] : [])) }]) : []);
  const queue = { asOf: at.toISOString(), due: 0, overdue: 0, relearning: 0, today: 0, suspended: 0 };
  const validSource = (row: { questionId: string; partId: string | null }, direction?: string) => {
    const source = sources.get(row.questionId);
    return !!source && (source.type === 'group' ? !!row.partId && source.parts.has(row.partId) : !row.partId)
      && (!direction || direction === 'standard' || !!source.hasVocabulary && !row.partId);
  };
  const addDue = (dueAt: string, relearning: boolean) => {
    queue.due++; if (clock.date(new Date(dueAt)) < today) queue.overdue++; else queue.today++;
    if (relearning) queue.relearning++;
  };
  for (const card of eligibleCards) {
    if (!validSource(card, card.direction)) continue;
    if (card.suspended) { queue.suspended++; continue; }
    if (card.dueAt && Number.isFinite(Date.parse(card.dueAt))) addDue(card.dueAt, [1, 3].includes((JSON.parse(card.memory) as FsrsMemory).state));
  }
  for (const row of legacy) {
    if (!row.dueAt || !Number.isFinite(Date.parse(row.dueAt))) continue;
    const source = sources.get(row.questionId);
    if (source?.type === 'group' && !row.partId) {
      for (const partId of source.parts) if (!represented.has(identity(row.questionId, partId)) && !explicitParts.has(identity(row.questionId, partId))) addDue(row.dueAt, false);
    } else if (validSource(row)) addDue(row.dueAt, false);
  }
  return queue;
}

/** Count immutable event identities once, using the original occurrence instant.
 * Subsequent grade/rating corrections update the retained event in place. */
export function adaptiveAnalytics(store: Store, from: number, until: number, timeZone: string, now: Date, live: boolean): AdaptiveAnalytics {
  const d = store.database, x = d.expressions, clock = calendar(timeZone);
  const lower = addDays(new Date(from).toISOString().slice(0, 10), -2) + 'T';
  const upper = addDays(new Date(until).toISOString().slice(0, 10), 2) + 'T';
  const events = d.all(d.query.selectFrom('review_events').select('id').select([
    x.field<string>('data', 'cardId').as('cardId'), x.field<ReviewRating>('data', 'rating').as('rating'),
    x.field<string>('data', 'occurredAt').as('occurredAt'), x.field<string>('data', 'before').as('before'),
  ]).where(x.field('data', 'occurredAt'), '>=', lower).where(x.field('data', 'occurredAt'), '<', upper))
    .filter(event => Date.parse(event.occurredAt) >= from && Date.parse(event.occurredAt) < until);
  const result: AdaptiveAnalytics = {
    ...emptyRecall(), uniqueCards: 0, ratings: { again: 0, hard: 0, good: 0, easy: 0 },
    timing: { new: emptyRecall(), early: emptyRecall(), due: emptyRecall(), overdue: emptyRecall(), unknown: emptyRecall() },
    queue: live ? liveQueue(store, now, timeZone) : null,
    dueProcessing: { completedDueCycles: 0, pendingDue: null, rate: null, reason: '' },
  };
  const cards = new Set<string>();
  const add = (metrics: AdaptiveRecallMetrics, rating: ReviewRating) => { metrics.feedbackEvents++; if (rating !== 'again') metrics.recallSuccesses++; };
  for (const event of events) {
    if (!(event.rating in result.ratings)) continue;
    const memory = JSON.parse(event.before) as FsrsMemory, occurred = Date.parse(event.occurredAt), due = Date.parse(memory.due);
    const timing = memory.reps === 0 ? 'new' : !Number.isFinite(due) ? 'unknown' : due > occurred ? 'early' : clock.date(new Date(due)) < clock.date(new Date(occurred)) ? 'overdue' : 'due';
    cards.add(event.cardId); result.ratings[event.rating]++; add(result, event.rating); add(result.timing[timing], event.rating);
  }
  result.uniqueCards = cards.size;
  for (const metrics of [result, ...Object.values(result.timing)]) metrics.recallSuccessRate = percentage(metrics.recallSuccesses, metrics.feedbackEvents);
  const completed = result.timing.due.feedbackEvents + result.timing.overdue.feedbackEvents;
  result.dueProcessing = {
    completedDueCycles: completed, pendingDue: result.queue?.due ?? null,
    rate: result.queue ? percentage(completed, completed + result.queue.due) : null,
    reason: result.queue
      ? '本时段到期处理比例＝本时段按FSRS记忆计划完成的到期或逾期复习周期÷（这些周期＋当前仍到期的可复习任务，含旧计划）。同一卡可有多个周期；暂停任务不计入。这不是历史计划完成率。'
      : live ? '卡片包含统计截止之后的复习状态，缺少截止时刻的队列快照，无法可靠计算当前积压及到期处理比例。' : '缺少此时段终点的队列与计划快照，无法可靠还原到期处理比例及队列；仅展示截至统计截止时刻的反馈表现。',
  };
  return result;
}
