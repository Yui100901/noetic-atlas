import type {FastifyInstance} from 'fastify';
import type {Store} from '../../core/store.js';
import {parse} from '../../core/validation.js';
import {analyticsQuerySchema,weeklyQuerySchema} from './schema.js';
import {learningAnalytics,weeklyReport} from './service.js';
export function registerAnalyticsRoutes(app:FastifyInstance,store:Store) {
  app.get('/api/analytics',async request=>learningAnalytics(store,parse(analyticsQuerySchema,request.query)));
  app.get('/api/analytics/weekly',async request=>weeklyReport(store,parse(weeklyQuerySchema,request.query)));
}
