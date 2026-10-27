/** Scoped content maintenance. New questions stay pending; existing question
 * identity, publication, answers, snapshots and learning records are preserved. */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Store, nextStamp } from '../../server/core/store.js';
import { DatabaseConnection } from '../../server/database/connection.js';
import { recordTables, type RecordTable } from '../../server/database/schema.js';
import { conceptSchema, id, questionSchema } from '../../server/core/validation.js';
import { importData } from '../../server/modules/transfer/migration.js';
import { buildPaper, type StoredPaper } from '../../server/modules/practice/service.js';
import type { Question, Category, Domain } from '../../shared/models/types.js';
import { validatePack, assertImportCompatible } from './manage.js';
const root = resolve(import.meta.dirname, '../..');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
export const conceptSourceFingerprint = (q: Question) => hash([q.id, q.title, q.type, q.stemMarkdown, q.answerMarkdown, q.explanationMarkdown]);
const supplementSchema = z.object({ format: z.literal('noetic-atlas-concept-supplement'), schemaVersion: z.literal(1), generatedAt: z.string(), questions: z.array(z.object({ id, concept: conceptSchema, sourceFingerprint: z.string().length(64) })) });
type Pack = ReturnType<typeof validatePack>;
type Supplement = z.infer<typeof supplementSchema>;
function recordHash(store: Store, table: RecordTable) {
    const digest = createHash('sha256');
    let cursor: string | undefined;
    while (true) {
        let query = store.database.query.selectFrom(table).select(['id', 'data']).orderBy('id').limit(table === 'assets' ? 1 : 200);
        if (cursor !== undefined)
            query = query.where('id', '>', cursor);
        const rows = store.database.all(query);
        if (!rows.length)
            break;
        for (const row of rows) {
            digest.update(JSON.stringify([row.id, row.data]));
            cursor = row.id;
        }
    }
    return digest.digest('hex');
}
const mergedPacks = (packs: Pack[]) => ({ schemaVersion: 1, ...Object.fromEntries(['domains', 'categories', 'tags', 'questions', 'documents', 'papers', 'assets', 'questionBanks'].map(key => [key, [...new Map(packs.flatMap(pack => (pack as any)[key] || []).map((row: any) => [row.id, row])).values()]])) });
export function applyKnowledgeExpansion(store: Store, packs: Pack[], supplement: Supplement, createSets = false) {
    const rows = supplementSchema.parse(supplement).questions;
    if (new Set(rows.map(row => row.id)).size !== rows.length)
        throw new Error('Duplicate concept supplement ID');
    return store.transaction(() => {
        assertImportCompatible(store, packs);
        const updates: Question[] = [];
        for (const row of rows) {
            const current = store.require<Question>('questions', row.id);
            if (current.type !== 'short_answer' || current.vocabulary || conceptSourceFingerprint(current) !== row.sourceFingerprint)
                throw new Error('Concept source changed: ' + row.id);
            if (current.concept && hash(current.concept) !== hash(row.concept))
                throw new Error('Existing concept differs: ' + row.id);
            const next = { ...current, concept: row.concept };
            questionSchema.parse(next);
            if (hash(current) !== hash(next))
                updates.push(next);
        }
        const protectedTables = recordTables.filter(table => !['questions', 'categories', 'domains', 'tags', 'papers'].includes(table));
        const before = Object.fromEntries(protectedTables.map(table => [table, recordHash(store, table)]));
        const oldPapers = new Map(store.database.all(store.database.query.selectFrom('papers').select(['id', 'data'])).map(row => [row.id, hash(row.data)]));
        const imported = importData(store, mergedPacks(packs));
        for (const q of updates)
            store.put('questions', q.id, { ...q, updatedAt: nextStamp(q.updatedAt) });
        const createdSets: string[] = [];
        if (createSets) {
            const categories = new Map(store.all<Category>('categories').map(c => [c.id, c.domainId]));
            const eligible = store.all<Question>('questions').filter(q => q.status === 'published' && q.collection === 'general' && q.type === 'short_answer' && q.concept);
            const sets = store.all<StoredPaper>('papers');
            for (const domain of store.all<Domain>('domains')) {
                const prefix = `concept-cards-202610-${domain.id}-`;
                const previous = sets.filter(paper => paper.id.startsWith(prefix) && paper.practiceKind === 'concept' && paper.domainId === domain.id);
                const covered = new Set(previous.flatMap(paper => paper.questionIds));
                const selected = eligible.filter(q => !covered.has(q.id) && q.categoryIds.some(id => categories.get(id) === domain.id)).sort((a, b) => a.id.localeCompare(b.id));
                const nextIndex = 1 + Math.max(0, ...previous.map(paper => Number(paper.id.slice(prefix.length))).filter(Number.isSafeInteger));
                for (let start = 0; start < selected.length; start += 100) {
                    const batch = selected.slice(start, start + 100), index = nextIndex + Math.floor(start / 100), paperId = prefix + index;
                    if (store.get('papers', paperId))
                        throw new Error('Concept set ID already belongs to another set: ' + paperId);
                    const paper = buildPaper(store, { id: paperId, title: `${domain.name}概念卡 ${index}（${batch.length}题）`, description: '选择概念→含义或描述→概念，巩固本领域的基础术语。', mode: 'manual', questionIds: batch.map(q => q.id), practiceKind: 'concept', organization: 'domain', domainId: domain.id, scoring: { enabled: false } });
                    store.insert('papers', paper.id, paper as StoredPaper);
                    createdSets.push(paper.id);
                }
            }
        }
        const changedProtected = protectedTables.filter(table => recordHash(store, table) !== before[table]);
        if (changedProtected.length)
            throw new Error('Protected records changed: ' + changedProtected.join(','));
        for (const [id, digest] of oldPapers) {
            const row = store.database.one(store.database.query.selectFrom('papers').select('data').where('id', '=', id));
            if (!row || hash(row.data) !== digest)
                throw new Error('Existing question set changed: ' + id);
        }
        return { imported, conceptMetadataUpdated: updates.length, conceptMetadataUnchanged: rows.length - updates.length, createdSets, protectedRecordsUnchanged: true, oldSetsUnchanged: true };
    });
}
async function planPackConceptSync(supplement: Supplement) {
    const concepts = new Map(supplement.questions.map(row => [row.id, row]));
    const packDirectory = join(root, 'data/content-packs');
    const paths = (await readdir(packDirectory)).filter(file => file.endsWith('.json'))
        .map(file => ({ path: join(packDirectory, file), manifest: join(root, 'data/content-sources', file), seed: false }));
    const seedPath = join(root, 'data/seed.json');
    if (existsSync(seedPath)) paths.push({ path: seedPath, manifest: join(root, 'data/content-sources/seed-concept-enrichment.json'), seed: true });
    const changes: Array<{ path: string; output: string; manifest: string; manifestOutput: string; count: number }> = [];
    // Validate every file before changing any source artifact.
    for (const entry of paths) {
        const raw = await readFile(entry.path, 'utf8');
        const pack = JSON.parse(raw);
        let count = 0;
        for (const question of pack.questions || []) {
            const row = concepts.get(question.id);
            if (!row) continue;
            if (conceptSourceFingerprint(question) !== row.sourceFingerprint) throw new Error('Pack source changed: ' + question.id);
            if (hash(question.concept) === hash(row.concept)) continue;
            if (question.concept) throw new Error('Existing pack concept differs: ' + question.id);
            question.concept = row.concept;
            questionSchema.parse(question);
            count++;
        }
        if (!count) continue;
        if (!entry.seed) validatePack(pack);
        const output = JSON.stringify(pack, null, 2) + '\n';
        const manifest = existsSync(entry.manifest) ? JSON.parse(await readFile(entry.manifest, 'utf8')) : {};
        manifest.conceptEnrichment = {
            at: new Date().toISOString(), questions: count,
            previousFileSha256: createHash('sha256').update(raw).digest('hex'),
            fileSha256: createHash('sha256').update(output).digest('hex'),
            policy: 'Only adds independently checked concept metadata; original source attribution and review policy retained.',
        };
        changes.push({ path: entry.path, output, manifest: entry.manifest, manifestOutput: JSON.stringify(manifest, null, 2) + '\n', count });
    }
    return changes;
}

async function main() {
    const args = process.argv.slice(2);
    const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
    const databaseArg = value('--database'), supplementArg = value('--supplement');
    const names = value('--packs')?.split(',').filter(Boolean) || [];
    if (!databaseArg || !supplementArg || !names.length) throw new Error('Specify --database, --supplement and --packs. Dry-run is default; --apply takes an independent backup.');
    if (names.some(name => !/^[a-z0-9-]+$/.test(name))) throw new Error('Invalid pack name');
    const database = resolve(databaseArg);
    if (!existsSync(database)) throw new Error('Database does not exist');
    const output = resolve(value('--report') || 'test-results/knowledge-expansion/report.json');
    await mkdir(dirname(output), { recursive: true });
    const packs = await Promise.all(names.map(async name => validatePack(JSON.parse(await readFile(join(root, 'data/content-packs', name + '.json'), 'utf8')))));
    const supplement = supplementSchema.parse(JSON.parse(await readFile(resolve(supplementArg), 'utf8')));
    const apply = args.includes('--apply');
    const backupDirectory = apply ? join(dirname(database), 'backups') : dirname(output);
    await mkdir(backupDirectory, { recursive: true });
    const copyPath = join(backupDirectory, `${apply ? 'before-knowledge-expansion' : 'preview-knowledge-expansion'}-${Date.now()}.sqlite`);
    const connection = new DatabaseConnection(database, false);
    try { await connection.backupTo(copyPath); } finally { connection.close(); }
    const packChanges = apply && args.includes('--sync-packs') ? await planPackConceptSync(supplement) : [];
    let preflight: { database: string; temporary: boolean; conceptMetadataUpdated: number; createdSets: number } | undefined;
    if (apply) {
        const preflightPath = join(dirname(output), `isolated-preflight-${Date.now()}.sqlite`);
        await copyFile(copyPath, preflightPath);
        const preview = new Store(preflightPath);
        try {
            const checked = applyKnowledgeExpansion(preview, packs, supplement, args.includes('--create-concept-sets'));
            preflight = { database: preflightPath, temporary: true, conceptMetadataUpdated: checked.conceptMetadataUpdated, createdSets: checked.createdSets.length };
        } finally { preview.db.close(); }
        await unlink(preflightPath);
    }
    const store = new Store(apply ? database : copyPath);
    try {
        const result = applyKnowledgeExpansion(store, packs, supplement, args.includes('--create-concept-sets'));
        const report = { at: new Date().toISOString(), mode: apply ? 'apply' : 'dry-run', packs: names, backup: apply ? copyPath : undefined, preview: apply ? undefined : { database: copyPath, temporary: true }, preflight, ...result,
            packSync: { status: packChanges.length ? 'pending' : 'not_needed', files: packChanges.length, updated: packChanges.reduce((sum, change) => sum + change.count, 0) } };
        // Persist the successful primary-data outcome before optional artifact IO.
        // A source-file failure must never hide an already committed database.
        await writeFile(output, JSON.stringify(report, null, 2) + '\n');
        try {
            for (const change of packChanges) {
                await writeFile(change.path, change.output);
                await writeFile(change.manifest, change.manifestOutput);
            }
            if (packChanges.length) report.packSync.status = 'completed';
        } catch (error) {
            report.packSync.status = 'failed';
            await writeFile(output, JSON.stringify(report, null, 2) + '\n');
            throw error;
        }
        await writeFile(output, JSON.stringify(report, null, 2) + '\n');
        console.log(JSON.stringify({ ...report, createdSets: report.createdSets.length }, null, 2));
    } finally { store.db.close(); if (!apply) await unlink(copyPath); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
    main().catch(error => { console.error(error); process.exitCode = 1; });
