import { z } from 'zod';
import { conceptPromptIsSafe } from '../../shared/questions/concept.js';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
export const fail = (status: number, code: string, message: string, details?: unknown): never => { throw new ApiError(status, code, message, details); };
const identifier = (maximum: number) => z.string().trim().min(1).max(maximum).regex(/^[\p{L}\p{N}_.:-]+$/u, 'ID 只能含字母、数字和 _ . : -').refine(v => !['__proto__', 'prototype', 'constructor'].includes(v), 'ID 为保留名称');
export const id = identifier(160);
/** A flattened identity contains a 160-character parent, ::, and a 160-character part. */
export const leafId = identifier(322);
const text = z.string().max(500_000);
const name = z.string().trim().min(1).max(300);
const ids = z.array(id).max(500).refine(a => new Set(a).size === a.length, '引用 ID 不得重复');
export const types = z.enum(['short_answer', 'true_false', 'single_choice', 'multiple_choice', 'fill_blank', 'essay', 'group']);
const leafTypes = z.enum(['short_answer', 'true_false', 'single_choice', 'multiple_choice', 'fill_blank', 'essay']);
export const blankSchema = z.object({ id: id.refine(v => !v.includes('::'), '空位ID不能含::'), label: name, answers: z.array(z.string().min(1).max(1000)).min(1).max(30), caseSensitive: z.boolean().default(false), trim: z.boolean().default(true) }).strict();
// This schema owns field optionality across authoring, imports and quality
// structure checks. Optional prose stays optional even for subjective items;
// checkLeaf below owns the conditional grading requirements for each type.
const answerFields = { title: name, stemMarkdown: text.min(1), answerMarkdown: text.default(''), explanationMarkdown: text.default(''), options: z.array(z.object({ key: z.string().min(1).max(20), text })).max(26).default([]), correctAnswers: z.array(z.string().max(20)).max(26).default([]), blanks: z.array(blankSchema).max(30).optional() };
function checkLeaf(q: { type: string; options: {key:string}[]; correctAnswers: string[]; blanks?: z.infer<typeof blankSchema>[] }, ctx: z.RefinementCtx) {
  const keys = q.options.map(o => o.key);
  if (new Set(keys).size !== keys.length || new Set(q.correctAnswers).size !== q.correctAnswers.length) ctx.addIssue({ code: 'custom', message: '选项或答案不得重复' });
  if (q.type === 'true_false') {
    if (q.options.length !== 0 || q.correctAnswers.length !== 1 || !['true', 'false'].includes(q.correctAnswers[0]!)) ctx.addIssue({ code: 'custom', message: '判断题无选项，答案须为 true 或 false' });
  } else if (q.type === 'single_choice' || q.type === 'multiple_choice') {
    if (keys.length < 2 || q.correctAnswers.some(k => !keys.includes(k)) || (q.type === 'single_choice' ? q.correctAnswers.length !== 1 : q.correctAnswers.length < 2)) ctx.addIssue({ code: 'custom', message: '选择题答案必须引用有效选项；单选恰好一项，多选至少两项' });
  } else if (q.correctAnswers.length || q.options.length) ctx.addIssue({ code: 'custom', message: '填空、主观题和组合题不使用选择项或客观答案' });
  if (q.type === 'fill_blank') {
    if (!q.blanks?.length) ctx.addIssue({ code: 'custom', message: '填空题必须定义至少一个空位及其标准答案' });
    if (new Set(q.blanks?.map(b => b.id)).size !== q.blanks?.length) ctx.addIssue({ code: 'custom', message: '空位ID不能重复' });
    if (q.blanks?.some(b => b.answers.some(a => !(b.trim ? a.trim() : a).length))) ctx.addIssue({ code: 'custom', message: '空位答案不能为空或仅包含空白' });
  } else if (q.blanks?.length) ctx.addIssue({ code: 'custom', message: '只有填空题可以定义空位' });
}
export const questionPartSchema = z.object({ id: id.refine(v => !v.includes('::'), '子题ID不能含::'), ...answerFields, type: leafTypes, weight: z.number().finite().positive().max(1000).default(1) }).strict().superRefine(checkLeaf);
export const collection = z.enum(['general', 'personal']);
const stamp = z.string().datetime({ offset: true });
export const domainSchema = z.object({ id: id.optional(), name, description: text.default(''), sortOrder: z.number().int().default(0) });
export const categorySchema = domainSchema.extend({ domainId: id, parentId: id.nullable().default(null) });
export const tagSchema = z.object({ id: id.optional(), name, color: z.string().max(30).default('#5264db'), description: text.default(''), domainId: id.nullable().optional(), kind: z.enum(['topic', 'method', 'custom']).optional() });
export const vocabularySchema = z.object({
  language: z.enum(['en','ja']), headword: z.string().trim().min(1).max(300), meaningPrompt: z.string().trim().min(1).max(8000),
  acceptedAnswers: z.array(z.string().trim().min(1).max(1000)).min(1).max(30),
  pronunciations: z.array(z.object({ label: z.string().min(1).max(100), ipa: z.string().min(1).max(1000).optional(), kana: z.string().min(1).max(1000).optional(), romaji: z.string().min(1).max(1000).optional(), sourceLabel: z.string().min(1).max(500), sourceUrl: z.string().url().max(3000).refine(value=>/^https?:\/\//.test(value)), license: z.string().min(1).max(300), method: z.enum(['source','transliteration','expanded','manual']) }).strict()).min(1).max(40),
}).strict().superRefine((value,context)=>{if(value.pronunciations.some(item=>value.language==='en'?!item.ipa:!item.kana||!item.romaji))context.addIssue({code:'custom',message:'英语读音需IPA，日语读音需假名和罗马音'});});
export const conceptSchema = z.object({
  term: z.string().trim().min(1).max(300), meaningPrompt: z.string().trim().min(1).max(3000),
  acceptedAnswers: z.array(z.string().trim().min(1).max(300)).min(1).max(30),
}).strict().superRefine((value, context) => {
  if (!value.acceptedAnswers.some(answer => answer.normalize('NFKC').trim().toLowerCase() === value.term.normalize('NFKC').trim().toLowerCase())) context.addIssue({ code: 'custom', message: '概念答案须包含主概念名称' });
  if (!conceptPromptIsSafe(value)) context.addIssue({ code: 'custom', message: '概念独立定义不能含目标词、别称或答案链接' });
});
/** Canonical question contract. Do not add independent required-field lists in
 * UI, generic content tooling or deterministic quality rules. */
export const questionSchema = z.object({
  id: id.optional(), ...answerFields, type: types, parts: z.array(questionPartSchema).max(30).optional(),
  vocabulary: vocabularySchema.optional(),
  concept: conceptSchema.optional(),
  difficulty: z.number().int().min(1).max(4).default(1), depth: z.number().int().min(1).max(4).default(1), frequency: z.number().int().min(0).max(3).default(0),
  frequencyScope: text.default(''), frequencyBasis: text.default('经验估计，非统计频率'), collection: collection.default('general'), status: z.enum(['published', 'pending', 'draft', 'archived']).default('published'),
  categoryIds: ids.default([]), tagIds: ids.default([]), sourceRefs: z.array(z.object({ label: z.string().max(500), url: z.string().max(3000).refine(v => /^(https?:\/\/|#\/)/i.test(v), '仅支持 HTTP(S) 来源或站内链接') })).max(100).default([]),
  sourceDocument: z.string().max(2000).nullable().default(null), sourceAnchor: z.string().max(300).nullable().default(null),
  createdAt: stamp.optional(), updatedAt: stamp.optional(),
}).superRefine((q, ctx) => {
  checkLeaf(q, ctx);
  if (q.concept && (q.vocabulary || !['short_answer','fill_blank'].includes(q.type))) ctx.addIssue({ code: 'custom', message: '概念信息仅适用于概念简答卡或其逆向作答快照，不可兼作语言词卡' });
  if (q.type === 'group') {
    if (!q.parts || q.parts.length < 2) ctx.addIssue({ code: 'custom', message: '组合题需要2至30个独立子题' });
    if (new Set(q.parts?.map(p => p.id)).size !== q.parts?.length) ctx.addIssue({ code: 'custom', message: '子题ID不能重复' });
  } else if (q.parts?.length) ctx.addIssue({ code: 'custom', message: '仅组合题可以定义子题' });
});
export const snapshotQuestionSchema = questionSchema.safeExtend({ id: leafId.optional(), sourceQuestionId: id.optional(), groupId: id.optional(), groupTitle: name.optional(), groupStemMarkdown: text.optional(), partId: id.optional(), partIndex: z.number().int().min(0).max(29).optional() }).superRefine((question, context) => { if (!question.partId && question.id && !id.safeParse(question.id).success) context.addIssue({ code: 'custom', path: ['id'], message: '普通题或整组题号最多160字符' }); });
export const selectedIdsSchema = z.object({ ids: ids.refine(a => a.length > 0, '至少选择一道题目') }).strict();
export const questionMetadataInputSchema = z.object({ ids: z.array(id).min(1).max(50000).refine(values => new Set(values).size === values.length, '题号不得重复') }).strict();
export const questionReviewSchema = selectedIdsSchema.extend({ action: z.enum(['approve', 'return_to_draft']), confirmed: z.literal(true), expectedUpdatedAt: z.record(id, stamp) }).strict().superRefine((v, ctx) => {
  if (Object.keys(v.expectedUpdatedAt).length !== v.ids.length || v.ids.some(qid => !v.expectedUpdatedAt[qid])) ctx.addIssue({ code: 'custom', message: '每道题必须提供且仅提供对应的 updatedAt 审核版本' });
});
export const pendingEnvelopeSchema = z.object({ format: z.literal('learning-pending-questions'), schemaVersion: z.literal(1), exportedAt: stamp, questions: z.array(questionSchema).min(1).max(500) }).strict().superRefine((v, ctx) => {
  if (v.questions.some(q => !q.id || !q.updatedAt || q.status !== 'pending')) ctx.addIssue({ code: 'custom', message: '仅可导入带题号、updatedAt 和 pending 状态的待审核题目' });
  if (new Set(v.questions.map(q => q.id)).size !== v.questions.length) ctx.addIssue({ code: 'custom', message: '题号不能重复' });
});
export const questionBankSchema = z.object({ id: id.optional(), name, description: text.default(''), questionIds: z.array(id).max(50_000).refine(a => new Set(a).size === a.length, '题库引用的题号不得重复').default([]), createdAt: stamp.optional(), updatedAt: stamp.optional() }).strict();
export const newQuestionEnvelopeSchema = z.object({ format: z.literal('learning-new-questions'), schemaVersion: z.literal(1), questions: z.array(questionSchema.strict()).min(1).max(500) }).strict().superRefine((v, ctx) => {
  const specified = v.questions.map(q => q.id).filter(Boolean);
  if (new Set(specified).size !== specified.length) ctx.addIssue({ code: 'custom', message: '新题导入中指定的题号不得重复' });
});
export const bulkQuestionImportSchema = z.object({ data: newQuestionEnvelopeSchema, confirmed: z.literal(true) }).strict();
export const documentSchema = z.object({ id: id.optional(), title: name, kind: name.default('学习笔记'), bodyMarkdown: z.string().max(50 * 1024 * 1024).default(''), format: z.enum(['markdown', 'pdf']).default('markdown'), assetId: id.nullable().default(null), fileName: z.string().max(300).nullable().default(null), collection: collection.default('general'), categoryIds: ids.default([]), tagIds: ids.default([]), domainIds: ids.optional(), author: z.string().max(300).default(''), publisher: z.string().max(300).default(''), publishedYear: z.string().max(40).default(''), description: z.string().max(10000).default(''), sourcePath: z.string().max(2000).nullable().default(null), updatedAt: stamp.optional() });
export const filtersSchema = z.object({ tagIds: ids.optional(), tagMode: z.enum(['all', 'any']).optional(), categoryId: id.optional(), domainId: id.optional(), paperId: id.optional(), types: z.array(types).optional(), difficultyMin: z.number().int().min(1).max(4).optional(), difficultyMax: z.number().int().min(1).max(4).optional(), frequencyMin: z.number().int().min(0).max(3).optional(), collection: z.enum(['general', 'personal', 'all']).optional() }).strict().superRefine((f, c) => { if (f.difficultyMin && f.difficultyMax && f.difficultyMin > f.difficultyMax) c.addIssue({ code: 'custom', message: '最低难度不可高于最高难度' }); });
export const moneySchema = z.number().finite().min(0).max(10000).refine(v => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, '分值最多保留两位小数');
const positivePoints = moneySchema.refine(v => v >= 0.01 && v <= 1000, '每题分值须在0.01至1000之间');
export const typePointsSchema = z.object({ short_answer: positivePoints.optional(), true_false: positivePoints.optional(), single_choice: positivePoints.optional(), multiple_choice: positivePoints.optional(), fill_blank: positivePoints.optional(), essay: positivePoints.optional(), group: positivePoints.optional() }).strict();
export const scoringInputSchema = z.object({ enabled: z.boolean(), totalPoints: moneySchema.optional(), questionPoints: z.record(leafId, positivePoints).optional(), objectivePercent: z.number().finite().min(0).max(100).optional(), pointsByType: typePointsSchema.optional() }).strict();
// Stored fields include calculated values, which are checked against snapshots
// on import rather than silently discarding a corrupted scoring configuration.
export const storedScoringSchema = z.object({ enabled: z.boolean(), totalPoints: moneySchema, questionPoints: z.record(leafId, moneySchema), objectivePercent: z.number().finite().min(0).max(100), actualObjectivePercent: z.number().finite().min(0).max(100), objectivePoints: moneySchema, subjectivePoints: moneySchema, pointsByType: typePointsSchema.refine(p => ['short_answer','true_false','single_choice','multiple_choice'].every(t => p[t as keyof typeof p] !== undefined), '旧有四种题型分值不可缺项'), scheme: z.enum(['legacy', 'custom', 'none']) }).strict();
export const paperInputSchema = z.object({ id: id.optional(), title: name, description: text.default(''), mode: z.enum(['manual', 'random']), practiceKind: z.enum(['standard','vocabulary','concept']).default('standard'), organization: z.enum(['domain', 'other']).default('other'), domainId: id.nullable().default(null), questionIds: z.array(id).max(50_000).refine(a=>new Set(a).size===a.length, '题集题号不可重复').optional(), filters: filtersSchema.nullable().optional(), count: z.number().int().min(1).max(500).optional(), scoring: scoringInputSchema.optional() });
export const verdictSchema = z.enum(['correct','partial','incorrect']);
export const answerSchema = z.object({ value: z.union([z.string().max(100_000), z.array(z.string().max(1000)).max(30)]), selfScore: moneySchema.nullable().optional(), mastery: z.number().int().min(0).max(3).nullable().optional(), verdict: verdictSchema.nullable().optional() });
export const answersSchema = z.record(z.string(), answerSchema).refine(v => Object.keys(v).length <= 500, '单次最多500个作答项');
export const studySchema = z.object({ partId: id.optional(), favorite: z.boolean().optional(), mastery: z.number().int().min(0).max(3).nullable().optional(), notes: text.optional(), nextReviewAt: stamp.nullable().optional() }).strict();
export const reviewRatingSchema = z.enum(['again', 'hard', 'good', 'easy']);
export const reviewSchema = z.object({ partId: id.optional(), mastery: z.number().int().min(0).max(3).optional(), rating: reviewRatingSchema.optional(), direction: z.enum(['standard', 'word_to_meaning', 'meaning_to_word']).optional(), requestId: id.optional() }).strict().refine(value => value.mastery !== undefined || value.rating !== undefined, '请提交回忆评级或掌握程度');
export const scoreSchema = z.object({ scores: z.record(leafId, moneySchema.nullable()).optional(), mastery: z.record(leafId, z.number().int().min(0).max(3)).optional(), verdicts: z.record(leafId, verdictSchema.nullable()).optional(), ratings: z.record(leafId, reviewRatingSchema.nullable()).optional() }).strict().refine(v => Object.keys(v.scores || {}).length + Object.keys(v.mastery || {}).length + Object.keys(v.verdicts || {}).length + Object.keys(v.ratings || {}).length > 0, '至少提交一道题的评分、判定、掌握自评或回忆评级');
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) fail(400, 'VALIDATION_ERROR', '输入数据不符合约定', result.error.issues.map(e => ({ path: e.path.join('.'), message: e.message })));
  return result.data!;
}
