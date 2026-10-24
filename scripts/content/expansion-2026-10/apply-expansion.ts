/** Explicit offline maintenance. Dry-run by default; no native-driver access. */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Store, type Table } from '../../../server/core/store.js';
import { questionSchema, vocabularySchema } from '../../../server/core/validation.js';
import type { Question, VocabularyData } from '../../../shared/models/types.js';
import { vocabularyPromptIsSafe } from '../../../shared/questions/vocabulary.js';
import { importData } from '../../../server/modules/transfer/migration.js';
import { validatePack, assertImportCompatible } from '../manage.js';

interface Supplement { format: 'noetic-atlas-vocabulary-supplement'; schemaVersion: 1; questions: Array<{ id: string; vocabulary: VocabularyData; sourceRefsAdded: Question['sourceRefs'] }> }
const canonical = (value: any): string => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}' : JSON.stringify(value);
const sha = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const protectedTables: Table[] = ['study', 'study_parts', 'attempts', 'question_history', 'learning_results', 'reviews', 'settings', 'paper_drafts', 'papers', 'documents', 'assets'];
const protectedHashes = (store: Store) => Object.fromEntries(protectedTables.map(table => [table, sha(store.all<any>(table).sort((a, b) => String(a.id || `${a.questionId}/${a.partId || ''}`).localeCompare(String(b.id || `${b.questionId}/${b.partId || ''}`))))]));

export function planVocabularySupplement(store: Store, raw: Supplement) {
  if (raw.format !== 'noetic-atlas-vocabulary-supplement' || raw.schemaVersion !== 1 || !Array.isArray(raw.questions)) throw new Error('Invalid vocabulary supplement');
  const ids = new Set<string>(), updates: Question[] = [];
  let unchanged = 0;
  for (const row of raw.questions) {
    if (ids.has(row.id)) throw new Error('Duplicate supplement ID: ' + row.id);
    ids.add(row.id);
    const current = store.require<Question>('questions', row.id), vocabulary = vocabularySchema.parse(row.vocabulary);
    const prefix = vocabulary.language === 'en' ? 'EN-V-' : 'JA-V-';
    const titleHeadword = vocabulary.language === 'ja' ? current.title.replace(/｜日语单词$/, '') : current.title;
    if (!row.id.startsWith(prefix) || current.type !== 'short_answer' || titleHeadword.normalize('NFKC') !== vocabulary.headword.normalize('NFKC')) throw new Error('Vocabulary identity mismatch: ' + row.id);
    if (!vocabularyPromptIsSafe(vocabulary)) throw new Error('Unsafe reverse prompt: ' + row.id);
    if (current.vocabulary && sha(current.vocabulary) !== sha(vocabulary)) throw new Error('Existing vocabulary differs; review manually: ' + row.id);
    const sourceRefs = [...current.sourceRefs];
    for (const ref of row.sourceRefsAdded || []) if (!sourceRefs.some(existing => existing.label === ref.label && existing.url === ref.url)) sourceRefs.push(ref);
    const next = { ...current, vocabulary, sourceRefs };
    // Parse for validation, but preserve every original field verbatim.
    questionSchema.parse(next);
    if (sha(current) === sha(next)) unchanged++;
    else updates.push(next);
  }
  return { updates, unchanged, total: ids.size };
}

export function applyExpansion(store: Store, packs: ReturnType<typeof validatePack>[], supplement: Supplement) {
  const merged: Record<string, any> = { schemaVersion: 1 };
  for (const key of ['domains', 'categories', 'tags', 'questions', 'documents', 'papers', 'assets', 'questionBanks'] as const) merged[key] = [...new Map(packs.flatMap(pack => pack[key] || []).map((row: any) => [row.id, row])).values()];
  return store.transaction(() => {
    // Re-read after taking the transaction snapshot: a preflight or backup may
    // have run while the application was still accepting user edits.
    assertImportCompatible(store, packs);
    const plan = planVocabularySupplement(store, supplement);
    const before = protectedHashes(store);
    // The regular migration service validates taxonomy, answers and references.
    const imported = packs.length ? importData(store, merged) : null;
    for (const row of plan.updates) store.put('questions', row.id!, row);
    if (sha(before) !== sha(protectedHashes(store))) throw new Error('Protected learning/configuration records changed; transaction rolled back');
    return { imported, vocabularyUpdated: plan.updates.length, vocabularyUnchanged: plan.unchanged, protectedRecordsUnchanged: true };
  });
}

async function main() {
  const args = process.argv.slice(2), value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  const root = resolve(import.meta.dirname, '../../..'), databaseArg = value('--database');
  if (!databaseArg) throw new Error('Specify an existing --database. Default is dry-run; --apply writes after a verified backup.');
  const database = resolve(databaseArg);
  if (!existsSync(database)) throw new Error('Database does not exist');
  const names = (value('--packs') || '').split(',').filter(Boolean);
  if (names.some(name => !/^[a-z0-9-]+$/.test(name))) throw new Error('Invalid pack name');
  const packs = await Promise.all(names.map(async name => validatePack(JSON.parse(await readFile(join(root, 'data/content-packs', name + '.json'), 'utf8')))));
  const supplement = JSON.parse(await readFile(resolve(value('--patch') || join(root, '.localtools/vocabulary-enrichment.json')), 'utf8')) as Supplement;
  const store = new Store(database);
  try {
    assertImportCompatible(store, packs);
    const plan = planVocabularySupplement(store, supplement);
    const report: Record<string, unknown> = { generatedAt: new Date().toISOString(), database, mode: args.includes('--apply') ? 'apply' : 'dry-run', packs: names, newQuestions: packs.reduce((sum, pack) => sum + pack.questions.filter(q => !store.get('questions', q.id!)).length, 0), vocabularyUpdated: plan.updates.length, vocabularyUnchanged: plan.unchanged, supplementSha256: sha(supplement) };
    if (args.includes('--apply')) {
      const directory = join(dirname(database), 'backups'); await mkdir(directory, { recursive: true });
      const backup = join(directory, `before-expansion-202610-${Date.now()}.sqlite`);
      await store.database.backupTo(backup);
      // Verify the online backup through the repository adapter before writing.
      const copy = new Store(backup);
      try { if (copy.database.one(copy.database.query.selectFrom('questions').select(eb => eb.fn.countAll<number>().as('total')))?.total !== store.database.one(store.database.query.selectFrom('questions').select(eb => eb.fn.countAll<number>().as('total')))?.total) throw new Error('Backup question count mismatch'); } finally { copy.db.close(); }
      report.backup = backup;
      Object.assign(report, applyExpansion(store, packs, supplement));
    }
    const output = resolve(value('--report') || join(root, 'test-results/content-expansion-applied.json'));
    await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } finally { store.db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error); process.exitCode = 1; });
