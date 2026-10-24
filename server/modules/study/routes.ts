import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Store, makeId, now } from '../../core/store.js';
import { parse, id, studySchema, reviewSchema, fail } from '../../core/validation.js';
import { validateAssetReferences } from '../assets/routes.js';
import { getSettings } from '../settings/routes.js';
import { paginationFields, paginate } from '../../core/pagination.js';
import { getId } from '../../http/request.js';
import { requireStudyPart } from './state.js';

export function registerStudyRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/study', async () => ({ items: store.all('study'), partItems: store.all('study_parts'), reviews: store.all('reviews') }));
  app.get('/api/reviews', async request => { const query = parse(z.object({ ...paginationFields, questionId: id.optional(), partId: id.optional(), whole: z.enum(['true','false']).optional() }).strict(), request.query); return paginate(query, store.all<any>('reviews').filter(r => (!query.questionId || r.questionId === query.questionId) && (!query.partId || r.partId === query.partId) && (query.whole !== 'true' || r.partId === undefined)).sort((a,b) => b.reviewedAt.localeCompare(a.reviewedAt))); });
  app.put('/api/study/:id', async request => {
    const qid = getId(request), update = parse(studySchema, request.body);
    if (!requireStudyPart(store, qid, update.partId)) fail(404, 'STUDY_PART_NOT_FOUND', '原题中的小题已删除或改变，无法保存学习记录');
    if (update.partId !== undefined && update.favorite !== undefined) fail(400, 'FAVORITE_WHOLE_QUESTION', '收藏属于整道原题，请在整题记录中操作');
    const state = { ...store.study(qid, update.partId), ...update }; validateAssetReferences(store, state, getSettings(store)); store.putStudy(state); return state;
  });
  app.post('/api/study/:id/review', async request => {
    const qid = getId(request); const { mastery, partId } = parse(reviewSchema, request.body);
    if (!requireStudyPart(store, qid, partId)) fail(404, 'STUDY_PART_NOT_FOUND', '原题中的小题已删除或改变，无法保存学习记录');
    const state = { ...store.study(qid, partId), mastery, lastReviewedAt: now(), nextReviewAt: new Date(Date.now() + getSettings(store).reviewIntervalsDays[mastery]! * 86400000).toISOString() };
    store.transaction(() => { store.putStudy(state); const rid = makeId('review'); store.put('reviews', rid, { id: rid, questionId: qid, ...(partId === undefined ? {} : { partId }), mastery, reviewedAt: now(), source: 'manual' }); }); return state;
  });
}
