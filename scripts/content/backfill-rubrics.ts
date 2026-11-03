import { inspectRubricFormat } from '../../shared/questions/rubric-format.js';
import { createHash } from 'node:crypto';
import { existsSync, statfsSync } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseConnection } from '../../server/database/connection.js';
import { recordTables, type RecordTable } from '../../server/database/schema.js';
import { z } from 'zod';
import { nextStamp } from '../../server/core/store.js';
import { questionSchema } from '../../server/core/validation.js';
import type { Category, Domain, Question } from '../../shared/models/types.js';
import { supplementQuestionRubrics, RUBRIC_GENERATOR_VERSION } from './grading-rubrics.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const increment = (counts: Record<string, number>, key: string, n = 1) => {
  counts[key] = (counts[key] || 0) + n;
};
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
export function recordTableDigest(db: DatabaseConnection, table: RecordTable) {
  const hash = createHash('sha256');
  for (const row of rows(db, table)) hash.update(JSON.stringify([row.id, row.data]));
  return hash.digest('hex');
}
export function questionContentDigest(question: Question) {
  const { gradingRequirements: _rubric, updatedAt: _updated, ...original } = question;
  if (original.parts)
    original.parts = original.parts.map(({ gradingRequirements: _partRubric, ...part }) => part);
  return sha(JSON.stringify(original));
}
export const rubricOwnershipSchema = z
  .object({
    format: z.literal('noetic-generated-rubrics'),
    version: z.literal(1),
    generatorVersion: z.string(),
    createdAt: z.string(),
    entries: z
      .array(
        z
          .object({
            id: z.string(),
            partId: z.string().optional(),
            gradingRequirementsSha256: z.string().regex(/^[a-f0-9]{64}$/),
            sourceContentHash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(100000),
  })
  .passthrough();
export type RubricOwnership = z.infer<typeof rubricOwnershipSchema>;
/** Refresh requires an explicit ownership manifest. A later human edit to either
 * the standard or original content is preserved, never silently overwritten. */
export function planRubricBackfill(db: DatabaseConnection, ownership?: RubricOwnership) {
  const owned = new Map(
    ownership?.entries.map((entry) => [JSON.stringify([entry.id, entry.partId || '']), entry]),
  );
  const ownershipSkipped: Array<{ id: string; partId?: string; reason: string }> = [];
  const domains = new Map(db.records<Domain>('domains').map((domain) => [domain.id, domain.name]));
  const categories = new Map(
    db.records<Category>('categories').map((category) => [category.id, category.domainId]),
  );
  const changes: { id: string; expectedHash: string; contentHash: string; question: Question }[] =
    [];
  const counts = {
    questions: 0,
    subjectiveItems: 0,
    alreadyPopulated: 0,
    generatedItems: 0,
    changedQuestions: 0,
    missingEvidence: 0,
    byProfile: {} as Record<string, number>,
    byDomain: {} as Record<string, number>,
    byStatus: {} as Record<string, number>,
  };
  const review: {
    id: string;
    partId?: string;
    title: string;
    profile: string;
    evidencePoints: number;
    boundaryPoints: number;
    characters: number;
    requiresManualReference: boolean;
  }[] = [];
  const generatedRubrics: RubricOwnership['entries'] = [];
  const formatIssues: Array<{
    id: string;
    partId?: string;
    issues: ReturnType<typeof inspectRubricFormat>;
  }> = [];
  let formatIssueCount = 0;
  const hash = createHash('sha256');
  const samples = new Map<
    string,
    { id: string; partId?: string; title: string; gradingRequirements: string }
  >();
  for (const row of rows(db, 'questions')) {
    hash.update(JSON.stringify([row.id, row.data]));
    const question = JSON.parse(row.data) as Question;
    counts.questions++;
    const subjects = question.type === 'group' ? question.parts || [] : [question];
    for (const subject of subjects)
      if (subject.type === 'short_answer' || subject.type === 'essay') {
        counts.subjectiveItems++;
        if (subject.gradingRequirements?.trim()) counts.alreadyPopulated++;
      }
    const names = [
      ...new Set(
        question.categoryIds
          .map((id) => domains.get(categories.get(id) || ''))
          .filter((name): name is string => !!name),
      ),
    ];
    let generationInput = question;
    if (ownership) {
      const clear = (
        subject: Question | NonNullable<Question['parts']>[number],
        partId?: string,
      ) => {
        const entry = owned.get(JSON.stringify([question.id, partId || '']));
        if (!entry) return subject;
        if (
          entry.sourceContentHash !== questionContentDigest(question) ||
          entry.gradingRequirementsSha256 !== sha(subject.gradingRequirements || '')
        ) {
          ownershipSkipped.push({
            id: question.id,
            ...(partId ? { partId } : {}),
            reason: 'Source or rubric changed after ownership capture',
          });
          return subject;
        }
        return { ...subject, gradingRequirements: undefined };
      };
      generationInput =
        question.type === 'group'
          ? {
              ...question,
              parts: question.parts?.map(
                (part) => clear(part, part.id) as NonNullable<Question['parts']>[number],
              ),
            }
          : (clear(question) as Question);
    }
    const result = supplementQuestionRubrics(generationInput, names);
    if (!result.generated.length) continue;
    // Validating the enriched object also catches unsupported fields or an
    // original structural defect before a single live row can be changed.
    questionSchema.parse(result.question);
    if (questionContentDigest(result.question) !== questionContentDigest(question))
      throw Error(`Unexpected source-content change: ${row.id}`);
    if (JSON.stringify(result.question) !== JSON.stringify(question))
      changes.push({
        id: row.id,
        expectedHash: sha(row.data),
        contentHash: questionContentDigest(question),
        question: result.question,
      });
    if (JSON.stringify(result.question) !== JSON.stringify(question)) counts.changedQuestions++;
    counts.generatedItems += result.generated.length;
    increment(counts.byStatus, question.status, result.generated.length);
    for (const name of names.length ? names : ['未分类'])
      increment(counts.byDomain, name, result.generated.length);
    for (const generated of result.generated) {
      const issues = inspectRubricFormat(generated.gradingRequirements);
      formatIssueCount += issues.length;
      if (issues.length && formatIssues.length < 100)
        formatIssues.push({
          id: question.id,
          ...(generated.partId ? { partId: generated.partId } : {}),
          issues,
        });
      generatedRubrics.push({
        id: question.id,
        ...(generated.partId ? { partId: generated.partId } : {}),
        gradingRequirementsSha256: sha(generated.gradingRequirements),
        sourceContentHash: questionContentDigest(question),
      });
      increment(counts.byProfile, generated.profile);
      if (generated.noEvidence) counts.missingEvidence++;
      const title = generated.partId
        ? question.parts!.find((part) => part.id === generated.partId)!.title
        : question.title;
      review.push({
        id: question.id,
        ...(generated.partId ? { partId: generated.partId } : {}),
        title,
        profile: generated.profile,
        evidencePoints: generated.evidencePoints,
        boundaryPoints: generated.boundaryPoints,
        characters: generated.gradingRequirements.length,
        requiresManualReference: generated.noEvidence,
      });
      const key = `${names.join('|')}|${generated.profile}`;
      if (!samples.has(key) && question.collection !== 'personal')
        samples.set(key, {
          id: question.id,
          ...(generated.partId ? { partId: generated.partId } : {}),
          title,
          gradingRequirements: generated.gradingRequirements,
        });
    }
  }
  return {
    version: RUBRIC_GENERATOR_VERSION,
    questionFingerprint: hash.digest('hex'),
    counts,
    changes,
    review,
    samples: [...samples.values()],
    ownershipSkipped,
    generatedRubrics,
    formatIssues,
    formatIssueCount,
  };
}
export type RubricBackfillPlan = ReturnType<typeof planRubricBackfill>;
export function applyRubricBackfill(db: DatabaseConnection, plan: RubricBackfillPlan) {
  if (plan.formatIssueCount)
    throw Error('Generated rubric format errors; inspect the plan before applying');
  const expectedRubrics = new Map(
    plan.generatedRubrics.map((entry) => [JSON.stringify([entry.id, entry.partId || '']), entry]),
  );
  if (plan.version !== RUBRIC_GENERATOR_VERSION)
    throw Error('Rubric generator version changed; create a new plan');
  return db.transaction(() => {
    // Compare the complete original table as well as each row. A question
    // added/edited by an open app while planning must not be silently missed.
    if (recordTableDigest(db, 'questions') !== plan.questionFingerprint)
      throw Error('Question bank changed after planning; nothing was written');
    const protectedTables = recordTables.filter((table) => table !== 'questions');
    const protectedBefore = new Map(
      protectedTables.map((table) => [table, recordTableDigest(db, table)]),
    );
    for (const change of plan.changes) {
      const row = db.one(
        db.query.selectFrom('questions').select('data').where('id', '=', change.id),
      );
      if (!row || sha(row.data) !== change.expectedHash)
        throw Error(`Question changed after planning: ${change.id}`);
      const current = JSON.parse(row.data) as Question;
      if (questionContentDigest(change.question) !== change.contentHash)
        throw Error(`Plan changes unrelated question content: ${change.id}`);
      for (const subject of change.question.type === 'group'
        ? change.question.parts || []
        : [change.question]) {
        const key = JSON.stringify([change.id, change.question.type === 'group' ? subject.id : '']);
        const expected = expectedRubrics.get(key);
        if (!expected) continue;
        if (inspectRubricFormat(subject.gradingRequirements || '').length)
          throw Error(`Generated rubric format errors: ${change.id}`);
        if (sha(subject.gradingRequirements || '') !== expected.gradingRequirementsSha256)
          throw Error(`Generated rubric changed after planning: ${change.id}`);
      }
      const next = { ...change.question, updatedAt: nextStamp(current.updatedAt) };
      questionSchema.parse(next);
      db.putRecord('questions', next.id, next);
      const stored = db.getRecord<Question>('questions', next.id)!;
      if (questionContentDigest(stored) !== change.contentHash)
        throw Error(`Protected question content changed: ${change.id}`);
    }
    for (const table of protectedTables)
      if (recordTableDigest(db, table) !== protectedBefore.get(table))
        throw Error(`Protected table changed: ${table}`);
    const after = planRubricBackfill(db);
    if (after.counts.generatedItems)
      throw Error('Backfill did not cover every previously blank subjective rubric');
    return {
      ...plan.counts,
      protectedTablesPreserved: true,
      questionContentPreserved: true,
      remainingMissingRubrics: after.counts.generatedItems,
      totalPopulatedRubrics: after.counts.alreadyPopulated,
    };
  });
}
function summary(plan: RubricBackfillPlan) {
  return {
    version: plan.version,
    questionFingerprint: plan.questionFingerprint,
    ...plan.counts,
    formatIssueCount: plan.formatIssueCount,
    formatIssues: plan.formatIssues,
    requiresManualReference: plan.review.filter((item) => item.requiresManualReference),
  };
}
export async function main(args = process.argv.slice(2)) {
  const root = resolve(import.meta.dirname, '../..');
  let refreshManifest: string | undefined;
  let database = join(root, 'data/noetic-atlas.sqlite'),
    folder = join(root, 'test-results/content/rubrics'),
    apply = false;
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option === '--refresh-manifest') {
      const value = args[++i];
      if (!value) throw Error('Missing refresh manifest');
      refreshManifest = resolve(value);
      continue;
    }
    if (option === '--database' || option === '--report-folder') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw Error(`${option} requires a path`);
      if (option === '--database') database = resolve(value);
      else folder = resolve(value);
    } else if (option === '--apply') apply = true;
    else if (option !== '--plan') throw Error(`Unknown option: ${option}`);
  }
  if (!existsSync(database)) throw Error('An existing database is required');
  await mkdir(folder, { recursive: true });
  const db = new DatabaseConnection(database, false);
  let backup: string | null = null,
    preflight: ReturnType<typeof applyRubricBackfill> | undefined,
    result: ReturnType<typeof applyRubricBackfill> | undefined;
  try {
    const ownership = refreshManifest
      ? rubricOwnershipSchema.parse(JSON.parse(await readFile(refreshManifest, 'utf8')))
      : undefined;
    const plan = planRubricBackfill(db, ownership);
    await writeFile(
      join(folder, 'plan.json'),
      JSON.stringify(
        { mode: 'plan', ...summary(plan), review: plan.review, samples: plan.samples },
        null,
        2,
      ) + '\n',
    );
    if (apply && plan.formatIssueCount)
      throw Error('Generated rubric format errors; see plan.json. Nothing was written');
    if (apply && plan.changes.length) {
      const space = statfsSync(dirname(database)),
        available = space.bavail * space.bsize;
      const storage = db.storageHealth();
      if (available < storage.databaseBytes * 3 + 256 * 1024 * 1024)
        throw Error(
          'Insufficient free space for a consistent backup, preflight and rollback journal',
        );
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      backup = join(dirname(database), 'backups', `before-subjective-rubrics-${stamp}.sqlite`);
      await mkdir(dirname(backup), { recursive: true });
      if (existsSync(backup)) throw Error('Backup path already exists');
      await db.backupTo(backup);
      const previewPath = join(folder, `preflight-${stamp}.sqlite`);
      await copyFile(backup, previewPath);
      const preview = new DatabaseConnection(previewPath, false);
      try {
        preflight = applyRubricBackfill(preview, plan);
      } finally {
        preview.close();
      }
      // Delete only the exact disposable file created above; never directories
      // or a computed operator-supplied target.
      await unlink(previewPath);
      result = applyRubricBackfill(db, plan);
    }
    const verification = new DatabaseConnection(database, false);
    let independent: RubricBackfillPlan;
    try {
      independent = planRubricBackfill(verification);
    } finally {
      verification.close();
    }
    if (apply && plan.generatedRubrics.length) {
      const candidates = new Map(
        plan.generatedRubrics.map((entry) => [
          JSON.stringify([entry.id, entry.partId || '']),
          entry,
        ]),
      );
      const entries: RubricOwnership['entries'] = [];
      for (const row of rows(db, 'questions')) {
        const question = JSON.parse(row.data) as Question;
        for (const subject of question.type === 'group' ? question.parts || [] : [question]) {
          const partId = question.type === 'group' ? subject.id : undefined;
          const entry = candidates.get(JSON.stringify([question.id, partId || '']));
          if (
            entry &&
            entry.sourceContentHash === questionContentDigest(question) &&
            entry.gradingRequirementsSha256 === sha(subject.gradingRequirements || '')
          )
            entries.push(entry);
        }
      }
      await writeFile(
        join(folder, 'ownership-manifest.json'),
        JSON.stringify(
          {
            format: 'noetic-generated-rubrics',
            version: 1,
            generatorVersion: RUBRIC_GENERATOR_VERSION,
            createdAt: new Date().toISOString(),
            entries,
          },
          null,
          2,
        ) + '\n',
      );
    }
    const report = {
      at: new Date().toISOString(),
      mode: apply ? 'apply' : 'plan',
      database,
      backup,
      plan: summary(plan),
      preflight,
      result,
      independentVerification: summary(independent),
      samples: plan.samples,
      ownershipSkipped: plan.ownershipSkipped,
      sourcePolicy: ownership
        ? '仅刷新清单中内容及标准哈希均未改变的本次生成项；保留人工修改和其他字段，不改变审核、学习、配置、既有题集或历史。'
        : '依据现有题干、答案、解析归纳；没有调用外部模型，没有事实新增。仅补空要求与根题更新时间；审核、学习、配置、既有题集和历史保持原样。',
      ...(refreshManifest ? { refreshManifest } : {}),
    };
    await writeFile(join(folder, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ ...report, samples: undefined }, null, 2));
  } finally {
    db.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
