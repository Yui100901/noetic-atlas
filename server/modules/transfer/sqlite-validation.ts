import type { Store } from '../../core/store.js';
import { parse } from '../../core/validation.js';
import { aiSettingsSchema } from '../ai/schema.js';
import { completedAiResultSchemas, storedCompletedAiRunSchema } from '../ai/run-schema.js';
import { aiFailedRunSchema } from '../ai/audit-schema.js';
import { validateStoredAiDocumentJob } from '../ai/document-schema.js';
import { questionFeedbackSchema } from '../quality-feedback/schema.js';
import { qualityScanSchema, qualityIssueSchema } from '../content-quality/schema.js';
import { completionEndpoint } from '../ai/provider.js';
import { validateAssetReferences } from '../assets/service.js';
import { validateDocumentCitations } from '../library/sources.js';
const invalid = (message: string): never => {
  throw new Error(`SQLite 备份校验失败：${message}`);
};
export function validateSQLitePrivateRecords(store: Store) {
  const settings = store.database.records<any>('ai_settings');
  if (settings.length > 1) invalid('AI 配置数量无效');
  for (const value of settings) {
    const config = parse(aiSettingsSchema, value);
    if (config.baseUrl) completionEndpoint(config.baseUrl);
    if (config.enabled && (!config.baseUrl || !config.model)) invalid('AI 配置缺少地址或模型');
  }
  for (const value of store.database.records('ai_runs')) {
    if (value?.status === 'failed' || value?.status === 'cancelled') {
      parse(aiFailedRunSchema, value);
      continue;
    }
    const run = parse(storedCompletedAiRunSchema, value);
    if (run.kind === 'grade') {
      const result = parse(completedAiResultSchemas.grade, run.result);
      if (
        result.items.some(
          (item) => item.score != null && item.maxPoints != null && item.score > item.maxPoints,
        )
      )
        invalid('AI 评分超过满分');
      if (
        result.items.some((item) => !run.questionIds.includes(item.questionId)) ||
        new Set(result.items.map((item) => item.questionId)).size !== result.items.length
      )
        invalid('AI 评分的题目引用无效');
    } else if (run.kind === 'similar_questions') {
      const result = parse(completedAiResultSchemas.similar_questions, run.result);
      const candidates = new Set(result.candidates.map((item) => item.id));
      if (
        candidates.size !== result.candidates.length ||
        result.items.some((item) => !candidates.has(item.questionId)) ||
        new Set(result.items.map((item) => item.questionId)).size !== result.items.length
      )
        invalid('AI 近似题推荐的题目引用无效');
    } else if (run.kind === 'review') {
      const result = parse(completedAiResultSchemas.review, run.result);
      if (
        result.items.some((item) => !run.questionIds.includes(item.questionId)) ||
        result.approvedIds.some((qid) => !run.questionIds.includes(qid))
      )
        invalid('AI 审核的题目引用无效');
    } else if (run.kind === 'paper_plan') {
      const result = parse(completedAiResultSchemas.paper_plan, run.result);
      const candidates = new Set(result.candidates.map((item) => item.id));
      if (
        result.items.some((item) => !candidates.has(item.questionId)) ||
        new Set(result.items.map((item) => item.questionId)).size !== result.items.length
      )
        invalid('AI 推荐的题目引用无效');
    }
    // Analysis history can outlive retained attempts and deleted source questions.
    // Its structural IDs/context and managed asset references still must be valid.
    validateAssetReferences(store, run);
  }
  for (const value of store.database.records('ai_import_jobs')) {
    const job = validateStoredAiDocumentJob(value);
    for (const block of job.blocks)
      if (block.sourceCitation)
        validateDocumentCitations(store, { documentLinks: [block.sourceCitation] });
    // Source text is untrusted material, not managed asset markup. Only saved
    // candidate questions participate in the application's asset references.
    validateAssetReferences(
      store,
      job.blocks.flatMap((block) => block.questions),
    );
  }
  for (const value of store.database.records('question_feedback'))
    parse(questionFeedbackSchema, value);
  for (const value of store.database.records('quality_scans')) parse(qualityScanSchema, value);
  for (const value of store.database.records('quality_issues')) parse(qualityIssueSchema, value);
}
