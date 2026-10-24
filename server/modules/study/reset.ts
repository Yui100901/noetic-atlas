import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { StudyState } from '../../../shared/models/types.js';
import type { Store } from '../../core/store.js';
import { fail, parse } from '../../core/validation.js';
import type { LearningResult } from '../practice/learning-results.js';

export const learningResetInputSchema = z.object({ confirmed: z.literal(true), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

function plan(store: Store) {
  const db = store.database, field = db.expressions.field.bind(db.expressions);
  const states = store.all<StudyState>('study'), partStates = store.all<StudyState>('study_parts');
  const reviews = db.all(db.query.selectFrom('reviews').select(['id', 'data']).orderBy('id'));
  const results = db.all(db.query.selectFrom('learning_results').select('id').select([field<string>('data', 'updatedAt').as('updatedAt'), field<string>('data', 'items').as('items'), field<number | null>('data', 'reset').as('reset')]).orderBy('id'));
  const attempts = db.all(db.query.selectFrom('attempts').select('id').select([
    field<string | null>('data', 'source').as('source'), field<string>('data', 'paperId').as('paperId'), field<string>('data', 'paperTitle').as('paperTitle'), field<number>('data', 'paperVersion').as('paperVersion'),
    field<'in_progress' | 'submitted'>('data', 'status').as('status'), field<string>('data', 'startedAt').as('startedAt'), field<string | null>('data', 'submittedAt').as('submittedAt'), field<string | null>('data', 'updatedAt').as('updatedAt'),
  ]).orderBy('id'));
  const questionHistory=db.all(db.query.selectFrom('question_history').select(['id','data']).orderBy('id'));
  const fingerprint = createHash('sha256').update(JSON.stringify({ states: states.sort((a, b) => a.questionId.localeCompare(b.questionId)), partStates: partStates.sort((a, b) => JSON.stringify([a.questionId, a.partId]).localeCompare(JSON.stringify([b.questionId, b.partId]))), reviews, results, attempts,questionHistory })).digest('hex');
  const preview = { fingerprint, counts: { states: states.length, partStates: partStates.length, reviews: reviews.length, results: results.filter(row => !row.reset).length }, retained: { attempts: attempts.filter(row => row.status === 'submitted').length, drafts: attempts.filter(row => row.status === 'in_progress').length } };
  return { states, partStates, attempts, questionHistory, preview };
}

export function learningResetPreview(store: Store) { return plan(store).preview; }

/** Reset progress explicitly; pruning history is never a reset. Tombstones for
 * retained submissions prevent old snapshots from silently reseeding progress. */
export function resetLearningProgress(store: Store, fingerprint: string) {
  return store.transaction(() => {
    const current = plan(store);
    if (current.preview.fingerprint !== fingerprint) fail(409, 'LEARNING_RESET_PREVIEW_STALE', '预览后学习记录已变化，请重新预览后确认');
    for (const state of [...current.states, ...current.partStates]) store.putStudy({ ...state, mastery: null, lastReviewedAt: null, nextReviewAt: null, wrongCount: 0 });
    store.database.run(store.database.query.deleteFrom('reviews'));
    store.database.run(store.database.query.deleteFrom('learning_results'));
    for(const row of current.questionHistory)store.put('question_history',row.id,{...JSON.parse(row.data),beforeReset:true});
    for (const row of current.attempts) if (row.status === 'submitted') {
      const marker: LearningResult = { id: row.id, historyIndexed:true, source: row.source === 'quick' ? 'quick' : 'paper', paperId: row.paperId, paperTitle: row.paperTitle, paperVersion: row.paperVersion, status: 'submitted', startedAt: row.startedAt, submittedAt: row.submittedAt!, updatedAt: row.updatedAt || row.submittedAt || row.startedAt, reset: true, items: [], questions: [] };
      store.put('learning_results', marker.id, marker);
    }
    return { ok: true as const, ...current.preview };
  });
}

export function registerLearningResetRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/learning/reset-preview', async request => { parse(z.object({}).strict(), request.query); return learningResetPreview(store); });
  app.post('/api/learning/reset', async request => { const body = parse(learningResetInputSchema, request.body); return resetLearningProgress(store, body.fingerprint); });
}
