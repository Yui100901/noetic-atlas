import { z } from 'zod';
import { id, types, fail, questionSchema } from '../../core/validation.js';
import type { Store } from '../../core/store.js';
import type {
  QuestionDraft,
  QuestionDraftState,
  QuestionRevision,
} from '../../../shared/models/question-maintenance.js';
import { validateAssetReferences } from '../assets/service.js';

const text = z.string().max(500_000),
  short = z.string().max(300),
  stamp = z.string().datetime({ offset: true });
const strings = z.array(z.string().max(1000)).max(500);
const blank = z
  .object({
    id: short,
    label: short,
    answers: z.array(z.string().max(1000)).max(30),
    caseSensitive: z.boolean().default(false),
    trim: z.boolean().default(true),
  })
  .strict();
const leaf = {
  title: short,
  type: types,
  stemMarkdown: text,
  answerMarkdown: text,
  explanationMarkdown: text,
  gradingRequirements: z.string().max(10_000).optional(),
  mathEnabled: z.boolean().optional(),
  options: z.array(z.object({ key: z.string().max(20), text }).strict()).max(26),
  correctAnswers: z.array(z.string().max(1000)).max(26),
  blanks: z.array(blank).max(30).optional(),
};
const pronunciation = z
  .object({
    label: z.string().max(100),
    ipa: z.string().max(1000).optional(),
    kana: z.string().max(1000).optional(),
    romaji: z.string().max(1000).optional(),
    sourceLabel: z.string().max(500),
    sourceUrl: z.string().max(3000),
    license: short,
    method: z.enum(['source', 'transliteration', 'expanded', 'manual']),
  })
  .strict();
const citation = z
  .object({
    documentId: id.nullable(),
    versionId: z.string().max(100).nullable(),
    title: short,
    relation: z.enum(['extracted', 'summarized', 'reference']),
    label: short.default(''),
    pageStart: z.number().int().optional(),
    pageEnd: z.number().int().optional(),
    startOffset: z.number().int().optional(),
    endOffset: z.number().int().optional(),
    excerpt: z.string().max(2000).default(''),
  })
  .strict();
/** A safe editing envelope, deliberately separate from publish validation:
 * temporary empty choices/answers and stale taxonomy must remain recoverable. */
export const questionRevisionContentSchema = z
  .object({
    ...leaf,
    parts: z
      .array(
        z
          .object({
            ...leaf,
            type: types.exclude(['group']),
            id: short,
            weight: z.number().finite().max(1000).optional(),
          })
          .strict(),
      )
      .max(30)
      .optional(),
    vocabulary: z
      .object({
        language: z.enum(['en', 'ja']),
        headword: short,
        partOfSpeech: z.string().max(100).optional(),
        meaningPrompt: z.string().max(8000),
        acceptedAnswers: z.array(z.string().max(1000)).max(30),
        pronunciations: z.array(pronunciation).max(40),
        reverseEnabled: z.boolean().optional(),
        caseSensitive: z.boolean().default(false),
        trim: z.boolean().default(true),
      })
      .strict()
      .optional(),
    concept: z
      .object({
        term: short,
        meaningPrompt: z.string().max(3000),
        acceptedAnswers: z.array(short).max(30),
      })
      .strict()
      .optional(),
    difficulty: z.number().finite(),
    depth: z.number().finite(),
    frequency: z.number().finite(),
    frequencyScope: text,
    frequencyBasis: text,
    collection: z.enum(['general', 'personal']),
    categoryIds: strings,
    tagIds: strings,
    sourceRefs: z
      .array(z.object({ label: z.string().max(500), url: z.string().max(3000) }).strict())
      .max(100),
    sourceDocument: z.string().max(2000).nullable(),
    sourceAnchor: short.nullable(),
    documentLinks: z.array(citation).max(30).optional(),
  })
  .strict();
export const questionDraftStateSchema = z
  .object({
    form: questionRevisionContentSchema
      .extend({ status: z.enum(['published', 'pending', 'draft', 'archived']) })
      .strict(),
    sources: z.string().max(400_000),
    reason: z.string().max(2000),
  })
  .strict();
export const questionDraftSchema = z
  .object({
    id,
    questionId: id.nullable(),
    baseUpdatedAt: stamp.nullable(),
    state: questionDraftStateSchema,
    createdAt: stamp,
    updatedAt: stamp,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.questionId && value.baseUpdatedAt !== null)
      ctx.addIssue({
        code: 'custom',
        path: ['baseUpdatedAt'],
        message: '新题草稿不能指定原题版本',
      });
    if (Date.parse(value.updatedAt) < Date.parse(value.createdAt))
      ctx.addIssue({
        code: 'custom',
        path: ['updatedAt'],
        message: '草稿更新时间不得早于创建时间',
      });
  });
export const questionRevisionSchema = z
  .object({
    id,
    questionId: id,
    sequence: z.number().int().min(1),
    content: questionRevisionContentSchema,
    origin: z.enum(['baseline', 'manual', 'restore', 'pending_import', 'ai_review']),
    reason: z.string().max(2000),
    changedFields: z
      .array(z.enum(Object.keys(questionRevisionContentSchema.shape) as [string, ...string[]]))
      .max(50),
    createdAt: stamp,
    sourceUpdatedAt: stamp,
    restoredFromId: id.optional(),
  })
  .strict();
const pagination = {
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
};
export const questionDraftQuerySchema = z
  .object({ questionId: id.optional(), ...pagination })
  .strict();
export const questionRevisionQuerySchema = z.object(pagination).strict();
export const createQuestionDraftSchema = z
  .object({
    questionId: id.nullable(),
    baseUpdatedAt: stamp.nullable(),
    state: questionDraftStateSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.questionId && value.baseUpdatedAt !== null)
      ctx.addIssue({ code: 'custom', message: '新题草稿不能指定原题版本' });
  });
export const updateQuestionDraftSchema = z
  .object({
    expectedUpdatedAt: stamp,
    state: questionDraftStateSchema,
    baseUpdatedAt: stamp.nullable().optional(),
  })
  .strict();
export const deleteQuestionDraftSchema = z.object({ expectedUpdatedAt: stamp }).strict();
export const restoreQuestionRevisionSchema = z
  .object({
    expectedUpdatedAt: stamp,
    confirmed: z.literal(true),
    reason: z.string().max(2000).default(''),
  })
  .strict();
export const questionSaveSchema = questionSchema
  .safeExtend({
    revisionReason: z.string().max(2000).optional(),
    draftId: id.optional(),
    draftUpdatedAt: stamp.optional(),
  })
  .superRefine((value, ctx) => {
    if (Boolean(value.draftId) !== Boolean(value.draftUpdatedAt))
      ctx.addIssue({ code: 'custom', message: '草稿ID和草稿版本须同时提供' });
  });
export function validateQuestionMaintenanceBytes(value: unknown) {
  if (new TextEncoder().encode(JSON.stringify(value)).length > 5 * 1024 * 1024)
    fail(413, 'QUESTION_MAINTENANCE_TOO_LARGE', '单份题目草稿或修订内容不得超过5 MiB');
}
export function validateQuestionDraft(store: Store, draft: QuestionDraft) {
  validateQuestionMaintenanceBytes(draft);
  if (draft.questionId) store.require('questions', draft.questionId);
  validateAssetReferences(store, { form: draft.state.form, sources: draft.state.sources });
}
export function validateQuestionRevision(store: Store, revision: QuestionRevision) {
  validateQuestionMaintenanceBytes(revision);
  store.require('questions', revision.questionId);
  if (revision.origin !== 'baseline')
    questionSchema.parse({ ...revision.content, id: revision.questionId, status: 'draft' });
  const d = store.database,
    x = d.expressions;
  if (
    d.one(
      d.query
        .selectFrom('question_revisions')
        .select('id')
        .where(x.field('data', 'questionId'), '=', revision.questionId)
        .where(x.field('data', 'sequence'), '=', revision.sequence)
        .where('id', '!=', revision.id)
        .limit(1),
    )
  )
    fail(
      409,
      'QUESTION_REVISION_SEQUENCE_CONFLICT',
      '该题已存在相同编号的不同修订，请检查迁移来源，不会覆盖本地历史',
    );
  // A baseline may be the only evidence of a broken source being repaired.
  // Keep that evidence readable; every real restore still validates all assets.
  if (revision.origin !== 'baseline') validateAssetReferences(store, revision.content);
}
export function validateQuestionDraftState(store: Store, state: QuestionDraftState) {
  validateQuestionMaintenanceBytes(state);
  validateAssetReferences(store, { form: state.form, sources: state.sources });
}
