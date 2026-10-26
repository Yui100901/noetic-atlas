/** Explicit local test-data cleanup. Without --apply this only reports counts.
 * Uses the database query adapter; content/configuration are hash-checked and
 * a complete private SQLite backup is made before deleting learning records. */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { DatabaseConnection } from '../../dist/server/database/connection.js';
import { recordTables } from '../../dist/server/database/schema.js';

const targetTables = ['study', 'study_parts', 'attempts', 'learning_results', 'question_history', 'reviews', 'review_cards', 'review_events', 'ai_runs'];
const databasePath = resolve('data/noetic-atlas.sqlite');
const apply = process.argv.includes('--apply');
if (process.argv.slice(2).some(argument => argument !== '--apply')) throw new Error('Only --apply is supported; run from the project directory.');
if (!existsSync(databasePath)) throw new Error('The initialized project database does not exist.');
const db = new DatabaseConnection(databasePath, false);
try {
  const targets = targetTables.filter(table => db.hasTable(table));
  const counts = Object.fromEntries(targets.map(table => [table, Number(db.one(db.query.selectFrom(table).select(eb => eb.fn.countAll().as('count'))).count)]));
  const report = { at: new Date().toISOString(), applied: apply, before: counts };
  if (apply) {
    const preserved = recordTables.filter(table => !targets.includes(table) && db.hasTable(table));
    const fingerprint = table => {
      const hash = createHash('sha256'); let cursor, count = 0;
      while (true) {
        let query = db.query.selectFrom(table).select(['id', 'data']).orderBy('id').limit(table === 'assets' ? 1 : 500);
        if (cursor !== undefined) query = query.where('id', '>', cursor);
        const rows = db.all(query); if (!rows.length) break;
        for (const row of rows) { hash.update(JSON.stringify([row.id, row.data])); cursor = row.id; count++; }
      }
      return { count, hash: hash.digest('hex') };
    };
    const before = Object.fromEntries(preserved.map(table => [table, fingerprint(table)]));
    const backupPath = join(dirname(databasePath), 'backups', `before-learning-reset-${Date.now()}.sqlite`);
    await mkdir(dirname(backupPath), { recursive: true }); await db.backupTo(backupPath);
    db.transaction(() => { for (const table of targets) db.run(db.query.deleteFrom(table)); });
    db.projections.refreshAll();
    const after = Object.fromEntries(preserved.map(table => [table, fingerprint(table)]));
    report.backupPath = backupPath; report.preserved = after;
    report.changedPreservedTables = preserved.filter(table => JSON.stringify(before[table]) !== JSON.stringify(after[table]));
    report.after = Object.fromEntries(targets.map(table => [table, Number(db.one(db.query.selectFrom(table).select(eb => eb.fn.countAll().as('count'))).count)]));
    if (report.changedPreservedTables.length || Object.values(report.after).some(count => count !== 0)) throw new Error('Cleanup verification failed; use the complete backup.');
  }
  await mkdir(resolve('test-results'), { recursive: true });
  await writeFile(resolve(`test-results/${apply ? 'clear-learning-state' : 'clear-learning-preview'}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ applied: report.applied, before: report.before, after: report.after, backupPath: report.backupPath, changedPreservedTables: report.changedPreservedTables }));
} finally { db.close(); }
