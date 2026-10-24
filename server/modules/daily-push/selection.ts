import { randomInt } from 'node:crypto';
import type { QuestionType } from '../../../shared/models/types.js';
import type { DailyPushSettings } from '../../../shared/models/daily-push.js';
import type { Store } from '../../core/store.js';
import { learningMetadata } from '../practice/learning-results.js';
import { dailyCalendar } from './calendar.js';
import { cents, fromCents } from '../practice/scoring.js';

interface Metadata { id: string; type: QuestionType; categoryIds: string[]; parts?: Array<{ id: string }> }
interface Candidate { id: string; points: number; slots: number; learned: boolean; priority: number; lastAt: number }
const shuffle = <T>(values: T[]): T[] => { for (let index = values.length - 1; index > 0; index--) { const position = randomInt(0, index + 1); [values[index], values[position]] = [values[position]!, values[index]!]; } return values; };

/** Only metadata, compact learning evidence and state markers are read here.
 * Full stems/answers are fetched later for the final selected question IDs. */
export function selectDailyQuestions(store: Store, config: DailyPushSettings, pointsByType: Record<QuestionType, number>, at: Date) {
  const allowed = new Set<string>(); for (const id of config.categoryIds) for (const descendant of store.categoryDescendants(id)) allowed.add(descendant);
  const metadata = (store.questionMetadata({ domainId: config.domainId, status: 'published' }) as Metadata[]).filter(question => question.categoryIds.some(id => allowed.has(id)));
  const pool = new Map(metadata.map(question => [question.id, question]));
  const learned = new Set<string>(), latest = new Map<string, number>(), judgments = new Map<string, Map<string, string>>(), due = new Set<string>();
  const dateKey = dailyCalendar(at, config.timeZone).dateKey;
  const mark = (id: string, time: string | null | undefined) => { if (!pool.has(id)) return; learned.add(id); latest.set(id, Math.max(latest.get(id) || 0, Date.parse(time || '') || 0)); };
  const db = store.database, field = db.expressions.field.bind(db.expressions);
  const states = (['study', 'study_parts'] as const).flatMap(table => db.all(db.query.selectFrom(table).select([field<string>('data', 'questionId').as('questionId'), field<string | null>('data', 'partId').as('partId'), field<number | null>('data', 'mastery').as('mastery'), field<string | null>('data', 'lastReviewedAt').as('lastReviewedAt'), field<string | null>('data', 'nextReviewAt').as('nextReviewAt')])));
  for (const state of states) {
    const question = pool.get(state.questionId); if (!question) continue;
    if (state.partId && (question.type !== 'group' || !question.parts?.some(part => part.id === state.partId))) continue;
    if (state.mastery != null || state.lastReviewedAt || state.nextReviewAt && Number.isFinite(Date.parse(state.nextReviewAt))) mark(state.questionId, state.lastReviewedAt);
    if (state.nextReviewAt && Number.isFinite(Date.parse(state.nextReviewAt)) && dailyCalendar(new Date(state.nextReviewAt), config.timeZone).dateKey <= dateKey) due.add(state.questionId);
  }
  for (const result of learningMetadata(store)) {
    if (result.status !== 'submitted') continue;
    for (const item of result.items) {
      const id = item.sourceQuestionId || item.id, question = pool.get(id); if (!question) continue;
      if (item.partId && (question.type !== 'group' || !question.parts?.some(part => part.id === item.partId))) continue;
      if (item.answered === true || item.answered === undefined && item.judgment && item.judgment !== 'unanswered') mark(id, result.submittedAt);
      if (item.judgment) { const byPart = judgments.get(id) || new Map<string, string>(), key = item.partId || ''; if (!byPart.has(key)) byPart.set(key, item.judgment); judgments.set(id, byPart); }
    }
  }
  // The independent index records actual answers, including ungraded ones,
  // after whole-history retention. Never read its optional detail snapshots.
  const history = db.all(db.query.selectFrom('question_history').select([field<string>('data', 'questionId').as('questionId'), field<string | null>('data', 'partId').as('partId'), field<string>('data', 'submittedAt').as('submittedAt')]).where(eb => eb.or([eb(field('data', 'beforeReset'), 'is', null), eb(field('data', 'beforeReset'), '=', 0)])));
  for (const record of history) { const question = pool.get(record.questionId); if (!question || record.partId && (question.type !== 'group' || !question.parts?.some(part => part.id === record.partId))) continue; mark(record.questionId, record.submittedAt); }
  const candidates: Candidate[] = metadata.map(question => ({ id: question.id, points: cents(pointsByType[question.type]), slots: question.type === 'group' ? question.parts?.length || 0 : 1, learned: learned.has(question.id), priority: ([...judgments.get(question.id)?.values() || []].some(value => ['incorrect', 'partial', 'unanswered'].includes(value)) ? 2 : 0) + (due.has(question.id) ? 1 : 0), lastAt: latest.get(question.id) || 0 })).filter(question => question.slots > 0 && question.slots <= 500 && question.points > 0);
  const review = shuffle(candidates.filter(question => question.learned)).sort((a, b) => b.priority - a.priority || a.lastAt - b.lastAt), fresh = shuffle(candidates.filter(question => !question.learned));
  const chosen = new Set<string>(), reviewIds: string[] = [], newIds: string[] = []; let reviewCents = 0, newCents = 0, answerSlots = 0;
  const take = (question: Candidate): boolean => {
    if (chosen.has(question.id) || answerSlots + question.slots > 500 || reviewCents + newCents + question.points > 1_000_000) return false;
    chosen.add(question.id); answerSlots += question.slots;
    if (question.learned) { reviewIds.push(question.id); reviewCents += question.points; } else { newIds.push(question.id); newCents += question.points; }
    return true;
  };
  const reviewTarget = cents(config.reviewPoints), baseNewTarget = cents(config.newPoints), target = reviewTarget + baseNewTarget;
  for (const question of review) { if (reviewCents >= reviewTarget) break; take(question); }
  const transferred = Math.max(0, reviewTarget - reviewCents), effectiveNewTarget = baseNewTarget + transferred;
  for (const question of fresh) { if (newCents >= effectiveNewTarget) break; take(question); }
  // If new material is exhausted, remaining learned questions can still make
  // a useful complete daily set. No question is repeated to manufacture points.
  for (const question of [...fresh, ...review]) { if (reviewCents + newCents >= target) break; take(question); }
  const total = reviewCents + newCents, shortfall = Math.max(0, target - total);
  const reason = !chosen.size ? '所选范围没有可用的已发布题目。' : shortfall ? `可用题目、每次500个作答项或10000分上限限制，本次比目标少${fromCents(shortfall)}分。` : transferred ? `复习题不足，已将${fromCents(transferred)}分目标补给新题。` : newCents < baseNewTarget ? '受可用新题、分值粒度或整卷上限影响，实际配比有调整，总分已达到目标。' : '';
  return { questionIds: [...reviewIds, ...newIds], reviewQuestionIds: reviewIds, newQuestionIds: newIds, reviewPoints: fromCents(reviewCents), newPoints: fromCents(newCents), totalPoints: fromCents(total), transferredPoints: fromCents(transferred), targetNewPoints: fromCents(effectiveNewTarget), answerSlots, shortfall: fromCents(shortfall), reason, available: candidates.length };
}
