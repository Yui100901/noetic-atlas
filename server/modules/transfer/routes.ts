import type { FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import type { Store } from '../../core/store.js';
import { DatabaseConnection } from '../../database/connection.js';
import { parse } from '../../core/validation.js';
import { importData, exportData } from './migration.js';
import { redactAiSecretsInDatabase } from '../ai/routes.js';
import { cleanStoredLearningMetadata } from '../questions/learning-metadata.js';

export function registerTransferRoutes(app: FastifyInstance, store: Store) {
  app.get('/api/export', async (_request, reply) => reply.header('Content-Disposition', 'attachment; filename="learning-backup.json"').send(exportData(store)));
  app.post('/api/import', async request => { const body = parse(z.object({ data: z.unknown(), mode: z.literal('merge') }).strict(), request.body); return importData(store, body.data); });
  app.get('/api/backup.sqlite', async (_request, reply) => {
    const dir = mkdtempSync(join(tmpdir(), 'learning-backup-')); const path = join(dir, 'learning.sqlite');
    try {
      await store.database.backupTo(path);
      const copy = new DatabaseConnection(path,false); const portablePath = join(dir, 'portable.sqlite');
      try { redactAiSecretsInDatabase(copy); cleanStoredLearningMetadata(copy); await copy.backupTo(portablePath); } finally { copy.close(); }
      return reply.type('application/vnd.sqlite3').header('Content-Disposition', 'attachment; filename="learning.sqlite"').send(readFileSync(portablePath));
    }
    finally {
      const temporaryRoot = resolve(tmpdir()); const backupDirectory = resolve(dir);
      if (dirname(backupDirectory) !== temporaryRoot || !basename(backupDirectory).startsWith('learning-backup-')) throw new Error('备份临时目录未通过路径检查');
      rmSync(backupDirectory, { recursive: true, force: true });
    }
  });
}
