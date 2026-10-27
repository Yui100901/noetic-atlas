import { z } from 'zod';
import { AI_DOCUMENT_LIMITS } from '../../../shared/ai/ai-document.js';
import { id, types, questionSchema, fail } from '../../core/validation.js';
import { aiImportResultOutputSchema } from './schema.js';

const ids = z.array(id).min(1).max(AI_DOCUMENT_LIMITS.maxBlocks).refine(values => new Set(values).size === values.length, '分块不能重复');
const url = z.string().trim().url().max(3000).refine(value => { const parsed = new URL(value); return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password; }, '来源链接须为无账号密码的HTTP(S)地址');
const page = z.number().int().min(1).max(100_000);
const section = z.object({ text: z.string().max(AI_DOCUMENT_LIMITS.maxSourceCharacters), label: z.string().trim().max(300).optional(), sourceName: z.string().trim().max(300).optional(), pageStart: page.optional(), pageEnd: page.optional() }).strict().refine(value => value.pageEnd === undefined || value.pageStart !== undefined && value.pageEnd >= value.pageStart, '页码范围无效');
export const aiDocumentCreateSchema = z.object({
  confirmed: z.literal(true), sourceName: z.string().trim().min(1).max(300), sourceUrl: url.optional(), sections: z.array(section).min(1).max(AI_DOCUMENT_LIMITS.maxBlocks),
  mode: z.enum(['extract', 'generate']).default('generate'), requirements: z.string().trim().max(5000).default(''), questionTypes: z.array(types).max(7).refine(values => new Set(values).size === values.length, '题型不能重复').default([]), difficulty: z.number().int().min(1).max(4).optional(),
  categoryIds: z.array(id).max(100).default([]), tagIds: z.array(id).max(100).default([]), questionsPerBlock: z.number().int().min(1).max(AI_DOCUMENT_LIMITS.maxQuestionsPerBlock).default(10), maxQuestions: z.number().int().min(1).max(AI_DOCUMENT_LIMITS.maxQuestionsPerJob).default(200),
}).strict().refine(value => value.maxQuestions >= value.questionsPerBlock, '任务总题量预算不能小于每块题量');
export const aiDocumentProcessSchema = z.object({ blockIds: ids.max(AI_DOCUMENT_LIMITS.maxBlocksPerRequest), retryFailed: z.boolean().default(false), questionsPerBlock: z.number().int().min(1).max(AI_DOCUMENT_LIMITS.maxQuestionsPerBlock).optional() }).strict();
export const aiDocumentImportSchema = z.object({ confirmed: z.literal(true), blockIds: ids, questions: z.array(z.object({ blockId: id, questions: z.array(questionSchema).min(1).max(AI_DOCUMENT_LIMITS.maxQuestionsPerBlock) }).strict()).max(AI_DOCUMENT_LIMITS.maxBlocks).optional() }).strict();
export const aiDocumentSummarySchema = z.object({ title: z.string().trim().min(1).max(300), summary: z.string().trim().min(1).max(5000), topics: z.array(z.string().trim().min(1).max(300)).min(1).max(30) }).strict();
export const aiDocumentPlanResultSchema = aiDocumentSummarySchema.extend({ sourceName: z.string().min(1).max(300), label: z.string().max(300) });
export const aiDocumentGenerateResultSchema = aiImportResultOutputSchema;
export const aiDocumentFailureSchema = z.object({ code: z.string().max(100), message: z.string().max(2000), stage: z.enum(['plan', 'generate']), retryable: z.boolean(), auditId: id.optional() }).strict();
const blockState = z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']);
const block = z.object({
  id, sourceName: z.string().min(1).max(300), label: z.string().max(300), pageStart: page.optional(), pageEnd: page.optional(), characters: z.number().int().min(1).max(AI_DOCUMENT_LIMITS.blockCharacters), text: z.string().min(1).max(AI_DOCUMENT_LIMITS.blockCharacters),
  title: z.string().max(300), summary: z.string().max(5000), topics: z.array(z.string().max(300)).max(30), planStatus: blockState, generationStatus: blockState, planAttempts: z.number().int().min(0), generationAttempts: z.number().int().min(0), planFailure: aiDocumentFailureSchema.optional(), generationFailure: aiDocumentFailureSchema.optional(),
  questions: z.array(questionSchema).max(AI_DOCUMENT_LIMITS.maxQuestionsPerBlock), importedQuestionIds: z.array(id).max(AI_DOCUMENT_LIMITS.maxQuestionsPerBlock), planRunId: id.optional(), generationRunId: id.optional(), generationQuestionLimit: z.number().int().min(1).max(AI_DOCUMENT_LIMITS.maxQuestionsPerBlock).optional(),
}).strict();
export const storedAiDocumentJobSchema = z.object({
  id, sourceName: z.string().min(1).max(300), sourceUrl: url.optional(), createdAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }), status: z.enum(['pending', 'running', 'ready', 'partial', 'failed', 'completed']),
  blockCount: z.number().int().min(1).max(AI_DOCUMENT_LIMITS.maxBlocks), plannedBlocks: z.number().int().min(0), failedBlocks: z.number().int().min(0), generatedBlocks: z.number().int().min(0), questionCount: z.number().int().min(0).max(AI_DOCUMENT_LIMITS.maxQuestionsPerJob), importedCount: z.number().int().min(0).max(AI_DOCUMENT_LIMITS.maxQuestionsPerJob),
  mode: z.enum(['extract', 'generate']), requirements: z.string().max(5000), questionTypes: z.array(types).max(7), difficulty: z.number().int().min(1).max(4).optional(), categoryIds: z.array(id).max(100), tagIds: z.array(id).max(100), questionsPerBlock: z.number().int().min(1).max(AI_DOCUMENT_LIMITS.maxQuestionsPerBlock), maxQuestions: z.number().int().min(1).max(AI_DOCUMENT_LIMITS.maxQuestionsPerJob), blocks: z.array(block).min(1).max(AI_DOCUMENT_LIMITS.maxBlocks),
}).strict();
export type StoredAiDocumentJob = z.infer<typeof storedAiDocumentJobSchema>;

/** Used by complete database restore. No input trigger or generated ID is trusted. */
export function validateStoredAiDocumentJob(value: unknown): StoredAiDocumentJob {
  const parsed = storedAiDocumentJobSchema.safeParse(value);
  if (!parsed.success) fail(400, 'INVALID_AI_DOCUMENT_JOB', '教材处理任务结构无效');
  const job = parsed.data!;
  if (new Set(job.blocks.map(item => item.id)).size !== job.blocks.length) fail(400, 'INVALID_AI_DOCUMENT_JOB', '教材处理任务包含重复分块');
  const text = job.blocks.map(item => item.text).join('');
  if (text.length > AI_DOCUMENT_LIMITS.maxSourceCharacters || new TextEncoder().encode(text).length > AI_DOCUMENT_LIMITS.maxSourceBytes) fail(400, 'INVALID_AI_DOCUMENT_JOB', '教材处理任务超过资料容量限制');
  for (const item of job.blocks) {
    if (item.characters !== item.text.length || new TextEncoder().encode(item.text).length > AI_DOCUMENT_LIMITS.blockBytes || item.pageEnd !== undefined && (item.pageStart === undefined || item.pageEnd < item.pageStart)) fail(400, 'INVALID_AI_DOCUMENT_JOB', '教材处理任务的分块长度或页码无效');
    if (item.planStatus === 'completed' && (!item.summary.trim() || !item.title.trim() || !item.topics.length)) fail(400, 'INVALID_AI_DOCUMENT_JOB', '已完成的教材总结缺少内容');
    if (item.generationStatus === 'completed' && (!item.questions.length || item.planStatus !== 'completed')) fail(400, 'INVALID_AI_DOCUMENT_JOB', '已完成的教材出题缺少有效预览');
    if (item.generationQuestionLimit && (item.generationQuestionLimit > job.questionsPerBlock || item.questions.length > item.generationQuestionLimit)) fail(400, 'INVALID_AI_DOCUMENT_JOB', '资料块题量超过已确认的本轮限制');
    if (item.questions.some(question => question.status !== 'pending') || item.importedQuestionIds.length > item.questions.length || new Set(item.importedQuestionIds).size !== item.importedQuestionIds.length) fail(400, 'INVALID_AI_DOCUMENT_JOB', '教材出题预览或导入引用无效');
  }
  const counts = aiDocumentCounts(job.blocks);
  if (new TextEncoder().encode(JSON.stringify(job.blocks.flatMap(block => block.questions))).length > 16_000_000) fail(400, 'INVALID_AI_DOCUMENT_JOB', '教材处理任务的预览结果超过容量限制');
  const importedIds = job.blocks.flatMap(block => block.importedQuestionIds);
  if (new Set(importedIds).size !== importedIds.length || job.status !== aiDocumentStatus(job.blocks) || Object.entries(counts).some(([key, count]) => job[key as keyof typeof counts] !== count) || counts.questionCount > job.maxQuestions || job.maxQuestions < job.questionsPerBlock) fail(400, 'INVALID_AI_DOCUMENT_JOB', '教材处理任务的统计、状态或题量预算不一致');
  return job;
}
export function aiDocumentCounts(blocks: StoredAiDocumentJob['blocks']) {
  return { blockCount: blocks.length, plannedBlocks: blocks.filter(block => block.planStatus === 'completed').length, failedBlocks: blocks.filter(block => ['failed', 'cancelled'].includes(block.planStatus) || ['failed', 'cancelled'].includes(block.generationStatus)).length, generatedBlocks: blocks.filter(block => block.generationStatus === 'completed').length, questionCount: blocks.reduce((sum, block) => sum + block.questions.length, 0), importedCount: blocks.reduce((sum, block) => sum + block.importedQuestionIds.length, 0) };
}
export function aiDocumentStatus(blocks: StoredAiDocumentJob['blocks']): StoredAiDocumentJob['status'] {
  const counts = aiDocumentCounts(blocks);
  return blocks.some(block => block.planStatus === 'running' || block.generationStatus === 'running') ? 'running' : counts.failedBlocks ? counts.plannedBlocks || counts.generatedBlocks ? 'partial' : 'failed' : blocks.every(block => block.generationStatus === 'completed' && block.importedQuestionIds.length > 0) ? 'completed' : counts.plannedBlocks ? 'ready' : 'pending';
}
