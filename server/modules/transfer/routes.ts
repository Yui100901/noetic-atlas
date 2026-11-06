import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from '../../core/store.js';
import { parse } from '../../core/validation.js';
import { importData, exportData } from './migration.js';
import { migrationSelectionSchema, migrationDatabaseQuerySchema, sqliteMigrationPlan, exportSQLiteMigration } from './sqlite-migration.js';
import { readOnlyOperation } from '../../http/operation.js';

export function registerTransferRoutes(app: FastifyInstance, store: Store) {
  app.post('/api/migrations/preview', readOnlyOperation, async request => sqliteMigrationPlan(store, parse(migrationSelectionSchema, request.body)).preview);
  app.get('/api/migrations/database', async (request, reply) => {
    const query = parse(migrationDatabaseQuerySchema, request.query);
    const exported = await exportSQLiteMigration(store, { domainIds: query.domainIds }, query.fingerprint);
    return reply.type('application/vnd.sqlite3').header('Content-Disposition', `attachment; filename="noetic-atlas-${exported.preview.scope}-migration.sqlite"`).header('Content-Length', exported.bytes.byteLength).send(exported.bytes);
  });
  app.get('/api/export', async (_request, reply) => reply.header('Content-Disposition', 'attachment; filename="learning-backup.json"').send(exportData(store)));
  app.post('/api/import', async request => { const body = parse(z.object({ data: z.unknown(), mode: z.literal('merge') }).strict(), request.body); return importData(store, body.data); });
  // Existing clients use the same validated, redacted and compacted snapshot.
  app.get('/api/backup.sqlite', async (_request, reply) => {
    const selection = {domainIds:[]};
    const plan = sqliteMigrationPlan(store, selection);
    const result = await exportSQLiteMigration(store, selection, plan.preview.fingerprint);
    return reply.type('application/vnd.sqlite3').header('Content-Disposition', 'attachment; filename="learning.sqlite"').header('Content-Length', result.bytes.byteLength).send(result.bytes);
  });
}
