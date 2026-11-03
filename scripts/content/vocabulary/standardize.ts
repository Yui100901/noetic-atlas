/** Offline, deterministic vocabulary maintenance. Plan first; apply requires a
 * consistent backup, a disposable preflight and one optimistic transaction.
 * Meanings, examples, grading standards and existing learning snapshots are not
 * regenerated. Ambiguous hints are evidence for review, never proof of aliases. */
import { createHash } from 'node:crypto';
import { existsSync, statfsSync } from 'node:fs';
import { copyFile, mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseConnection } from '../../../server/database/connection.js';
import { recordTables, type RecordTable } from '../../../server/database/schema.js';
import { nextStamp } from '../../../server/core/store.js';
import { questionSchema } from '../../../server/core/validation.js';
import type { Question, VocabularyData } from '../../../shared/models/types.js';
import {
  normalizeVocabularyData,
  vocabularyIssues,
  vocabularyPromptIsSafe,
} from '../../../shared/questions/vocabulary.js';

export const VOCABULARY_STANDARDIZATION_VERSION = '2026-11-03.1';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const count = (counts: Record<string, number>, key: string) => {
  counts[key] = (counts[key] || 0) + 1;
};
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function* rows(db: DatabaseConnection, table: RecordTable) {
  let cursor: string | undefined;
  while (true) {
    let query = db.query
      .selectFrom(table)
      .select(['id', 'data'])
      .orderBy('id')
      .limit(table === 'assets' ? 1 : 200);
    if (cursor !== undefined) query = query.where('id', '>', cursor);
    const page = db.all(query);
    if (!page.length) return;
    for (const row of page) {
      cursor = row.id;
      yield row;
    }
  }
}
export function tableDigest(db: DatabaseConnection, table: RecordTable) {
  const hash = createHash('sha256');
  for (const row of rows(db, table)) hash.update(JSON.stringify([row.id, row.data]));
  return hash.digest('hex');
}
/** Excluding exactly the two fields this maintenance task is allowed to edit. */
export function protectedQuestionDigest(question: Question) {
  const { vocabulary: _vocabulary, updatedAt: _updatedAt, ...protectedFields } = question;
  return sha(JSON.stringify(protectedFields));
}

export interface PartOfSpeechEvidence {
  field: 'answerMarkdown' | 'explanationMarkdown';
  value: string;
}
/** Copy explicit source labels only. The WordNet sense identifier is metadata,
 * not part of the lexical class. No part of speech is inferred from a gloss. */
export function extractPartOfSpeech(question: Question) {
  const sources: PartOfSpeechEvidence[] = [];
  for (const field of ['answerMarkdown', 'explanationMarkdown'] as const) {
    const pattern =
      /^\*\*词性\*\*[：:]([^\n]+)|^\*\*((?:noun|verb|adjective|adverb|satellite adjective|n\.|v\.|adj\.|adv\.)[^*\n]*?)(?:\s*·\s*\d{8}-[nvars])?\*\*\s*$/gm;
    for (const match of question[field].matchAll(pattern)) {
      const value = (match[1] || match[2] || '')
        .normalize('NFC')
        .trim()
        .replace(/\s*·\s*\d{8}-[nvars]$/, '');
      if (value) sources.push({ field, value });
    }
  }
  const value = [...new Set(sources.map((source) => source.value))].join('；');
  return { value: value.length <= 100 ? value : '', sources };
}

export function standardizeVocabulary(question: Question) {
  if (!question.vocabulary) return null;
  const before = question.vocabulary;
  let vocabulary: VocabularyData = {
    ...normalizeVocabularyData(before),
    reverseEnabled: before.reverseEnabled !== false,
    caseSensitive: before.caseSensitive === true,
    trim: before.trim !== false,
  };
  const provenance = !vocabulary.partOfSpeech?.trim() ? extractPartOfSpeech(question) : null;
  if (provenance?.value) vocabulary = { ...vocabulary, partOfSpeech: provenance.value };
  let promptRepair: 'removed_literal_label_prefix' | 'disabled_unsafe_hint' | null = null;
  if (vocabulary.reverseEnabled && !vocabularyPromptIsSafe(vocabulary)) {
    // Only remove an exact headword + label delimiter. Rewriting a meaning or
    // deleting arbitrary answer substrings can change its semantics.
    const candidate = {
      ...vocabulary,
      meaningPrompt: vocabulary.meaningPrompt.replace(
        new RegExp(`^${escape(vocabulary.headword)}\\s*[：:]\\s*`),
        '',
      ),
    };
    if (candidate.meaningPrompt !== vocabulary.meaningPrompt && vocabularyPromptIsSafe(candidate)) {
      vocabulary = candidate;
      promptRepair = 'removed_literal_label_prefix';
    } else {
      vocabulary = { ...vocabulary, reverseEnabled: false };
      promptRepair = 'disabled_unsafe_hint';
    }
  }
  const issues = vocabularyIssues(vocabulary);
  return {
    vocabulary,
    changed: !same(before, vocabulary),
    changedFields: [...new Set([...Object.keys(before), ...Object.keys(vocabulary)])].filter(
      (key) => !same(before[key as keyof VocabularyData], vocabulary[key as keyof VocabularyData]),
    ),
    provenance,
    promptRepair,
    issues,
  };
}

export function planVocabularyStandardization(db: DatabaseConnection) {
  const changes: Array<{
    id: string;
    title: string;
    expectedHash: string;
    protectedHash: string;
    vocabulary: VocabularyData;
    changedFields: string[];
    partOfSpeechEvidence?: PartOfSpeechEvidence[];
  }> = [];
  const counts = {
    questions: 0,
    vocabularyCards: 0,
    changedCards: 0,
    unchangedCards: 0,
    enabledReverse: 0,
    disabledReverse: 0,
    copiedPartOfSpeech: 0,
    byLanguage: {} as Record<string, number>,
    byStatus: {} as Record<string, number>,
    byField: {} as Record<string, number>,
    byIssue: {} as Record<string, number>,
  };
  const manualReview: Array<{ id: string; title: string; reason: string }> = [];
  const blockers: Array<{ id: string; message: string }> = [];
  const hints = new Map<string, Array<{ id: string; headword: string }>>();
  const questionFingerprint = createHash('sha256');
  for (const row of rows(db, 'questions')) {
    questionFingerprint.update(JSON.stringify([row.id, row.data]));
    const question = JSON.parse(row.data) as Question;
    counts.questions++;
    const result = standardizeVocabulary(question);
    if (!result) continue;
    counts.vocabularyCards++;
    count(counts.byLanguage, result.vocabulary.language);
    count(counts.byStatus, question.status);
    result.vocabulary.reverseEnabled ? counts.enabledReverse++ : counts.disabledReverse++;
    for (const issue of result.issues) {
      count(counts.byIssue, issue.code);
      if (issue.severity === 'error') blockers.push({ id: question.id, message: issue.message });
    }
    if (result.promptRepair === 'disabled_unsafe_hint')
      manualReview.push({
        id: question.id,
        title: question.title,
        reason:
          '原逆向提示缺失、泄露答案或包含不允许的格式，已计划关闭逆向；请补充独立提示后再启用。',
      });
    if (result.vocabulary.reverseEnabled) {
      const key = JSON.stringify([
        result.vocabulary.language,
        result.vocabulary.meaningPrompt.normalize('NFC').trim(),
      ]);
      const group = hints.get(key) || [];
      group.push({ id: question.id, headword: result.vocabulary.headword });
      hints.set(key, group);
    }
    if (!result.changed) {
      counts.unchangedCards++;
      continue;
    }
    const validation = questionSchema.safeParse({ ...question, vocabulary: result.vocabulary });
    if (!validation.success)
      blockers.push({
        id: question.id,
        message: validation.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
      });
    counts.changedCards++;
    for (const field of result.changedFields) count(counts.byField, field);
    if (result.provenance?.value) counts.copiedPartOfSpeech++;
    changes.push({
      id: row.id,
      title: question.title,
      expectedHash: sha(row.data),
      protectedHash: protectedQuestionDigest(question),
      vocabulary: result.vocabulary,
      changedFields: result.changedFields,
      ...(result.provenance?.value ? { partOfSpeechEvidence: result.provenance.sources } : {}),
    });
  }
  const ambiguousHints = [...hints]
    .filter(([, group]) => new Set(group.map((item) => item.headword)).size > 1)
    .map(([key, items]) => ({
      language: JSON.parse(key)[0] as string,
      meaningPrompt: JSON.parse(key)[1] as string,
      items,
    }));
  return {
    version: VOCABULARY_STANDARDIZATION_VERSION,
    questionFingerprint: questionFingerprint.digest('hex'),
    counts,
    changes,
    blockers,
    manualReview,
    ambiguousHints,
    ambiguousHintGroups: ambiguousHints.length,
    ambiguousHintCards: ambiguousHints.reduce((n, group) => n + group.items.length, 0),
  };
}
export type VocabularyStandardizationPlan = ReturnType<typeof planVocabularyStandardization>;

export function applyVocabularyStandardization(
  db: DatabaseConnection,
  plan: VocabularyStandardizationPlan,
) {
  if (plan.version !== VOCABULARY_STANDARDIZATION_VERSION)
    throw Error('Standardizer version changed; recreate the plan');
  if (plan.blockers.length) throw Error('Validation blockers; inspect plan before applying');
  return db.transaction(() => {
    if (tableDigest(db, 'questions') !== plan.questionFingerprint)
      throw Error('Question bank changed after planning; nothing was written');
    const protectedTables = recordTables.filter(
      (table) => table !== 'questions' && db.hasTable(table),
    );
    const before = new Map(protectedTables.map((table) => [table, tableDigest(db, table)]));
    for (const change of plan.changes) {
      const row = db.one(
        db.query.selectFrom('questions').select('data').where('id', '=', change.id),
      );
      if (!row || sha(row.data) !== change.expectedHash)
        throw Error(`Question changed after planning: ${change.id}`);
      const current = JSON.parse(row.data) as Question;
      if (protectedQuestionDigest(current) !== change.protectedHash)
        throw Error(`Protected source fields changed: ${change.id}`);
      const result = standardizeVocabulary(current);
      if (!result || !same(result.vocabulary, change.vocabulary))
        throw Error(`Plan vocabulary was altered: ${change.id}`);
      const next = {
        ...current,
        vocabulary: change.vocabulary,
        updatedAt: nextStamp(current.updatedAt),
      };
      questionSchema.parse(next);
      if (protectedQuestionDigest(next) !== change.protectedHash)
        throw Error(`Unrelated source fields changed: ${change.id}`);
      db.putRecord('questions', next.id, next);
      const stored = db.getRecord<Question>('questions', next.id)!;
      if (
        !same(stored.vocabulary, change.vocabulary) ||
        protectedQuestionDigest(stored) !== change.protectedHash
      )
        throw Error(`Stored vocabulary verification failed: ${change.id}`);
    }
    for (const table of protectedTables)
      if (tableDigest(db, table) !== before.get(table))
        throw Error(`Protected table changed: ${table}`);
    const remaining = planVocabularyStandardization(db);
    if (remaining.counts.changedCards || remaining.blockers.length)
      throw Error('Standardization failed its idempotence/validation gate');
    return {
      changedCards: plan.changes.length,
      remainingChanges: remaining.counts.changedCards,
      protectedQuestionContentPreserved: true,
      protectedTableFingerprints: Object.fromEntries(before),
      ambiguousHintGroups: remaining.ambiguousHintGroups,
      ambiguousHintCards: remaining.ambiguousHintCards,
    };
  });
}

function summary(plan: VocabularyStandardizationPlan) {
  return {
    version: plan.version,
    questionFingerprint: plan.questionFingerprint,
    ...plan.counts,
    blockers: plan.blockers,
    manualReview: plan.manualReview,
    ambiguousHintGroups: plan.ambiguousHintGroups,
    ambiguousHintCards: plan.ambiguousHintCards,
  };
}
export async function main(args = process.argv.slice(2)) {
  const root = resolve(import.meta.dirname, '../../..');
  let database = join(root, 'data/noetic-atlas.sqlite'),
    folder = join(root, 'test-results/content/vocabulary-standardization'),
    apply = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--database' || args[i] === '--report-folder') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw Error('Expected path');
      if (args[i - 1] === '--database') database = resolve(value);
      else folder = resolve(value);
    } else if (args[i] === '--apply') apply = true;
    else if (args[i] !== '--plan') throw Error(`Unknown argument: ${args[i]}`);
  }
  if (!existsSync(database)) throw Error('An existing database is required');
  await mkdir(folder, { recursive: true });
  const db = new DatabaseConnection(database, false);
  try {
    const plan = planVocabularyStandardization(db);
    await writeFile(
      join(folder, 'plan.json'),
      JSON.stringify({ ...summary(plan), changes: plan.changes }, null, 2) + '\n',
    );
    await writeFile(
      join(folder, 'ambiguous-hints.json'),
      JSON.stringify(
        {
          policy:
            '完全同提示是歧义线索，不足以证明同义词可互换；保留各卡答案，不自动合并、扩大答案或关闭逆向。',
          groups: plan.ambiguousHints,
        },
        null,
        2,
      ) + '\n',
    );
    if (plan.blockers.length && apply) throw Error('Validation blockers; nothing was written');
    let backup: string | null = null,
      preflight,
      result;
    if (apply && plan.changes.length) {
      const space = statfsSync(dirname(database));
      if (space.bavail * space.bsize < db.storageHealth().databaseBytes * 3 + 256 * 1024 * 1024)
        throw Error('Insufficient free space for backup, preflight and rollback journal');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      backup = join(
        dirname(database),
        'backups',
        `before-vocabulary-standardization-${stamp}.sqlite`,
      );
      await mkdir(dirname(backup), { recursive: true });
      if (existsSync(backup)) throw Error('Backup already exists');
      await db.backupTo(backup);
      const previewPath = join(folder, `preflight-${stamp}.sqlite`);
      await copyFile(backup, previewPath);
      const preview = new DatabaseConnection(previewPath, false);
      try {
        preflight = applyVocabularyStandardization(preview, plan);
      } finally {
        preview.close();
      }
      // This is the exact disposable file created above, never a directory.
      await unlink(previewPath);
      result = applyVocabularyStandardization(db, plan);
      // Derived projections are rebuildable. Warm them after the protected
      // transaction so the next library search does not pay a 20k-row rebuild.
      db.projections.ensure(['questions']);
      db.projections.search.ensure();
    }
    const independentDb = new DatabaseConnection(database, false);
    let independent;
    try {
      independent = summary(planVocabularyStandardization(independentDb));
    } finally {
      independentDb.close();
    }
    const report = {
      at: new Date().toISOString(),
      mode: apply ? 'apply' : 'plan',
      database,
      backup,
      plan: summary(plan),
      preflight,
      result,
      independentVerification: independent,
      policy:
        '仅规范化结构化词卡字段和原题更新时间；词性逐字取自明确原文。不生成新释义、读音、近义答案或评分标准。审核状态、其他题目字段、题集快照、历史、学习数据和设置均保留。',
    };
    await writeFile(join(folder, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    db.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
