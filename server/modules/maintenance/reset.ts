import type { Store } from '../../core/store.js';
import { now, nextStamp } from '../../core/store.js';
import { fail } from '../../core/validation.js';
import type { FocusSession } from '../../../shared/models/focus-review.js';
import { resetAllProgress, markResultReset } from './reset-progress.js';
import { freezePracticeTiming } from '../practice/practice-timing.js';
import { focusSummary } from '../focus-review/service.js';
import { removeReviewSources } from '../review-scheduler/service.js';
import { recordMaintenance } from './journal.js';
import { resetPlan, type ResetSelection } from './reset-plan.js';
import { restorePeerPlanEvidence } from './plan-evidence.js';

/** Explicit reset operates by provenance. A question shared by two sets keeps
 * the peer set's evidence, private notes and manual mastery. */
export function executeReset(store: Store, selection: ResetSelection, fingerprint: string) {
  return store.transaction(() => {
    const plan = resetPlan(store, selection);
    if (plan.preview.fingerprint !== fingerprint)
      fail(409, 'LEARNING_RESET_PREVIEW_STALE', '预览后学习记录已变化，请重新预览后确认');
    if (selection.scope === 'all' && selection.mode === 'progress') resetAllProgress(store);
    else if (selection.scope === 'all') {
      for (const table of [
        'attempts',
        'question_history',
        'learning_results',
        'study',
        'study_parts',
        'reviews',
        'review_cards',
        'review_events',
        'focus_sessions',
        'learning_task_results',
      ] as const)
        store.database.run(store.database.query.deleteFrom(table));
      const db = store.database,
        x = db.expressions;
      for (const row of db.all(
        db.query
          .selectFrom('ai_runs')
          .select('id')
          .where(x.arrayLength('data', 'appendedNotes'), '>', 0),
      )) {
        const run = db.getRecord<any>('ai_runs', row.id);
        db.putRecord('ai_runs', row.id, { ...run, appendedNotes: [] });
      }
    } else {
      for (const row of plan.results) {
        if (selection.mode === 'complete') {
          store.database.deleteRecord('learning_results', row.id);
          continue;
        }
        markResultReset(store, row.id);
      }
      for (const row of plan.attempts) {
        if (selection.mode === 'complete') store.remove('attempts', row.id);
        else if (
          row.status === 'submitted' &&
          !plan.results.some((result) => result.id === row.id)
        ) {
          markResultReset(store, row.id);
        }
      }
      for (const row of plan.history) {
        if (selection.mode === 'complete') store.remove('question_history', row.id);
        else
          store.put('question_history', row.id, {
            ...store.require<any>('question_history', row.id),
            beforeReset: true,
          });
      }
      for (const [key, count] of plan.wrongDecrements) {
        const [questionId, partId] = JSON.parse(key) as [string, string | null];
        const state = store.study(questionId, partId ?? undefined);
        store.putStudy({ ...state, wrongCount: Math.max(0, state.wrongCount - count) });
      }
      for (const id of plan.reviewIds) store.database.deleteRecord('reviews', id);
      removeReviewSources(store, new Set(plan.events.map((r) => r.id)));
      // Fixed-interval reviews do not own FSRS cards. Only replace dates that
      // still point to the deleted evidence; preserve later manual/peer changes.
      for (const review of plan.reviewRecords) {
        const db = store.database,
          x = db.expressions;
        let cards = db.query
          .selectFrom('review_cards')
          .select('id')
          .where(x.field('data', 'questionId'), '=', review.questionId);
        cards = review.partId
          ? cards.where(x.field('data', 'partId'), '=', review.partId)
          : cards.where(x.field('data', 'partId'), 'is', null);
        if (db.one(cards)) continue;
        const state = store.study(review.questionId, review.partId);
        if (state.lastReviewedAt !== review.reviewedAt) continue;
        let peers = db.query
          .selectFrom('reviews')
          .select(x.field<string>('data', 'reviewedAt').as('date'))
          .where(x.field('data', 'questionId'), '=', review.questionId);
        peers = review.partId
          ? peers.where(x.field('data', 'partId'), '=', review.partId)
          : peers.where(x.field('data', 'partId'), 'is', null);
        const last = db.one(peers.orderBy('date', 'desc').limit(1))?.date || null;
        store.putStudy({
          ...state,
          lastReviewedAt: last,
          ...(!last && !state.wrongCount ? { nextReviewAt: null } : {}),
        });
      }
      for (const row of plan.focus) {
        if (selection.mode === 'complete' && row.all) {
          store.remove('focus_sessions', row.id);
          continue;
        }
        const session = store.require<FocusSession>('focus_sessions', row.id);
        for (const index of row.indexes) {
          const item = session.items[index]!;
          item.beforeReset = true;
          if (selection.mode === 'complete') {
            item.phase = 'skipped';
            item.mode = 'mental';
            delete item.answer;
            delete item.attemptId;
            delete item.rating;
            delete item.verdict;
            delete item.dueAt;
          }
        }
        if (session.status === 'in_progress') {
          session.status = 'submitted';
          session.submittedAt = now();
          freezePracticeTiming(session);
        }
        if (row.all) session.reset = true;
        session.updatedAt = nextStamp(session.updatedAt);
        session.revision++;
        session.summary = focusSummary(session);
        store.put('focus_sessions', session.id, session);
      }
      for (const row of plan.progress) {
        const value = store.require<any>('learning_task_results', row.id);
        if (plan.evidenceIds.has(value.attemptId)) {
          value.attemptId = null;
          value.answeredAt = null;
        }
        if (plan.evidenceIds.has(value.reviewId)) {
          value.reviewId = null;
          value.reviewedAt = null;
        }
        const day = store.get<any>('learning_days', value.dayId),
          task = day?.tasks.find((t: any) => t.id === value.taskId);
        value.completedAt = value.reviewedAt || (task?.kind === 'new' ? value.answeredAt : null);
        if (!value.answeredAt && !value.reviewedAt) store.remove('learning_task_results', row.id);
        else store.put('learning_task_results', row.id, value);
      }
      restorePeerPlanEvidence(store, new Set(plan.progress.map((row) => row.id)));
    }
    for (const row of plan.aiGrades) store.database.deleteRecord('ai_runs', row.id);
    recordMaintenance(store, {
      kind: 'reset',
      summary: `${plan.preview.title}：${selection.mode === 'complete' ? '清空学习记录' : '重置学习进度'}`,
      count: plan.preview.counts.results,
    });
    return { ok: true as const, ...plan.preview };
  });
}
