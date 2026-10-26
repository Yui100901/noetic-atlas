import type { FastifyInstance } from 'fastify';
import type { Store } from '../../core/store.js';
import { getId } from '../../http/request.js';
import { fail, parse } from '../../core/validation.js';
import type { StoredAttempt } from '../practice/service.js';
import { getSettings } from '../settings/service.js';
import { attemptRatingSchema, cardQuerySchema, changeCardSchema, manualReviewSchema, queueQuerySchema } from './schema.js';
import { attemptReviewOverview, changeReviewCard, recordManualReview, reviewCardView, reviewQueue, syncAttemptReviewEvents } from './service.js';

export function registerReviewSchedulerRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/review-scheduler/card', async request => reviewCardView(store, parse(cardQuerySchema, request.query)));
  app.post('/api/review-scheduler/review', async request => recordManualReview(store, parse(manualReviewSchema, request.body)));
  app.patch('/api/review-scheduler/card', async request => changeReviewCard(store, parse(changeCardSchema, request.body)));
  app.get('/api/review-scheduler/queue', async request => reviewQueue(store, parse(queueQuerySchema, request.query)));
  app.get('/api/review-scheduler/attempts/:id', async request => attemptReviewOverview(store, store.require<StoredAttempt>('attempts', getId(request))));
  app.post('/api/review-scheduler/attempts/:id/rating', async request => {
    const attempt = store.require<StoredAttempt>('attempts', getId(request)), input = parse(attemptRatingSchema, request.body);
    if (getSettings(store).reviewScheduling.strategy !== 'fsrs') fail(409, 'REVIEW_FIXED_MODE', '请先在系统配置开启自适应复习');
    if (!attempt.questions.some(question => question.id === input.leafId)) fail(400, 'REVIEW_LEAF_INVALID', '评级题号不属于本次作答');
    store.transaction(() => syncAttemptReviewEvents(store, attempt, { [input.leafId]: input.rating }, [input.leafId]));
    return attemptReviewOverview(store, attempt);
  });
}
