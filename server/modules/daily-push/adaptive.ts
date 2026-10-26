import type { Store } from '../../core/store.js';
import { dailyCalendar } from './calendar.js';

interface QuestionMetadata { id: string; type: string; parts?: Array<{ id: string }> }
export interface AdaptiveDailyPlan { known: boolean; due: boolean; overdue: boolean; shortTerm: boolean; dueAt: number }

/** The daily set may include long-term reviews due later today. Minute-based
 * learning steps enter it only once due; subsequent steps use the live queue. */
export function adaptiveDailyPlans(store: Store, pool: Map<string, QuestionMetadata>, at: Date, timeZone: string): Map<string, AdaptiveDailyPlan> {
  const db = store.database, field = db.expressions.field.bind(db.expressions), date = dailyCalendar(at, timeZone).dateKey;
  const result = new Map<string, AdaptiveDailyPlan>(), represented = new Set<string>();
  const identity = (questionId: string, partId?: string | null) => JSON.stringify([questionId, partId || null]);
  const touch = (questionId: string) => { const plan = result.get(questionId) || { known: true, due: false, overdue: false, shortTerm: false, dueAt: Infinity }; result.set(questionId, plan); return plan; };
  const mark = (questionId: string, partId: string | null | undefined, dueAt: string | null, shortTerm: boolean) => {
    const question = pool.get(questionId); if (!question || partId && (question.type !== 'group' || !question.parts?.some(part => part.id === partId))) return;
    const plan = touch(questionId), stamp = Date.parse(dueAt || '');
    if (!Number.isFinite(stamp)) return;
    const day = dailyCalendar(new Date(stamp), timeZone).dateKey;
    if (shortTerm ? stamp > at.getTime() : day > date) return;
    plan.due = true; plan.overdue ||= day < date; plan.shortTerm ||= shortTerm; plan.dueAt = Math.min(plan.dueAt, stamp);
  };
  const cards = db.all(db.query.selectFrom('review_cards').select([
    field<string>('data', 'questionId').as('questionId'), field<string | null>('data', 'partId').as('partId'),
    field<boolean>('data', 'suspended').as('suspended'), field<string | null>('data', 'dueAt').as('dueAt'), field<any>('data', 'memory').as('memory'),
  ]));
  for (const card of cards) {
    const source = pool.get(card.questionId);
    if (!source || (source.type === 'group' ? !card.partId || !source.parts?.some(part => part.id === card.partId) : !!card.partId)) continue;
    represented.add(identity(card.questionId, card.partId)); touch(card.questionId);
    const memory = typeof card.memory === 'string' ? JSON.parse(card.memory) : card.memory;
    if (!card.suspended) mark(card.questionId, card.partId, card.dueAt, [1, 3].includes(memory?.state));
  }
  const fields = [field<string>('data', 'questionId').as('questionId'), field<string | null>('data', 'partId').as('partId'), field<string | null>('data', 'nextReviewAt').as('nextReviewAt')];
  const parts = db.all(db.query.selectFrom('study_parts').select(fields));
  const explicit = new Set(parts.map(row => identity(row.questionId, row.partId)));
  for (const row of db.all(db.query.selectFrom('study').select(fields))) {
    const source = pool.get(row.questionId); if (!source || !row.nextReviewAt) continue;
    if (source.type === 'group') {
      for (const part of source.parts || []) if (!represented.has(identity(row.questionId, part.id)) && !explicit.has(identity(row.questionId, part.id))) mark(row.questionId, part.id, row.nextReviewAt, false);
    } else if (!represented.has(identity(row.questionId))) mark(row.questionId, undefined, row.nextReviewAt, false);
  }
  for (const row of parts) if (row.nextReviewAt && !represented.has(identity(row.questionId, row.partId))) mark(row.questionId, row.partId, row.nextReviewAt, false);
  return result;
}
