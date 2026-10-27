import type { Store } from '../../core/store.js';
import { fail, parse, id as identifier } from '../../core/validation.js';
import { now, nextStamp } from '../../core/store.js';
import { createHash } from 'node:crypto';
import type { Question, VocabularyDirection } from '../../../shared/models/types.js';
import type { AttemptReviewOverview, FsrsMemory, ReviewCard, ReviewCardView, ReviewDirection, ReviewEvent, ReviewIdentity, ReviewQueue, ReviewQueueItem, ReviewRating } from '../../../shared/models/adaptive-review.js';
import { REVIEW_RATINGS, REVIEW_RATING_LABELS } from '../../../shared/models/adaptive-review.js';
import { getSettings } from '../settings/service.js';
import type { StoredAttempt } from '../practice/service.js';
import { isAnswerPresent } from '../../../shared/practice/attempt-timing.js';
import { getObjectiveCorrect, isSubjectiveType } from '../../../shared/questions/question-utils.js';
import { learningJudgment } from '../practice/learning-state.js';
import { dailyCalendar } from '../daily-push/calendar.js';
import { emptyMemory, retrievability, reviewMemory } from './engine.js';
import { reviewCardSchema, reviewEventSchema } from './schema.js';

export const reviewCardId = (identity: ReviewIdentity) => JSON.stringify([identity.questionId, identity.partId ?? null, identity.direction]);
export const attemptReviewId = (attemptId: string, leafId: string, direction: ReviewDirection) => JSON.stringify(['attempt', attemptId, leafId, direction]);
const manualId = (requestId: string) => JSON.stringify(['manual', requestId]);
const canonical = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const eventOrder = (a: ReviewEvent, b: ReviewEvent) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.id.localeCompare(b.id);
const identityOf = (card: ReviewIdentity): ReviewIdentity => ({ questionId: card.questionId, ...(card.partId ? { partId: card.partId } : {}), direction: card.direction });

interface SourceHeader { id: string; status: string; type: string; hasVocabulary: boolean; hasConcept: boolean; hasLegacyStandard: boolean; leaves: Array<{ partId?: string; type: string }> }
function sourceHeaders(store: Store, ids: string[]): Map<string, SourceHeader> {
  if (!ids.length) return new Map();
  const d = store.database, x = d.expressions;
  const wanted = [...new Set(ids)];
  // Metadata only, one batch lookup for the whole attempt. Adding concept
  // metadata must not discard the established standard card's memory/events.
  const legacy = new Set(d.all(d.query.selectFrom('review_cards').select(x.field<string>('data','questionId').as('questionId'))
    .where(x.valueInJson(x.field<string>('data','questionId'),wanted)).where(x.field('data','partId'),'is',null).where(x.field('data','direction'),'=','standard')).map(row=>row.questionId));
  return new Map(d.all(d.query.selectFrom('questions').select('id').select([x.field<string>('data', 'status').as('status'), x.field<string>('data', 'type').as('type'), x.questionLearningLeaves('data').as('leaves')])
    .select(eb => eb.case().when(eb.and([eb(x.field('data', 'vocabulary'), 'is', null), eb(x.field('data', 'concept'), 'is', null)])).then(0).else(1).end().as('hasVocabulary'))
    .select(eb=>eb.case().when(x.field('data','concept'),'is',null).then(0).else(1).end().as('hasConcept'))
    .where(x.idInJson('id', wanted))).map(row => [row.id, { ...row, hasVocabulary: !!row.hasVocabulary, hasConcept:!!row.hasConcept, hasLegacyStandard:legacy.has(row.id), leaves: JSON.parse(row.leaves) }]));
}
function sourceIdentity(store: Store, questionId: string, partId?: string, direction?: ReviewDirection, supplied?: Map<string, SourceHeader>): ReviewIdentity {
  const question = (supplied || sourceHeaders(store, [questionId])).get(questionId);
  if (!question || question.status !== 'published') return fail(404, 'REVIEW_SOURCE_UNAVAILABLE', '题目已删除、归档或未发布，无法安排复习');
  if (question.type === 'group' ? !partId || !question.leaves.some(part => part.partId === partId) : partId !== undefined) fail(400, 'REVIEW_PART_INVALID', '请选择有效的小题；组合题按小题独立安排复习');
  const forward = !direction || direction === 'standard' || direction === 'word_to_meaning';
  const resolved = question.hasConcept && question.hasLegacyStandard && !partId && forward ? 'standard'
    : question.hasVocabulary && (!direction || direction === 'standard') ? 'word_to_meaning' : direction || 'standard';
  if (resolved !== 'standard' && (!question.hasVocabulary || partId)) fail(400, 'REVIEW_DIRECTION_INVALID', '只有词汇或概念卡可分别记录正向与逆向复习');
  return { questionId, ...(partId ? { partId } : {}), direction: resolved };
}
function eventsFor(store: Store, cardId: string): ReviewEvent[] {
  const d = store.database;
  return d.all(d.query.selectFrom('review_events').select('data').where(d.expressions.field('data', 'cardId'), '=', cardId)).map(row => JSON.parse(row.data) as ReviewEvent).sort(eventOrder);
}
function makeCard(store: Store, identity: ReviewIdentity, at: Date): ReviewCard {
  const d = store.database, table = identity.partId ? 'study_parts' : 'study', key = identity.partId ? JSON.stringify([identity.questionId, identity.partId]) : identity.questionId;
  const dates = [d.expressions.field<string | null>('data', 'nextReviewAt').as('nextReviewAt'), d.expressions.field<string | null>('data', 'lastReviewedAt').as('lastReviewedAt')];
  const study = d.one(d.query.selectFrom(table).select(dates).where('id', '=', key))
    || (identity.partId ? d.one(d.query.selectFrom('study').select(dates).where('id', '=', identity.questionId)) : undefined)
    || { nextReviewAt: null, lastReviewedAt: null }, stamp = at.toISOString();
  return { ...identity, id: reviewCardId(identity), algorithm: 'FSRS-6', libraryVersion: '5.4.2', baseline: emptyMemory(at), memory: emptyMemory(at),
    dueAt: study.nextReviewAt, lastReviewedAt: study.lastReviewedAt, legacyDueAt: study.nextReviewAt, legacyLastReviewedAt: study.lastReviewedAt,
    suspended: false, manualDueAt: null, createdAt: stamp, updatedAt: stamp };
}
export function replayReviewCard(card: ReviewCard, events: ReviewEvent[], writeEvents?: (event: ReviewEvent) => void): ReviewCard {
  let memory = structuredClone(card.baseline);
  for (const event of [...events].sort(eventOrder)) {
    const before = memory;
    memory = reviewMemory(before, event.rating, new Date(event.occurredAt), event.parameters, card.id + ':' + event.id);
    writeEvents?.({ ...event, before, after: memory });
  }
  return { ...card, memory, dueAt: card.manualDueAt || (events.length ? memory.due : card.legacyDueAt), lastReviewedAt: events.length ? memory.last_review || null : card.legacyLastReviewedAt };
}
/** The compatibility due date is the earliest active direction. A suspended
 * direction can never hide or postpone a different direction's due work. */
export function mirrorReviewStudy(store: Store, identity: Pick<ReviewIdentity, 'questionId' | 'partId'>) {
  const d = store.database, x = d.expressions;
  let query = d.query.selectFrom('review_cards').select('data').where(x.field('data', 'questionId'), '=', identity.questionId);
  query = identity.partId ? query.where(x.field('data', 'partId'), '=', identity.partId) : query.where(x.field('data', 'partId'), 'is', null);
  const cards = d.all(query).map(row => JSON.parse(row.data) as ReviewCard);
  if (!cards.length) return;
  const due = cards.filter(card => !card.suspended && card.dueAt).map(card => card.dueAt!).sort((a, b) => Date.parse(a) - Date.parse(b));
  const last = cards.flatMap(card => card.lastReviewedAt ? [card.lastReviewedAt] : []).sort((a, b) => Date.parse(b) - Date.parse(a));
  const study = store.study(identity.questionId, identity.partId);
  if (study.nextReviewAt === (due[0] || null) && study.lastReviewedAt === (last[0] || null)) return;
  store.putStudy({ ...study, nextReviewAt: due[0] || null, lastReviewedAt: last[0] || null });
}
function writeCard(store: Store, card: ReviewCard, events: ReviewEvent[], stamp = now()) {
  const rebuilt = { ...replayReviewCard(card, events, event => store.put('review_events', event.id, event)), updatedAt: nextStamp(card.updatedAt || stamp) };
  store.put('review_cards', rebuilt.id, rebuilt); mirrorReviewStudy(store, rebuilt); return rebuilt;
}

export function reviewCardView(store: Store, input: { questionId: string; partId?: string; direction?: ReviewDirection; attemptId?: string; leafId?: string }, at = new Date()): ReviewCardView {
  const identity = sourceIdentity(store, input.questionId, input.partId, input.direction), cardId = reviewCardId(identity);
  const card = store.get<ReviewCard>('review_cards', cardId) || null, state = card || makeCard(store, identity, at), parameters = getSettings(store).reviewScheduling;
  const events = eventsFor(store, cardId), latest = events.at(-1);
  let memory = state.memory, reviewAt = at, previewParameters = parameters;
  if (input.attemptId) {
    if (!input.leafId) return fail(400, 'REVIEW_LEAF_REQUIRED', '请选择作答小题');
    const eventId = attemptReviewId(input.attemptId, input.leafId, identity.direction), original = events.find(event => event.id === eventId);
    const attempt = store.get<StoredAttempt>('attempts', input.attemptId);
    const question = attempt?.questions.find(question => question.id === input.leafId);
    if (!attempt || attempt.status !== 'submitted' || !question || (question.sourceQuestionId || question.id) !== identity.questionId || question.partId !== identity.partId) return fail(400, 'REVIEW_ATTEMPT_MISMATCH', '复习上下文与作答不一致');
    reviewAt = new Date(attempt.submittedAt!); previewParameters = original?.parameters || parameters;
    memory = replayReviewCard(state, events.filter(event => event.id !== eventId && (Date.parse(event.occurredAt) < reviewAt.getTime() || Date.parse(event.occurredAt) === reviewAt.getTime() && event.id.localeCompare(eventId) < 0))).memory;
  }
  const preview = parameters.strategy === 'fsrs' ? REVIEW_RATINGS.map(rating => {
    const next = reviewMemory(memory, rating, reviewAt, previewParameters, cardId + ':' + (input.attemptId ? attemptReviewId(input.attemptId, input.leafId!, identity.direction) : 'preview'));
    return { rating, label: REVIEW_RATING_LABELS[rating], dueAt: next.due, intervalSeconds: Math.max(0, Math.round((Date.parse(next.due) - reviewAt.getTime()) / 1000)), scheduledDays: next.scheduled_days };
  }) : [];
  return { ...identity, strategy: parameters.strategy, card, dueAt: state.suspended ? null : state.dueAt, lastReviewedAt: state.lastReviewedAt, suspended: state.suspended,
    state: (['new', 'learning', 'review', 'relearning'] as const)[state.memory.state], retrievability: retrievability(state.memory, at), preview,
    eventCount: events.length, latestRating: latest?.rating || null, canReview: parameters.strategy === 'fsrs', ...(parameters.strategy === 'fixed' ? { reason: '当前使用固定间隔，可在系统配置切换自适应复习。' } : {}) };
}

function eligible(store: Store, attempt: StoredAttempt, leafId: string, headers?: Map<string, SourceHeader>, wasReset?: boolean) {
  const question = attempt.questions.find(question => question.id === leafId);
  if (!question || attempt.status !== 'submitted') return { reason: '交卷后才可安排复习' };
  if (!isAnswerPresent(attempt.answers[leafId])) return { reason: '漏答不作为遗忘证据' };
  if (wasReset ?? !!store.get<any>('learning_results', attempt.id)?.reset) return { reason: '该作答属于重置前记录' };
  const direction: ReviewDirection = attempt.vocabularyDirection || ((question.vocabulary || question.concept) ? 'word_to_meaning' : 'standard');
  let identity: ReviewIdentity;
  try { identity = sourceIdentity(store, question.sourceQuestionId || question.id, question.partId, direction, headers); } catch { return { reason: '原题或小题已不可用' }; }
  const header = headers?.get(identity.questionId);
  if (header && !(identity.direction === 'meaning_to_word' && header.hasVocabulary) && (identity.partId ? header.leaves.find(part => part.partId === identity.partId)?.type !== question.type : header.type !== question.type)) return { reason: '原题题型已改变，保留历史但不更新新题的复习状态' };
  const judgment = learningJudgment({ ...question, answerValue: attempt.answers[leafId]?.value, selfScore: attempt.answers[leafId]?.selfScore, verdict: attempt.answers[leafId]?.verdict, scoringEnabled: attempt.scoring?.enabled ?? true, maximumPoints: attempt.scoring?.questionPoints[leafId] });
  const outcome = isSubjectiveType(question.type) ? judgment?.verdict : getObjectiveCorrect(question, attempt.answers[leafId]) ? 'correct' : 'incorrect';
  if (!outcome) return { identity, reason: '主观题尚未判定，判定后再安排复习' };
  const assisted = !!attempt.referenceViewedAt;
  return { identity, automatic: (outcome === 'correct' && !assisted ? 'good' : 'again') as ReviewRating, outcome, assisted };
}

export function syncAttemptReviewEvents(store: Store, attempt: StoredAttempt, ratings: Record<string, ReviewRating | null> = {}, affectedLeafIds?: string[]) {
  const settings = getSettings(store).reviewScheduling;
  if (settings.strategy !== 'fsrs' || attempt.status !== 'submitted' || store.get<any>('learning_results', attempt.id)?.reset) return;
  const selected = affectedLeafIds ? new Set(affectedLeafIds) : null;
  const headers = sourceHeaders(store, attempt.questions.map(question => question.sourceQuestionId || question.id));
  for (const question of attempt.questions) {
    if (selected && !selected.has(question.id)) continue;
    const state = eligible(store, attempt, question.id, headers, false), requested = ratings[question.id];
    if (!state.identity) { if (requested) fail(400, 'REVIEW_NOT_ELIGIBLE', state.reason!); continue; }
    const identity = state.identity, id = attemptReviewId(attempt.id, question.id, identity.direction), previous = store.get<ReviewEvent>('review_events', id);
    const card = store.get<ReviewCard>('review_cards', reviewCardId(identity));
    if (requested === null && previous?.ratingSource === 'manual' && !isSubjectiveType(question.type) && !previous.parameters.autoRateObjective) {
      if (card) { store.remove('review_events', id); writeCard(store, card, eventsFor(store, card.id)); }
      continue;
    }
    if (!state.automatic) {
      if (requested) fail(400, 'REVIEW_NOT_GRADED', state.reason!);
      if (previous && card) { store.remove('review_events', id); writeCard(store, card, eventsFor(store, card.id)); }
      continue;
    }
    if (!isSubjectiveType(question.type) && !settings.autoRateObjective && !previous && requested === undefined) continue;
    if (requested && requested !== 'again' && (state.outcome !== 'correct' || state.assisted)) fail(400, 'REVIEW_RATING_CONFLICT', '回答错误、有关键遗漏或提前查看解析时应选择重学；困难表示独立完整回忆但费力');
    const override = requested === null ? undefined : requested || (previous?.ratingSource === 'manual' && state.outcome === 'correct' && !state.assisted ? previous.rating : undefined);
    const rating = override || state.automatic, ratingSource = override ? 'manual' : 'automatic';
    if (previous && previous.rating === rating && previous.ratingSource === ratingSource) continue;
    const stamp = now(), base = card || makeCard(store, identity, new Date(attempt.submittedAt!));
    const event: ReviewEvent = { ...identity, id, cardId: base.id, source: 'attempt', attemptId: attempt.id, leafId: question.id, rating, ratingSource,
      occurredAt: attempt.submittedAt!, recordedAt: previous?.recordedAt || stamp, updatedAt: stamp, parameters: previous?.parameters || structuredClone(settings), algorithm: 'FSRS-6', libraryVersion: '5.4.2', before: base.memory, after: base.memory };
    store.put('review_events', id, event); writeCard(store, { ...base, manualDueAt: null }, eventsFor(store, base.id));
  }
}

export function attemptReviewOverview(store: Store, attempt: StoredAttempt): AttemptReviewOverview {
  const d = store.database, x = d.expressions;
  const events = new Map(d.all(d.query.selectFrom('review_events').select('data').where(x.field('data', 'attemptId'), '=', attempt.id)).map(row => { const value = JSON.parse(row.data) as ReviewEvent; return [value.leafId!, value]; }));
  const cardIds = [...new Set([...events.values()].map(event => event.cardId))];
  const cards = new Map(cardIds.length ? d.all(d.query.selectFrom('review_cards').select(['id', 'data']).where(x.idInJson('id', cardIds))).map(row => [row.id, JSON.parse(row.data) as ReviewCard]) : []);
  const headers = sourceHeaders(store, attempt.questions.map(question => question.sourceQuestionId || question.id)), wasReset = !!store.get<any>('learning_results', attempt.id)?.reset;
  return { attemptId: attempt.id, strategy: getSettings(store).reviewScheduling.strategy, items: attempt.questions.map(question => {
    const state = eligible(store, attempt, question.id, headers, wasReset), event = events.get(question.id), direction = event?.direction || state.identity?.direction || attempt.vocabularyDirection || ((question.vocabulary || question.concept) ? 'word_to_meaning' : 'standard');
    return { questionId: question.sourceQuestionId || question.id, ...(question.partId ? { partId: question.partId } : {}), direction, leafId: question.id,
      eligible: !!state.automatic, ...(state.reason ? { reason: state.reason } : {}), ...(event ? { eventId: event.id, rating: event.rating, ratingSource: event.ratingSource } : {}), card: event ? cards.get(event.cardId) || null : null };
  }) };
}

export function recordManualReview(store: Store, input: { questionId: string; partId?: string; direction?: ReviewDirection; rating: ReviewRating; requestId: string }, at = new Date()): ReviewCardView {
  if (getSettings(store).reviewScheduling.strategy !== 'fsrs') fail(409, 'REVIEW_FIXED_MODE', '请先在系统配置开启自适应复习');
  const identity = sourceIdentity(store, input.questionId, input.partId, input.direction), id = manualId(input.requestId), previous = store.get<ReviewEvent>('review_events', id);
  if (previous) {
    if (previous.cardId !== reviewCardId(identity) || previous.rating !== input.rating) fail(409, 'REVIEW_REQUEST_CONFLICT', '该复习请求已处理且内容不同，请刷新后重试');
    return reviewCardView(store, identity, at);
  }
  store.transaction(() => {
    const card = store.get<ReviewCard>('review_cards', reviewCardId(identity)) || makeCard(store, identity, at), stamp = at.toISOString();
    const event: ReviewEvent = { ...identity, id, cardId: card.id, source: 'manual', rating: input.rating, ratingSource: 'manual', occurredAt: stamp, recordedAt: stamp, updatedAt: stamp,
      parameters: structuredClone(getSettings(store).reviewScheduling), algorithm: 'FSRS-6', libraryVersion: '5.4.2', before: card.memory, after: card.memory };
    store.put('review_events', id, event); writeCard(store, { ...card, manualDueAt: null }, eventsFor(store, card.id), stamp);
    const study = store.study(identity.questionId, identity.partId), reviewId = 'review-' + createHash('sha256').update(id).digest('hex').slice(0, 32);
    store.put('reviews', reviewId, { id: reviewId, questionId: identity.questionId, ...(identity.partId ? { partId: identity.partId } : {}), mastery: study.mastery ?? 2, reviewedAt: stamp, source: 'manual', rating: input.rating, schedulerEventId: id });
  });
  return reviewCardView(store, identity, at);
}

export function changeReviewCard(store: Store, input: { questionId: string; partId?: string; direction?: ReviewDirection; suspended?: boolean; dueAt?: string | null }, at = new Date()): ReviewCardView {
  const identity = sourceIdentity(store, input.questionId, input.partId, input.direction);
  store.transaction(() => {
    const current = store.get<ReviewCard>('review_cards', reviewCardId(identity)) || makeCard(store, identity, at);
    const card = { ...current, ...(input.suspended !== undefined ? { suspended: input.suspended } : {}), ...(input.dueAt !== undefined ? { manualDueAt: input.dueAt } : {}) };
    writeCard(store, card, eventsFor(store, card.id));
  });
  return reviewCardView(store, identity, at);
}

/** Full backups carry complete lightweight event chains. Reject forged states
 * before merging any records, including records whose full attempts were pruned. */
export function validateReviewImport(inputCards: unknown[], inputEvents: unknown[]) {
  const cards = inputCards.map(value => parse(reviewCardSchema, value)) as ReviewCard[], events = inputEvents.map(value => parse(reviewEventSchema, value)) as ReviewEvent[];
  if (new Set(cards.map(card => card.id)).size !== cards.length || new Set(events.map(event => event.id)).size !== events.length) fail(400, 'REVIEW_IMPORT_DUPLICATE', '复习卡片或事件身份重复');
  const byId = new Map(cards.map(card => [card.id, card])), eventById = new Map(events.map(event => [event.id, event]));
  const eventsByCard = new Map<string, ReviewEvent[]>();
  for (const card of cards) if (card.id !== reviewCardId(card) || card.baseline.reps || card.baseline.lapses || card.baseline.state !== 0 || card.baseline.stability || card.baseline.difficulty || card.baseline.elapsed_days || card.baseline.scheduled_days || card.baseline.learning_steps || card.baseline.last_review || !same(card.baseline, emptyMemory(new Date(card.baseline.due)))) fail(400, 'REVIEW_IMPORT_IDENTITY', '复习卡片身份或冷启动基线不一致');
  for (const event of events) {
    const card = byId.get(event.cardId);
    let expectedId = '';
    if (event.source === 'manual') {
      let parts: unknown; try { parts = JSON.parse(event.id); } catch { fail(400, 'REVIEW_IMPORT_IDENTITY', '手动复习事件身份无效'); }
      if (!Array.isArray(parts) || parts.length !== 2 || parts[0] !== 'manual' || !identifier.safeParse(parts[1]).success || event.attemptId !== undefined || event.leafId !== undefined || event.ratingSource !== 'manual') fail(400, 'REVIEW_IMPORT_IDENTITY', '手动复习事件身份无效');
      else expectedId = manualId(parts[1]);
    } else if (event.attemptId && event.leafId) expectedId = attemptReviewId(event.attemptId, event.leafId, event.direction);
    if (!card || event.cardId !== reviewCardId(event) || event.id !== expectedId || event.parameters.strategy !== 'fsrs') fail(400, 'REVIEW_IMPORT_IDENTITY', '复习事件身份或卡片引用不一致');
    if (event.source === 'attempt' && (event.partId ? event.leafId !== `${event.questionId}::${event.partId}` : event.leafId !== event.questionId)) fail(400, 'REVIEW_IMPORT_IDENTITY', '复习事件小题引用不一致');
    const chain = eventsByCard.get(event.cardId);
    if (chain) chain.push(event); else eventsByCard.set(event.cardId, [event]);
  }
  for (const card of cards) {
    const chain = eventsByCard.get(card.id) || [];
    const rebuilt = replayReviewCard(card, chain, event => { const input = eventById.get(event.id)!; if (!same(input.before, event.before) || !same(input.after, event.after)) fail(400, 'REVIEW_IMPORT_STATE', '复习事件记忆状态与算法重放不一致'); });
    if (!same(card.memory, rebuilt.memory) || card.dueAt !== rebuilt.dueAt || card.lastReviewedAt !== rebuilt.lastReviewedAt) fail(400, 'REVIEW_IMPORT_STATE', '复习卡片状态与事件历史不一致');
  }
  return { cards, events };
}

export function reviewQueue(store: Store, input: { page: number; pageSize: number; domainId?: string; categoryId?: string; kind?: string; direction?: ReviewDirection }, at = new Date()): ReviewQueue {
  const d = store.database, x = d.expressions, timeZone = getSettings(store).dailyPush.timeZone, today = dailyCalendar(at, timeZone).dateKey;
  const identities = d.all(d.query.selectFrom('review_cards').select([x.field<string>('data', 'questionId').as('questionId'), x.field<string | null>('data', 'partId').as('partId'), x.field<ReviewDirection>('data','direction').as('direction')]));
  const legacyStandard = new Set(identities.filter(row=>row.direction==='standard' && !row.partId).map(row=>row.questionId));
  const represented = new Set(identities.map(row => JSON.stringify([row.questionId, row.partId ?? null])));
  const broadUntil = new Date(at.getTime() + 2 * 86400000).toISOString();
  const allCards = d.all(d.query.selectFrom('review_cards').select('data').where(eb => eb.or([eb(x.field('data', 'suspended'), '=', 1), eb(x.field('data', 'dueAt'), '<=', broadUntil)]))).map(row => JSON.parse(row.data) as ReviewCard).filter(card => card.suspended || card.dueAt && Date.parse(card.dueAt) <= at.getTime());
  const legacyFields = [x.field<string>('data', 'questionId').as('questionId'), x.field<string | null>('data', 'partId').as('partId'), x.field<string | null>('data', 'nextReviewAt').as('nextReviewAt')];
  const partStudies = d.all(d.query.selectFrom('study_parts').select(legacyFields));
  const explicitParts = new Set(partStudies.map(row => JSON.stringify([row.questionId, row.partId])));
  const legacy = [...d.all(d.query.selectFrom('study').select(legacyFields).where(x.field('data', 'nextReviewAt'), 'is not', null)), ...partStudies]
    .filter(row => !represented.has(JSON.stringify([row.questionId, row.partId ?? null])) && row.nextReviewAt && Date.parse(row.nextReviewAt) <= at.getTime());
  const wanted = [...new Set([...allCards.map(card => card.questionId), ...legacy.map(row => row.questionId)])];
  const metadata = wanted.length ? d.all(d.query.selectFrom('questions').select('id').select([x.field<string>('data', 'title').as('title'), x.field<string>('data', 'type').as('type'), x.field<string>('data', 'categoryIds').as('categoryIds'), x.questionLearningLeaves('data').as('leaves')])
    .select(eb => eb.case().when(eb.and([eb(x.field('data', 'vocabulary'), 'is', null), eb(x.field('data', 'concept'), 'is', null)])).then(0).else(1).end().as('hasVocabulary')).select(eb=>eb.case().when(x.field('data','concept'),'is',null).then(0).else(1).end().as('hasConcept')).where(x.idInJson('id', wanted)).where(x.field('data', 'status'), '=', 'published'))
    .map(row => ({ id: row.id, data: { ...row, categoryIds: JSON.parse(row.categoryIds || '[]') as string[], parts: (JSON.parse(row.leaves) as Array<{ partId?: string }>).map(leaf => ({ id: leaf.partId })) } })) : [];
  const categories = input.categoryId ? new Set(store.categoryDescendants(input.categoryId)) : null;
  const domainCategories = input.domainId ? new Set(d.all(d.query.selectFrom('categories').select('id').where(x.field('data', 'domainId'), '=', input.domainId)).map(row => row.id)) : null;
  const questions = new Map(metadata.filter(row => (!categories || row.data.categoryIds.some((id: string) => categories.has(id))) && (!domainCategories || row.data.categoryIds.some((id: string) => domainCategories.has(id)))).map(row => [row.id, row.data]));
  const pending: ReviewQueueItem[] = [], summary = { due: 0, overdue: 0, relearning: 0, today: 0, suspended: 0 };
  const add = (identity: ReviewIdentity, dueAt: string | null, card: ReviewCard | null) => {
    const question = questions.get(identity.questionId); if (!question || question.type === 'group' && !identity.partId || identity.partId && !question.parts?.some((part: any) => part.id === identity.partId)) return;
    const logicalDirection: ReviewDirection = question.hasConcept && identity.direction === 'standard' ? 'word_to_meaning' : identity.direction;
    // A legacy standard card is the concept's established forward identity.
    // Keep a previously-created extra forward chain as history, not a second
    // live due task competing with the canonical old card.
    if (question.hasConcept && legacyStandard.has(identity.questionId) && identity.direction === 'word_to_meaning') return;
    if (input.direction && input.direction !== logicalDirection) return;
    if (card?.suspended) { summary.suspended++; return; }
    if (!dueAt || !Number.isFinite(Date.parse(dueAt)) || Date.parse(dueAt) > at.getTime()) return;
    const overdue = dailyCalendar(new Date(dueAt), timeZone).dateKey < today, relearning = !!card && [1, 3].includes(card.memory.state);
    summary.due++; if (overdue) summary.overdue++; else summary.today++; if (relearning) summary.relearning++;
    if (input.kind === 'overdue' && !overdue || input.kind === 'today' && overdue || input.kind === 'relearning' && !relearning) return;
    pending.push({ ...identity, ...(logicalDirection !== identity.direction ? {logicalDirection} : {}), ...(question.hasConcept ? {practiceKind:'concept' as const} : question.hasVocabulary ? {practiceKind:'vocabulary' as const} : {}), key: reviewCardId(identity), title: question.title, ...(identity.partId ? { partTitle: identity.partId } : {}), href: `#/questions/${encodeURIComponent(identity.questionId)}${identity.partId ? '?part=' + encodeURIComponent(identity.partId) : ''}`, card, dueAt, reason: card ? relearning ? 'relearning' : overdue ? 'overdue' : 'today' : 'legacy' });
  };
  for (const card of allCards) add(card, card.dueAt, card);
  for (const row of legacy) {
    const question = questions.get(row.questionId);
    if (question?.type === 'group' && !row.partId) {
      for (const part of question.parts) {
        if (!part.id || represented.has(JSON.stringify([row.questionId, part.id])) || explicitParts.has(JSON.stringify([row.questionId, part.id]))) continue;
        add({ questionId: row.questionId, partId: part.id, direction: 'standard' }, row.nextReviewAt, null);
      }
    } else add({ questionId: row.questionId, ...(row.partId ? { partId: row.partId } : {}), direction: question?.hasVocabulary ? 'word_to_meaning' : 'standard' }, row.nextReviewAt, null);
  }
  pending.sort((a, b) => Number(b.reason === 'relearning') - Number(a.reason === 'relearning') || Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.key.localeCompare(b.key));
  return { items: pending.slice((input.page - 1) * input.pageSize, input.page * input.pageSize), total: pending.length, page: input.page, pageSize: input.pageSize, summary };
}
