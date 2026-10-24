import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from '../../core/store.js';
import { id, parse } from '../../core/validation.js';
import { checkDailyPush, dailyPushOverview, readDailyPush } from './service.js';

const empty = z.object({}).strict();
export function registerDailyPushRoutes(app: FastifyInstance, store: Store, options: { now?: () => Date } = {}) {
  const now = () => options.now?.() || new Date();
  app.get('/api/daily-push', async request => { parse(empty, request.query); return dailyPushOverview(store, now()); });
  app.post('/api/daily-push/check', async request => { parse(empty, request.body || {}); const result = checkDailyPush(store, now()); return { ...result, overview: dailyPushOverview(store, now()) }; });
  app.post('/api/daily-push/:id/read', async request => { parse(empty, request.body || {}); const params = parse(z.object({ id }).strict(), request.params); return readDailyPush(store, params.id, now()); });
}
