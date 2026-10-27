import { z } from 'zod';
import { id, leafId, moneySchema, questionSchema, filtersSchema, scoringInputSchema, types } from '../../core/validation.js';
import { AI_PAPER_MAX_QUESTIONS, normalizeAiGradeItem } from '../../../shared/ai/ai.js';
export const aiSettingsSchema = z.object({ enabled: z.boolean(), baseUrl: z.string().trim().max(2000), model: z.string().trim().max(200), supportsImages: z.boolean(), sendImages: z.boolean(), timeoutSeconds: z.number().int().min(5).max(180), maxTokens: z.number().int().min(256).max(32000), updatedAt: z.string().datetime({ offset: true }).optional(), key: z.string().trim().max(8000).refine(v => !/[\r\n]/.test(v), '密钥不能包含换行').optional(), clearKey: z.boolean().optional() }).strict().refine(v => !(v.clearKey && v.key), '不能同时设置与清空密钥');
const prose = z.string().max(50_000);
const list = z.array(z.string().max(4000)).max(50);
export const explanationSchema = z.object({ explanationMarkdown: prose.min(1), followUpsMarkdown: prose.default(''), pitfallsMarkdown: prose.default('') }).strict();
export const gradingRequirementsSchema = z.string().trim().max(10_000);
const importSourceUrl = z.string().trim().url().max(3000).refine(value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; } }, '来源链接仅支持无账号密码的 HTTP(S) 地址');
export const aiImportInputSchema = z.object({
  text: z.string().trim().min(1).max(400_000), sourceName: z.string().trim().max(300).optional(),
  sourceUrl: importSourceUrl.optional(), mode: z.enum(['extract', 'generate']).default('extract'),
  requirements: z.string().trim().max(5000).default(''),
  questionTypes: z.array(types).max(7).refine(values => new Set(values).size === values.length, '题型不能重复').default([]),
  difficulty: z.number().int().min(1).max(4).optional(),
  categoryIds: z.array(id).max(100).default([]), tagIds: z.array(id).max(100).default([]),
  count: z.number().int().min(1).max(50).default(20),
}).strict();
export const gradeResultSchema = z.object({ items: z.array(z.object({ questionId: leafId, verdict: z.enum(['correct', 'partial', 'incorrect']).optional(), score: moneySchema.nullable(), maxPoints: moneySchema.nullable(), comment: prose.min(1), strengths: list, improvements: list, requiresRegrade: z.literal(true).optional() }).strict().transform(normalizeAiGradeItem)).min(1).max(20), gradingRequirements: gradingRequirementsSchema.optional() }).strict();
// An empty provider proposal expresses insufficient material. The route turns it
// into an actionable domain error; it must never become a successful saved run.
export const importResultSchema = z.object({ questions: z.array(questionSchema).max(50), taxonomySuggestions: z.object({ domains: z.array(z.string().trim().min(1).max(300)).max(20), categories: z.array(z.string().trim().min(1).max(300)).max(100), tags: z.array(z.string().trim().min(1).max(300)).max(100) }).strict().default({ domains: [], categories: [], tags: [] }) }).strict();
export const aiImportResultOutputSchema = importResultSchema.safeExtend({ questions: z.array(questionSchema).min(1).max(50), source: z.object({ mode: z.enum(['extract', 'generate']), name: z.string().max(300), url: importSourceUrl.optional(), requirements: z.string().max(5000).optional() }).strict().optional() });
export const reviewResultSchema = z.object({ items: z.array(z.object({ questionId: id, verdict: z.enum(['valid', 'needs_changes', 'uncertain']), issues: list, suggestedChanges: questionSchema.optional() }).strict()).min(1).max(20) }).strict();
export const aiIds = z.array(id).min(1).max(20).refine(v => new Set(v).size === v.length, '题号不能重复');
export const aiLeafIds = z.array(leafId).min(1).max(20).refine(v => new Set(v).size === v.length, '题号不能重复');
export const applySchema = z.object({ confirmed: z.literal(true), applyScores: z.boolean().default(false), appendNotes: z.boolean().default(false), questionIds: aiLeafIds.optional() }).strict().refine(v => v.applyScores || v.appendNotes, '至少选择应用判题结果或写入笔记');

export const aiPaperPlanInputSchema = z.object({ prompt: z.string().trim().min(1).max(10000), count: z.number().int().min(1).max(AI_PAPER_MAX_QUESTIONS).optional(), filters: filtersSchema.default({}) }).strict();
export const aiPaperPlanOutputSchema = z.object({ title: z.string().trim().min(1).max(300), description: z.string().max(10000), items: z.array(z.object({ questionId: id, reason: z.string().trim().min(1).max(4000) }).strict()).min(1).max(AI_PAPER_MAX_QUESTIONS) }).strict();
export const aiPaperPlanApplySchema = z.object({ confirmed: z.literal(true), title: z.string().trim().min(1).max(300), description: z.string().max(500000).default(''), questionIds: z.array(id).min(1).max(AI_PAPER_MAX_QUESTIONS).refine(v => new Set(v).size === v.length, '题号不能重复'), organization: z.enum(['domain', 'other']).default('other'), domainId: id.nullable().default(null), scoring: scoringInputSchema.optional() }).strict();
