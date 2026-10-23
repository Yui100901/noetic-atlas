import { z } from 'zod';
import { id, moneySchema, questionSchema, filtersSchema, scoringInputSchema } from '../../core/validation.js';
import { AI_PAPER_MAX_QUESTIONS } from '../../../shared/ai/ai.js';
export const aiSettingsSchema = z.object({ enabled: z.boolean(), baseUrl: z.string().trim().max(2000), model: z.string().trim().max(200), supportsImages: z.boolean(), sendImages: z.boolean(), timeoutSeconds: z.number().int().min(5).max(180), maxTokens: z.number().int().min(256).max(32000), updatedAt: z.string().datetime({ offset: true }).optional(), key: z.string().trim().max(8000).refine(v => !/[\r\n]/.test(v), '密钥不能包含换行').optional(), clearKey: z.boolean().optional() }).strict().refine(v => !(v.clearKey && v.key), '不能同时设置与清空密钥');
const prose = z.string().max(50_000);
const list = z.array(z.string().max(4000)).max(50);
export const explanationSchema = z.object({ explanationMarkdown: prose.min(1), followUpsMarkdown: prose.default(''), pitfallsMarkdown: prose.default('') }).strict();
export const gradeResultSchema = z.object({ items: z.array(z.object({ questionId: id, score: moneySchema.nullable(), maxPoints: moneySchema.nullable(), comment: prose.min(1), strengths: list, improvements: list }).strict()).min(1).max(20) }).strict();
export const importResultSchema = z.object({ questions: z.array(questionSchema).min(1).max(50), taxonomySuggestions: z.object({ domains: z.array(z.string().trim().min(1).max(300)).max(20), categories: z.array(z.string().trim().min(1).max(300)).max(100), tags: z.array(z.string().trim().min(1).max(300)).max(100) }).strict().default({ domains: [], categories: [], tags: [] }) }).strict();
export const reviewResultSchema = z.object({ items: z.array(z.object({ questionId: id, verdict: z.enum(['valid', 'needs_changes', 'uncertain']), issues: list, suggestedChanges: questionSchema.optional() }).strict()).min(1).max(20) }).strict();
export const aiIds = z.array(id).min(1).max(20).refine(v => new Set(v).size === v.length, '题号不能重复');
export const applySchema = z.object({ confirmed: z.literal(true), applyScores: z.boolean().default(false), appendNotes: z.boolean().default(false), questionIds: aiIds.optional() }).strict().refine(v => v.applyScores || v.appendNotes, '至少选择应用评分或写入笔记');

export const aiPaperPlanInputSchema = z.object({ prompt: z.string().trim().min(1).max(10000), count: z.number().int().min(1).max(AI_PAPER_MAX_QUESTIONS).optional(), filters: filtersSchema.default({}) }).strict();
export const aiPaperPlanOutputSchema = z.object({ title: z.string().trim().min(1).max(300), description: z.string().max(10000), items: z.array(z.object({ questionId: id, reason: z.string().trim().min(1).max(4000) }).strict()).min(1).max(AI_PAPER_MAX_QUESTIONS) }).strict();
export const aiPaperPlanApplySchema = z.object({ confirmed: z.literal(true), title: z.string().trim().min(1).max(300), description: z.string().max(500000).default(''), questionIds: z.array(id).min(1).max(AI_PAPER_MAX_QUESTIONS).refine(v => new Set(v).size === v.length, '题号不能重复'), organization: z.enum(['domain', 'other']).default('other'), domainId: id.nullable().default(null), scoring: scoringInputSchema.optional() }).strict();
