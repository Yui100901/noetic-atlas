import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from '../../core/store.js';
import { parse } from '../../core/validation.js';
import type { ScopedResetPreview } from '../../../shared/models/maintenance.js';
import { resetPlan } from '../maintenance/reset-plan.js';
import { executeReset } from '../maintenance/reset.js';

export const learningResetInputSchema = z.object({ confirmed: z.literal(true), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

/** Preserve the public global-reset response while all entry points use the
 * same provenance-aware maintenance transaction and metadata-only preview. */
function legacyPreview(value: ScopedResetPreview) {
  const {states,partStates,reviews,results,reviewCards,reviewEvents}=value.counts;
  const {attempts,drafts}=value.retained;
  return {fingerprint:value.fingerprint,counts:{states,partStates,reviews,results,reviewCards,reviewEvents},retained:{attempts,drafts}};
}
export function learningResetPreview(store: Store) {
  return legacyPreview(resetPlan(store,{scope:'all',mode:'progress'}).preview);
}
export function resetLearningProgress(store: Store, fingerprint: string) {
  return {ok:true as const,...legacyPreview(executeReset(store,{scope:'all',mode:'progress'},fingerprint))};
}
export function registerLearningResetRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/learning/reset-preview', async request => { parse(z.object({}).strict(), request.query); return learningResetPreview(store); });
  app.post('/api/learning/reset', async request => { const body = parse(learningResetInputSchema, request.body); return resetLearningProgress(store, body.fingerprint); });
}
