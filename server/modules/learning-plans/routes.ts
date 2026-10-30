import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from '../../core/store.js';
import { paginationFields } from '../../core/pagination.js';
import { parse } from '../../core/validation.js';
import { getId } from '../../http/request.js';
import type { LearningDay } from '../../../shared/models/learning-plan.js';
import { learningDayView } from './progress.js';
import { startLearningDay } from './start.js';
import { planStartSchema } from './schema.js';

export function registerLearningPlanRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/learning-plans', async (request) => {
    const input = parse(
        z
          .object({
            page: paginationFields.page.default(1),
            pageSize: paginationFields.pageSize.default(10),
          })
          .strict(),
        request.query,
      ),
      db = store.database,
      x = db.expressions;
    const total = Number(
      db.one(
        db.query.selectFrom('learning_days').select((eb) => eb.fn.countAll<number>().as('total')),
      )?.total || 0,
    );
    const items = db
      .all(
        db.query
          .selectFrom('learning_days')
          .select('data')
          .orderBy(x.field('data', 'dateKey'), 'desc')
          .limit(input.pageSize)
          .offset((input.page - 1) * input.pageSize),
      )
      .map((row) => {
        const {
          tasks: _tasks,
          taskProgress: _progress,
          ...view
        } = learningDayView(store, JSON.parse(row.data));
        return view;
      });
    return { items, total, ...input };
  });
  app.get('/api/learning-plans/:id', async (request) =>
    learningDayView(store, store.require<LearningDay>('learning_days', getId(request))),
  );
  app.post('/api/learning-plans/:id/start', async (request, reply) =>
    reply
      .code(201)
      .send(
        startLearningDay(
          store,
          store.require<LearningDay>('learning_days', getId(request)),
          parse(planStartSchema, request.body || {}),
        ),
      ),
  );
  app.post('/api/learning-plans/:id/read', async (request) => {
    const day = store.require<LearningDay>('learning_days', getId(request));
    if (!day.readAt) {
      day.readAt = new Date().toISOString();
      store.put('learning_days', day.id, day);
    }
    return { readAt: day.readAt };
  });
}
