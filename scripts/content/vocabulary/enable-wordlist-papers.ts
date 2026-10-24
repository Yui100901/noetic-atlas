/** Explicit maintenance for generated wordlists; private databases stay local. */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Store, nextStamp } from '../../../server/core/store.js';
import { DatabaseConnection } from '../../../server/database/connection.js';
import type { StoredPaper } from '../../../server/modules/practice/service.js';
import { resolveVocabularyQuestion } from '../../../server/modules/practice/vocabulary-practice.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function planGeneratedWordlistKinds(store: Store) {
  const ids = store.database.all(store.database.query.selectFrom('papers').select('id').where('id', 'like', 'wordlist-%')).map(row => row.id);
  const updates: Array<{ before: StoredPaper; after: StoredPaper }> = [], skipped: Array<{ id: string; reason: string }> = [];
  let unchanged = 0;
  for (const id of ids) {
    if (!/^wordlist-(english|japanese)-\d{3}$/.test(id)) continue;
    const paper = store.require<StoredPaper>('papers', id);
    if (paper.practiceKind === 'vocabulary') { unchanged++; continue; }
    try {
      if (!paper.snapshot.length || paper.snapshot.length !== paper.questionIds.length || paper.snapshot.some((q, index) => q.id !== paper.questionIds[index])) throw new Error('Wordlist snapshot does not match question IDs');
      const prefix = id.startsWith('wordlist-english-') ? 'EN-V-' : 'JA-V-';
      for (const question of paper.snapshot) {
        if (!question.id.startsWith(prefix)) throw new Error('Contains a non-vocabulary question');
        resolveVocabularyQuestion(store, question);
      }
      updates.push({ before: paper, after: { ...paper, practiceKind: 'vocabulary', version: paper.version + 1, updatedAt: nextStamp(paper.updatedAt) } });
    } catch (error) { skipped.push({ id, reason: (error as Error).message }); }
  }
  return { updates, unchanged, skipped };
}
export function enableGeneratedWordlistKinds(store: Store) {
  return store.transaction(() => {
    const plan = planGeneratedWordlistKinds(store);
    for (const { before, after } of plan.updates) {
      // Only the opt-in setting and its version stamp may change.
      const strip = ({ practiceKind: _kind, version: _version, updatedAt: _updated, ...value }: StoredPaper) => value;
      if (hash(strip(before)) !== hash(strip(after))) throw new Error('Unexpected wordlist content change');
      store.put('papers', after.id, after);
    }
    return { updated: plan.updates.length, unchanged: plan.unchanged, skipped: plan.skipped };
  });
}
async function main() {
  const args = process.argv.slice(2), get = (key: string) => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
  const path = get('--database'); if (!path) throw new Error('Specify --database; dry-run is default, --apply writes after backup');
  const database = resolve(path); if (!existsSync(database)) throw new Error('Database does not exist');
  const store = new Store(database);
  try {
    const plan = planGeneratedWordlistKinds(store);
    const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), mode: args.includes('--apply') ? 'apply' : 'dry-run', database, updated: plan.updates.length, unchanged: plan.unchanged, skipped: plan.skipped };
    if (args.includes('--apply') && plan.updates.length) {
      const directory = join(dirname(database), 'backups'); await mkdir(directory, { recursive: true });
      const backup = join(directory, `before-wordlist-kinds-${Date.now()}.sqlite`);
      await store.database.backupTo(backup);
      const copy = new DatabaseConnection(backup, false);
      try { if (copy.all(copy.query.selectFrom('papers').select('id')).length !== store.database.all(store.database.query.selectFrom('papers').select('id')).length) throw new Error('Backup paper count mismatch'); } finally { copy.close(); }
      report.backup = backup;
      Object.assign(report, enableGeneratedWordlistKinds(store));
    }
    const output = resolve(get('--report') || join(import.meta.dirname, '../../../test-results/wordlist-kinds-applied.json'));
    await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } finally { store.db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error); process.exitCode = 1; });
