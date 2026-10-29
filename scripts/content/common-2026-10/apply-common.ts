/** Scoped, explicit approval: new common packs plus the preceding foundation batch. */
import { existsSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Store, nextStamp } from '../../../server/core/store.js';
import { recordTables } from '../../../server/database/schema.js';
import { DatabaseConnection } from '../../../server/database/connection.js';
import type { Question } from '../../../shared/models/types.js';
import { questionSchema } from '../../../server/core/validation.js';
import { validateAssetReferences } from '../../../server/modules/assets/service.js';
import { importData } from '../../../server/modules/transfer/migration.js';
import { validatePack, validatePackSet, assertImportCompatible } from '../manage.js';
import { FOUNDATION_PACK_NAMES } from '../../qa/audit-foundations.js';

export const COMMON_PACK_NAMES = ['computer-common-202610', 'english-common-202610', 'japanese-common-202610', 'chinese-common-202610', 'driving-common-202610', 'geography-common-202610', 'physics-common-202610', 'chemistry-common-202610', 'medicine-common-202610', 'psychology-common-202610', 'economics-common-202610'];
const root = resolve(import.meta.dirname, '../../..');
type Pack = ReturnType<typeof validatePack>;
const protectedTables = recordTables.filter(table => !['questions', 'domains', 'categories', 'tags'].includes(table));
const protectedHashes = (store: Store) => Object.fromEntries(protectedTables.map(table => [table, createHash('sha256').update(JSON.stringify(store.database.records(table))).digest('hex')]));
const combine = (packs: Pack[]) => ({ schemaVersion: 1, ...Object.fromEntries(['domains', 'categories', 'tags', 'questions', 'documents', 'papers', 'assets', 'questionBanks'].map(key => [key, [...new Map(packs.flatMap(pack => (pack as any)[key] || []).map((row: any) => [row.id, row])).values()]])) });

export function planCommonApproval(store: Store, packs: Pack[], previousIds: string[]) {
  assertImportCompatible(store, packs);
  const incoming = new Map(packs.flatMap(pack => pack.questions).map(question => [question.id!, question]));
  const targets = [...new Set([...previousIds, ...incoming.keys()])];
  const counts = { add: 0, approve: 0, published: 0, targets: targets.length };
  for (const id of targets) {
    const current = store.get<Question>('questions', id), question = current || incoming.get(id);
    if (!question) throw new Error('Previous-batch question is missing; no deleted data is recreated: ' + id);
    questionSchema.parse(question);
    if (question.collection !== 'general' || question.status === 'archived') throw new Error('Target is archived or personal; review scope explicitly before approval: ' + id);
    if (!current) counts.add++;
    if (question.status === 'published') counts.published++;
    else counts.approve++;
  }
  return { targets, counts };
}

export function applyCommonApproval(store: Store, packs: Pack[], previousIds: string[]) {
  return store.transaction(() => {
    const plan = planCommonApproval(store, packs, previousIds), before = protectedHashes(store);
    const imported = packs.length ? importData(store, combine(packs)) : null;
    let approved = 0;
    for (const id of plan.targets) {
      const question = store.require<Question>('questions', id);
      questionSchema.parse(question); store.validateRefs(question); validateAssetReferences(store, question);
      if (question.status === 'published') continue;
      store.put('questions', id, { ...question, status: 'published', updatedAt: nextStamp(question.updatedAt) }); approved++;
    }
    if (JSON.stringify(before) !== JSON.stringify(protectedHashes(store))) throw new Error('Protected records changed; entire import and approval rolled back');
    return { imported, approved, alreadyPublished: plan.counts.published, targetIds: plan.targets, protectedRecordsUnchanged: true };
  });
}

export async function loadCommonPacks(names: readonly string[]) {
  if (names.some(name => !/^[a-z0-9-]+$/.test(name))) throw new Error('Invalid pack name');
  const packs = await Promise.all(names.map(async name => validatePack(JSON.parse(await readFile(join(root, 'data/content-packs', name + '.json'), 'utf8')))));
  validatePackSet(packs); return packs;
}
async function main() {
  const args = process.argv.slice(2), value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  const databaseArg = value('--database'); if (!databaseArg) throw new Error('Specify existing --database. Dry-run is default; --apply backs up before writing.');
  const database = resolve(databaseArg); if (!existsSync(database)) throw new Error('Database not found');
  const names = value('--packs')?.split(',') || COMMON_PACK_NAMES;
  const previousNames = value('--previous-packs')?.split(',') || [...FOUNDATION_PACK_NAMES];
  const packs = await loadCommonPacks(names), previous = await loadCommonPacks(previousNames);
  const previousIds = previous.flatMap(pack => pack.questions.map(question => question.id!));
  const store = new Store(database);
  try {
    const plan = planCommonApproval(store, packs, previousIds);
    const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), mode: args.includes('--apply') ? 'apply' : 'dry-run', database, packs: names, previousPacks: previousNames, counts: plan.counts, targetIds: plan.targets };
    if (args.includes('--apply')) {
      const directory = join(dirname(database), 'backups'); await mkdir(directory, { recursive: true });
      const backup = join(directory, `before-common-approval-${Date.now()}.sqlite`); await store.database.backupTo(backup);
      const copy = new DatabaseConnection(backup, false);
      try { for (const table of ['questions', 'papers'] as const) if (copy.all(copy.query.selectFrom(table).select('id')).length !== store.database.all(store.database.query.selectFrom(table).select('id')).length) throw new Error('Backup count mismatch: ' + table); } finally { copy.close(); }
      report.backup = backup; Object.assign(report, applyCommonApproval(store, packs, previousIds));
    }
    const output = resolve(value('--report') || join(root, 'test-results/common-content-applied.json'));
    await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    const { targetIds: _ids, imported: _imported, ...summary } = report; console.log(JSON.stringify(summary, null, 2));
  } finally { store.db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error); process.exitCode = 1; });
