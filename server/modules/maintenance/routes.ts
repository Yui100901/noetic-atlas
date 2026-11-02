import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from '../../core/store.js';
import { parse } from '../../core/validation.js';
import { readOnlyOperation } from '../../http/operation.js';
import { cleanupPlan, cleanupSelectionSchema, executeCleanup } from './cleanup.js';
import { dataHealth } from './health.js';
import { recordMaintenance } from './journal.js';
import { resetPlan, resetSelectionSchema } from './reset-plan.js';
import { executeReset } from './reset.js';

export const maintenanceConfirmationSchema = z.object({ confirmed: z.literal(true) }).strict();
export const cleanupInputSchema = z
  .object({
    selection: cleanupSelectionSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    confirmed: z.literal(true),
  })
  .strict();
export const resetInputSchema = z
  .object({
    selection: resetSelectionSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    confirmed: z.literal(true),
  })
  .strict();

export function registerMaintenanceRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/maintenance/health', async (request) => {
    const input = parse(
      z.object({ integrity: z.enum(['true', 'false']).default('false') }).strict(),
      request.query,
    );
    return dataHealth(store, input.integrity === 'true');
  });
  app.post(
    '/api/maintenance/cleanup-preview',
    readOnlyOperation,
    async (request) => cleanupPlan(store, parse(cleanupSelectionSchema, request.body)).preview,
  );
  app.post('/api/maintenance/cleanup', async (request) => {
    const input = parse(cleanupInputSchema, request.body);
    return executeCleanup(store, input.selection, input.fingerprint);
  });
  app.post(
    '/api/maintenance/reset-preview',
    readOnlyOperation,
    async (request) => resetPlan(store, parse(resetSelectionSchema, request.body)).preview,
  );
  app.post('/api/maintenance/reset', async (request) => {
    const input = parse(resetInputSchema, request.body);
    return executeReset(store, input.selection, input.fingerprint);
  });
  for (const action of ['compact', 'reindex'] as const)
    app.post(`/api/maintenance/${action}`, async (request) => {
      parse(maintenanceConfirmationSchema, request.body);
      const before = store.database.storageHealth();
      if (action === 'compact') store.database.compact();
      else store.database.projections.rebuild();
      recordMaintenance(store, {
        kind: action,
        summary: action === 'compact' ? '整理数据库空闲页' : '重建搜索与引用索引',
        count: 0,
      });
      return { ok: true, before, after: store.database.storageHealth() };
    });
}
