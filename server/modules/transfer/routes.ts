import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from '../../core/store.js';
import { fail, parse } from '../../core/validation.js';
import { importData, exportData } from './migration.js';
import { migrationSelectionSchema, migrationDatabaseQuerySchema, sqliteMigrationPlan, exportSQLiteMigration } from './sqlite-migration.js';
import { readOnlyOperation } from '../../http/operation.js';
import { buildDataPackage, SQLITE_PACKAGE_LIMITS } from '../../../shared/packages/data-package.js';

export function registerTransferRoutes(app: FastifyInstance, store: Store) {
  app.post('/api/migrations/preview', readOnlyOperation, async request => sqliteMigrationPlan(store, parse(migrationSelectionSchema, request.body)).preview);
  app.get('/api/migrations/database', async (request, reply) => {
    const query = parse(migrationDatabaseQuerySchema, request.query);
    const exported = await exportSQLiteMigration(store, { domainIds: query.domainIds }, query.fingerprint);
    if (query.format === 'zip') {
      if (exported.bytes.byteLength > SQLITE_PACKAGE_LIMITS.maxFileBytes)
        fail(422, 'MIGRATION_PACKAGE_LIMIT', '数据库超过迁移包容量上限，请选 SQLite 数据库格式或缩小领域范围。');
      const bytes = await buildDataPackage({
        kind: 'sqlite-backup',
        title: '认知星图数据迁移',
        payloads: [],
        files: [
          { path: 'database/migration.sqlite', bytes: exported.bytes, mediaType: 'application/vnd.sqlite3' },
          { path: 'metadata/migration.json', bytes: new TextEncoder().encode(JSON.stringify(exported.preview)), mediaType: 'application/json' },
        ],
        limits: SQLITE_PACKAGE_LIMITS,
      });
      return reply.type('application/zip').header('Content-Disposition', `attachment; filename="noetic-atlas-${exported.preview.scope}-migration.zip"`).header('Content-Length', bytes.byteLength).send(bytes);
    }
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
