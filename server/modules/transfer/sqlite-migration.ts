import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { Store } from '../../core/store.js';
import { fail, id } from '../../core/validation.js';
import { recordTables } from '../../database/schema.js';
import { redactAiSecretsInDatabase } from '../ai/routes.js';
import { cleanStoredLearningMetadata } from '../questions/learning-metadata.js';
import { exportData, importData } from './migration.js';
import { sqliteMigrationPlan } from './sqlite-migration-plan.js';
import { validateSQLitePrivateRecords } from './sqlite-validation.js';

const domains = z
  .array(id)
  .max(500)
  .refine((ids) => new Set(ids).size === ids.length, '领域不能重复');
export const migrationSelectionSchema = z.object({ domainIds: domains.default([]) }).strict();
export const migrationDatabaseQuerySchema = z
  .object({
    domainIds: z
      .string()
      .max(100000)
      .optional()
      .transform((value, context) => {
        if (!value) return [];
        try {
          return domains.parse(JSON.parse(value));
        } catch {
          context.addIssue({ code: 'custom', message: '领域须为JSON领域ID数组' });
          return z.NEVER;
        }
      }),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const migrationPreviewSchema = z
  .object({
    scope: z.enum(['all', 'domains']),
    domainIds: domains,
    fingerprint: z.string(),
    counts: z.record(z.string(), z.number().int().nonnegative()),
    seedQuestions: z.number().int().nonnegative(),
    dependencyQuestions: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
  })
  .strict();
export { sqliteMigrationPlan } from './sqlite-migration-plan.js';

/** Always prune an independent SQLite copy. Original records, credentials,
 * projections and timers are never rewritten as part of preview/export. */
export async function exportSQLiteMigration(
  store: Store,
  selection: z.infer<typeof migrationSelectionSchema>,
  fingerprint: string,
) {
  const plan = sqliteMigrationPlan(store, selection);
  if (plan.preview.fingerprint !== fingerprint)
    fail(409, 'MIGRATION_PREVIEW_STALE', '迁移预览后数据已变化，请重新预览再导出');
  const dir = mkdtempSync(join(tmpdir(), 'atlas-migration-'));
  const path = join(dir, 'learning.sqlite');
  let copy: Store | undefined;
  try {
    await store.database.backupTo(path);
    // Awaited backup can yield to a concurrent write. Reject instead of
    // applying a graph computed from a different source revision.
    if (sqliteMigrationPlan(store, selection).preview.fingerprint !== fingerprint)
      fail(409, 'MIGRATION_PREVIEW_STALE', '生成迁移副本时数据发生变化，请重新预览再导出');
    copy = new Store(path);
    const db = copy.database;
    if (plan.preview.scope === 'domains') {
      db.transaction(() => {
        for (const table of recordTables) {
          const ids = [...plan.retained.get(table)!];
          let query = db.query.deleteFrom(table);
          if (ids.length) query = query.where((eb) => eb.not(db.expressions.idInJson('id', ids)));
          db.run(query);
        }
        const settings = copy!.get<any>('settings', 'system');
        if (settings?.dailyPush)
          copy!.put('settings', 'system', {
            ...settings,
            dailyPush: { ...settings.dailyPush, enabled: false },
          });
      });
    }
    cleanStoredLearningMetadata(db);
    // Rebuild derived text/hash/reference indexes from retained owners only.
    // VACUUM below removes discarded content and credentials from free pages.
    db.transaction(() => {
      for (const table of [
        'question_import_index',
        'question_import_terms',
        'question_import_pending',
        'quality_fingerprints',
        'search_read_model',
        'search_projection_pending',
        'projection_pending',
        'startup_validation_pending',
      ] as const)
        db.run(db.query.deleteFrom(table));
      db.run(
        db.query
          .deleteFrom('metadata')
          .where('key', 'in', [
            'read_projection_version',
            'search_projection_version',
            'question_import_version',
            'startup_validation_version',
          ]),
      );
    });
    db.pdf.rebuild();
    db.projections.rebuild();
    db.imports.initialize();
    db.imports.ensure();
    db.startupValidation.initialize();
    const checker = new Store(':memory:');
    try {
      importData(checker, exportData(copy));
      validateSQLitePrivateRecords(copy);
    } finally {
      checker.database.close();
    }
    // Redaction includes the final VACUUM, so discarded domain data and old
    // credential pages are removed in one compact pass after index rebuilding.
    redactAiSecretsInDatabase(db);
    // Native adapters store virtual files; re-backup persists copy mutations in
    // both implementations rather than assuming disk files update themselves.
    const output = join(dir, 'portable.sqlite');
    await db.backupTo(output);
    return { bytes: readFileSync(output), preview: plan.preview };
  } finally {
    copy?.database.close();
    const root = resolve(tmpdir()),
      target = resolve(dir);
    if (dirname(target) !== root || !basename(target).startsWith('atlas-migration-'))
      throw new Error('迁移临时目录未通过路径检查');
    rmSync(target, { recursive: true, force: true });
  }
}
