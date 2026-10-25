import type { FastifyInstance } from 'fastify';
import type { Store } from '../../core/store.js';
import { parse } from '../../core/validation.js';
import { searchQuerySchema } from './schema.js';
import { unifiedSearch } from './service.js';

export function registerSearchRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/search', async request => unifiedSearch(store, parse(searchQuerySchema, request.query)));
}
