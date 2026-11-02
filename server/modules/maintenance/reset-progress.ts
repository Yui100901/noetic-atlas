import type { Store } from '../../core/store.js';
import { now, nextStamp } from '../../core/store.js';
import type { StudyState } from '../../../shared/models/types.js';
import type { FocusSession } from '../../../shared/models/focus-review.js';
import type { LearningResult } from '../practice/learning-results.js';
import type { StoredAttempt } from '../practice/service.js';
import { freezePracticeTiming } from '../practice/practice-timing.js';
import { focusSummary } from '../focus-review/service.js';

/** Tombstones retain provenance, including two-way directions, without loading
 * or copying any old question/answer/scoring snapshots. */
export function markResultReset(store: Store, id: string) {
  const db = store.database,
    x = db.expressions;
  const existing = db.one(
    db.query
      .selectFrom('learning_results')
      .select(x.jsonWithout('data', ['items', 'questions']).as('data'))
      .where('id', '=', id),
  );
  if (existing) {
    store.put('learning_results', id, {
      ...JSON.parse(existing.data),
      reset: true,
      historyIndexed: true,
      items: [],
      questions: [],
    });
    return;
  }
  const row = db.one(
    db.query
      .selectFrom('attempts')
      .select(x.jsonWithout('data', ['questions', 'answers', 'scoring']).as('data'))
      .where('id', '=', id),
  );
  if (!row) return;
  const a = JSON.parse(row.data) as StoredAttempt;
  if (a.status !== 'submitted') return;
  const marker: LearningResult = {
    id: a.id,
    source: a.source === 'quick' ? 'quick' : 'paper',
    paperId: a.paperId,
    paperTitle: a.paperTitle,
    paperVersion: a.paperVersion,
    status: 'submitted',
    startedAt: a.startedAt,
    submittedAt: a.submittedAt!,
    updatedAt: a.updatedAt || a.submittedAt!,
    reset: true,
    historyIndexed: true,
    items: [],
    questions: [],
    ...(a.practiceKind ? { practiceKind: a.practiceKind } : {}),
    ...(a.vocabularyDirection ? { vocabularyDirection: a.vocabularyDirection } : {}),
    ...(a.elapsedSeconds === undefined ? {} : { elapsedSeconds: a.elapsedSeconds }),
  };
  store.put('learning_results', id, marker);
}

export function resetAllProgress(store: Store) {
  const db = store.database;
  for (const table of ['study', 'study_parts'] as const)
    for (const row of db.all(db.query.selectFrom(table).select('id'))) {
      const state = store.require<StudyState>(table, row.id);
      store.putStudy({
        ...state,
        mastery: null,
        lastReviewedAt: null,
        nextReviewAt: null,
        wrongCount: 0,
      });
    }
  for (const row of db.all(
    db.query
      .selectFrom('focus_sessions')
      .select('id')
      .where(db.expressions.field('data', 'status'), '=', 'in_progress'),
  )) {
    const session = store.require<FocusSession>('focus_sessions', row.id);
    session.status = 'submitted';
    session.submittedAt = now();
    session.reset = true;
    session.revision++;
    session.updatedAt = nextStamp(session.updatedAt);
    freezePracticeTiming(session);
    session.summary = focusSummary(session);
    store.put('focus_sessions', session.id, session);
  }
  for (const table of [
    'learning_task_results',
    'reviews',
    'review_cards',
    'review_events',
    'learning_results',
  ] as const)
    db.run(db.query.deleteFrom(table));
  for (const row of db.all(db.query.selectFrom('question_history').select('id')))
    store.put('question_history', row.id, {
      ...store.require<any>('question_history', row.id),
      beforeReset: true,
    });
  for (const row of db.all(
    db.query
      .selectFrom('attempts')
      .select('id')
      .where(db.expressions.field('data', 'status'), '=', 'submitted'),
  ))
    markResultReset(store, row.id);
}
