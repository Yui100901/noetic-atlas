import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Store, makeId, now } from '../../core/store.js';
import { parse, id, studySchema, reviewSchema } from '../../core/validation.js';
import { validateAssetReferences } from '../assets/routes.js';
import { getSettings } from '../settings/routes.js';
import { paginationFields, paginate } from '../../core/pagination.js';
import { getId } from '../../http/request.js';

export function registerStudyRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/study', async () => ({ items: store.all('study'), reviews: store.all('reviews') }));
  app.get('/api/reviews', async request => { const query = parse(z.object({ ...paginationFields, questionId: id.optional() }).strict(), request.query); return paginate(query, store.all<any>('reviews').filter(r => !query.questionId || r.questionId === query.questionId).sort((a,b) => b.reviewedAt.localeCompare(a.reviewedAt))); });
  app.put('/api/study/:id', async request => {
    const qid = getId(request); store.require('questions', qid); const update = parse(studySchema, request.body); const state = { ...store.study(qid), ...update }; validateAssetReferences(store, state, getSettings(store)); store.put('study', qid, state); return state;
  });
  app.post('/api/study/:id/review', async request => {
    const qid = getId(request); store.require('questions', qid); const { mastery } = parse(reviewSchema, request.body);
    const state = { ...store.study(qid), mastery, lastReviewedAt: now(), nextReviewAt: new Date(Date.now() + getSettings(store).reviewIntervalsDays[mastery]! * 86400000).toISOString() };
    store.transaction(() => { store.put('study', qid, state); const rid = makeId('review'); store.put('reviews', rid, { id: rid, questionId: qid, mastery, reviewedAt: now(), source: 'manual' }); }); return state;
  });
}
