/** Explicitly change the user's system default without recalculating any paper. */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseConnection } from '../../server/database/connection.js';
import { Store, nextStamp } from '../../server/core/store.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';
import { settingsSchema } from '../../server/modules/settings/service.js';

export function setMultipleChoiceDefault(store: Store) {
  return store.transaction(() => {
    const previous = store.get<any>('settings', 'system') || structuredClone(DEFAULT_SETTINGS);
    const before = previous.pointsByType.multiple_choice;
    if (before === 4) return { changed: false, before, after: 4 };
    const next = { ...previous, pointsByType: { ...previous.pointsByType, multiple_choice: 4 }, updatedAt: nextStamp(previous.updatedAt) };
    // Validate against current defaults, but keep all other stored fields exact.
    settingsSchema.parse({ ...structuredClone(DEFAULT_SETTINGS), ...next });
    store.put('settings', 'system', next);
    return { changed: true, before, after: 4 };
  });
}
async function main() {
  const args = process.argv.slice(2), value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  const input = value('--database'); if (!input || !existsSync(resolve(input))) throw new Error('Specify an existing --database. Default is dry-run; --apply backs up then writes.');
  const database = resolve(input), reader = new DatabaseConnection(database, false);
  const stored = reader.getRecord<any>('settings', 'system') || DEFAULT_SETTINGS;
  const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), database, mode: args.includes('--apply') ? 'apply' : 'dry-run', before: stored.pointsByType.multiple_choice, after: 4, changed: stored.pointsByType.multiple_choice !== 4 };
  try {
    if (args.includes('--apply') && report.changed) {
      const directory = join(dirname(database), 'backups'); await mkdir(directory, { recursive: true });
      const backup = join(directory, `before-daily-push-defaults-${Date.now()}.sqlite`); await reader.backupTo(backup);
      const copy = new DatabaseConnection(backup, false);
      try { if (JSON.stringify(copy.getRecord('settings', 'system')) !== JSON.stringify(reader.getRecord('settings', 'system'))) throw new Error('Backup settings mismatch'); } finally { copy.close(); }
      report.backup = backup;
    }
  } finally { reader.close(); }
  if (args.includes('--apply') && report.changed) {
    const store = new Store(database);
    try { Object.assign(report, setMultipleChoiceDefault(store)); } finally { store.db.close(); }
  }
  const output = resolve(value('--report') || join(import.meta.dirname, '../../test-results/daily-push-defaults-applied.json'));
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error); process.exitCode = 1; });
