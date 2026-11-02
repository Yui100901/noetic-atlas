import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../../core/store.js';
import { id, fail } from '../../core/validation.js';
import type { ScopedResetPreview } from '../../../shared/models/maintenance.js';
import type { LearningResult } from '../practice/learning-results.js';

export const resetSelectionSchema = z
  .object({
    scope: z.enum(['all', 'paper', 'quick']).default('all'),
    paperId: id.optional(),
    mode: z.enum(['progress', 'complete']).default('progress'),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.scope === 'paper') !== !!value.paperId)
      ctx.addIssue({ code: 'custom', message: '题集范围需要且仅允许一个题集ID' });
  });
export type ResetSelection = z.infer<typeof resetSelectionSchema>;
const stateKey = (questionId: string, partId?: string) =>
  JSON.stringify([questionId, partId ?? null]);
const resetTables = [
  'attempts',
  'learning_results',
  'question_history',
  'study',
  'study_parts',
  'reviews',
  'review_cards',
  'review_events',
  'focus_sessions',
  'learning_task_results',
] as const;
/** Preview fingerprints only selected metadata/hashes. Snapshots and note text
 * never cross into the response, and the question library is not loaded. */
export function resetPlan(store: Store, selection: ResetSelection) {
  const db = store.database,
    x = db.expressions;
  const title =
    selection.scope === 'all'
      ? '全部学习记录'
      : selection.scope === 'quick'
        ? '随机与单题自测'
        : (db.one(
            db.query
              .selectFrom('papers')
              .select(x.field<string>('data', 'title').as('title'))
              .where('id', '=', selection.paperId!),
          )?.title ?? fail(404, 'NOT_FOUND', '题集不存在'));
  const signatures = Object.fromEntries(
    resetTables.map((table) => [
      table,
      db.all(
        db.query
          .selectFrom(table)
          .select('id')
          .select(db.recordFingerprint('data').as('hash'))
          .orderBy('id'),
      ),
    ]),
  );
  const selected = (table: 'attempts' | 'learning_results' | 'question_history') => {
    let query = db.query.selectFrom(table);
    if (selection.scope === 'paper')
      query = query
        .where(x.field('data', 'paperId'), '=', selection.paperId!)
        .where((eb) =>
          eb.or([
            eb(x.field('data', 'source'), 'is', null),
            eb(x.field('data', 'source'), '!=', 'quick'),
          ]),
        );
    if (selection.scope === 'quick')
      query = query.where((eb) =>
        eb.or([
          eb(x.field('data', 'source'), '=', 'quick'),
          eb.and([
            eb(x.field('data', 'source'), 'is', null),
            eb(x.field('data', 'paperId'), '=', 'quick-practice'),
          ]),
        ]),
      );
    return db.all(
      query
        .select('id')
        .select([
          x.field<string>('data', 'status').as('status'),
          x.field<string>('data', 'attemptId').as('attemptId'),
          x.field<string>('data', 'paperId').as('paperId'),
          x.field<boolean>('data', 'reset').as('reset'),
          x.field<string>('data', 'items').as('items'),
        ]),
    );
  };
  const attempts = selected('attempts'),
    results = selected('learning_results'),
    history = selected('question_history');
  const attemptIds = new Set([
    ...attempts.map((v) => v.id),
    ...results.map((v) => v.id),
    ...history.map((v) => v.attemptId),
  ]);
  const focus: Array<{ id: string; indexes: number[]; all: boolean; active: boolean }> = [],
    focusReviewIds = new Set<string>(),
    fixedReviewIds = new Set<string>();
  // Source-only projections: even a mixed 200-question session does not load
  // question snapshots just to preview which entries belong to this scope.
  for (const row of db.all(
    db.query
      .selectFrom('focus_sessions')
      .select('id')
      .select([
        x.field<string | null>('data', 'paperId').as('paperId'),
        x.field<string>('data', 'status').as('status'),
        x.focusResetItems('data').as('items'),
      ]),
  )) {
    const session = { ...row, items: JSON.parse(row.items) as Array<{ paperId?: string }> },
      indexes = session.items.flatMap((item, index) => {
        const paperId = item.paperId || session.paperId;
        return selection.scope === 'all' ||
          (selection.scope === 'paper' && paperId === selection.paperId) ||
          (selection.scope === 'quick' && (!paperId || paperId === 'quick-practice'))
          ? [index]
          : [];
      });
    if (!indexes.length) continue;
    focus.push({
      id: session.id,
      indexes,
      all: indexes.length === session.items.length,
      active: session.status === 'in_progress',
    });
    for (const index of indexes) {
      const key = `${session.id}-${index}`;
      fixedReviewIds.add(key);
      focusReviewIds.add(JSON.stringify(['manual', key]));
    }
  }
  const events = db
    .all(
      db.query
        .selectFrom('review_events')
        .select('id')
        .select([
          x.field<string>('data', 'attemptId').as('attemptId'),
          x.field<string>('data', 'cardId').as('cardId'),
        ]),
    )
    .filter(
      (r) => selection.scope === 'all' || attemptIds.has(r.attemptId) || focusReviewIds.has(r.id),
    );
  const eventIds = new Set(events.map((r) => r.id));
  const reviewRecords = db
    .all(db.query.selectFrom('reviews').select('data'))
    .map(
      (r) =>
        JSON.parse(r.data) as {
          id: string;
          questionId: string;
          partId?: string;
          attemptId?: string;
          schedulerEventId?: string;
          reviewedAt: string;
        },
    )
    .filter(
      (r) =>
        selection.scope === 'all' ||
        (!!r.attemptId && attemptIds.has(r.attemptId)) ||
        fixedReviewIds.has(r.id) ||
        (!!r.schedulerEventId && eventIds.has(r.schedulerEventId)),
    );
  const reviewIds = new Set(reviewRecords.map((r) => r.id));
  const evidenceIds = new Set([...attemptIds, ...events.map((r) => r.id), ...reviewIds]);
  const progress = db
    .all(
      db.query
        .selectFrom('learning_task_results')
        .select('id')
        .select([
          x.field<string>('data', 'attemptId').as('attemptId'),
          x.field<string>('data', 'reviewId').as('reviewId'),
        ]),
    )
    .filter(
      (r) =>
        selection.scope === 'all' || evidenceIds.has(r.attemptId) || evidenceIds.has(r.reviewId),
    );
  const wrongDecrements = new Map<string, number>();
  if (selection.scope !== 'all')
    for (const row of results) {
      if (row.reset) continue;
      const result = { items: JSON.parse(row.items || '[]') as LearningResult['items'] };
      for (const item of result.items)
        if (
          item.type &&
          ['true_false', 'single_choice', 'multiple_choice', 'fill_blank'].includes(item.type) &&
          item.judgment &&
          item.judgment !== 'correct'
        ) {
          const key = stateKey(item.sourceQuestionId || item.id, item.partId);
          wrongDecrements.set(key, (wrongDecrements.get(key) || 0) + 1);
        }
    }
  const sharedCards = new Set(events.map((r) => r.cardId));
  let gradeQuery = db.query
    .selectFrom('ai_runs')
    .select('id')
    .select(db.recordFingerprint('data').as('hash'))
    .where(x.field('data', 'kind'), '=', 'grade');
  if (selection.scope !== 'all')
    gradeQuery = gradeQuery.where(x.valueInJson(x.field('data', 'attemptId'), [...attemptIds]));
  const aiGrades = selection.mode === 'complete' ? db.all(gradeQuery.orderBy('id')) : [];
  const preview: ScopedResetPreview = {
    fingerprint: createHash('sha256')
      .update(JSON.stringify({ selection, signatures, title, aiGrades }))
      .digest('hex'),
    selection,
    title,
    counts: {
      states:
        selection.scope === 'all'
          ? signatures.study.length
          : [...wrongDecrements.keys()].filter((k) => JSON.parse(k)[1] === null).length,
      partStates:
        selection.scope === 'all'
          ? signatures.study_parts.length
          : [...wrongDecrements.keys()].filter((k) => JSON.parse(k)[1] !== null).length,
      reviews: reviewIds.size,
      results: results.filter((r) => !r.reset).length,
      reviewCards: selection.scope === 'all' ? signatures.review_cards.length : sharedCards.size,
      reviewEvents: events.length,
      questionHistory: history.length,
      focusSessions: focus.length,
      planProgress: progress.length,
    },
    retained: {
      attempts:
        selection.mode === 'progress' ? attempts.filter((r) => r.status === 'submitted').length : 0,
      drafts:
        selection.mode === 'progress'
          ? attempts.filter((r) => r.status === 'in_progress').length
          : 0,
      sharedState: selection.scope !== 'all',
      mixedFocus: focus.filter((r) => !r.all).length,
    },
    removed: {
      aiGrades: aiGrades.length,
      attempts:
        selection.mode === 'complete' ? attempts.filter((r) => r.status === 'submitted').length : 0,
      drafts:
        selection.mode === 'complete'
          ? attempts.filter((r) => r.status === 'in_progress').length
          : 0,
      questionHistory: selection.mode === 'complete' ? history.length : 0,
      study:
        selection.mode === 'complete' && selection.scope === 'all'
          ? signatures.study.length + signatures.study_parts.length
          : 0,
    },
  };
  return {
    preview,
    attempts,
    results,
    history,
    attemptIds,
    focus,
    events,
    reviewIds,
    reviewRecords,
    evidenceIds,
    progress,
    wrongDecrements,
    sharedCards,
    aiGrades,
  };
}
