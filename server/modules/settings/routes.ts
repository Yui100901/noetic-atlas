import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from '../../core/store.js';
import { parse } from '../../core/validation.js';
import { getSettings, settingsSchema, saveSettings } from './service.js';
import { registerConfigurationRoutes } from './configuration.js';

export { settingsSchema, getSettings, ensureSettings, applyAttemptRetention } from './service.js';

export function registerSettingsRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/settings', async () => getSettings(store));
  app.put('/api/settings', async request => {
    const retentionSchema = z.object({ drafts: z.number().int().nonnegative(), history: z.number().int().nonnegative(), total: z.number().int().nonnegative(), authoring: z.number().int().nonnegative().optional() }).strict();
    const input = parse(z.object({ settings: settingsSchema, confirmedRetention: z.literal(true).optional(), expectedRetention: retentionSchema.optional() }).strict(), request.body);
    return store.transaction(() => saveSettings(store, input.settings, input));
  });
  registerConfigurationRoutes(app, store);
}
