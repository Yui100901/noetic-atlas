import type { ExportPreflight } from '../models/export-preflight.js';
import { DATA_PACKAGE_LIMITS } from './schema.js';

export const EXPORT_MAX_QUESTIONS = 50000;
export interface ExportBudgetMetrics {
  questionCount: number;
  jsonBytes: number;
  attachmentBytes: number;
  largestFileBytes: number;
  fileCount: number;
  payloadCount: number;
}

/** The writer uses STORE when DEFLATE is larger. Account for manifest and ZIP
 * headers too, so a successful preflight never relies on assumed compression. */
export function exportBudget(
  metrics: ExportBudgetMetrics,
  purpose: 'content' | 'backup' = 'content',
  limits = DATA_PACKAGE_LIMITS,
): ExportPreflight {
  const manifestBytes = 4096 + metrics.fileCount * 512 + metrics.payloadCount * 1024;
  const estimatedExpandedBytes = metrics.jsonBytes + metrics.attachmentBytes;
  const estimatedZipBytes = estimatedExpandedBytes + manifestBytes + metrics.fileCount * 512 + 22;
  const reasons: string[] = [];
  if (metrics.questionCount > EXPORT_MAX_QUESTIONS)
    reasons.push(`单次最多导出${EXPORT_MAX_QUESTIONS}题，当前选择${metrics.questionCount}题。`);
  if (metrics.largestFileBytes > limits.maxFileBytes)
    reasons.push('单个数据分片或附件可能超过80MiB上限；正文可按领域分片，单个过大附件需先缩小。');
  if (estimatedExpandedBytes > limits.maxExpandedBytes)
    reasons.push('估算解压内容超过256MiB上限。');
  if (estimatedZipBytes > limits.maxBytes)
    reasons.push('保守估算的ZIP体积可能超过128MiB上限；尚未生成文件。');
  if (metrics.fileCount > limits.maxFiles || metrics.payloadCount > limits.maxPayloads)
    reasons.push('附件文件或数据分片数量超过单包上限。');
  if (manifestBytes > limits.maxManifestBytes)
    reasons.push('附件和分片数量可能使manifest清单超过2MiB上限。');
  return {
    allowed: reasons.length === 0,
    questionCount: metrics.questionCount,
    estimatedExpandedBytes,
    estimatedZipBytes,
    attachmentBytes: metrics.attachmentBytes,
    estimatedFiles: metrics.fileCount,
    maxQuestions: EXPORT_MAX_QUESTIONS,
    estimateIsUpperBound: true,
    reasons,
    recommendations: !reasons.length
      ? []
      : purpose === 'backup'
        ? [
            {
              label: '到系统迁移导出SQLite数据库（保留完整学习数据）',
              href: '#/settings?tab=backup&sub=migration',
            },
            { label: '只需要题目：按领域少量分次分享', href: '#/sharing?tab=export' },
          ]
        : [
            {
              label: '按领域缩小范围或分组导出（总量超限仍需分次）',
              href: '#/sharing?tab=export',
            },
            { label: '返回题库缩小领域、分类或题型筛选后再导出', href: '#/questions' },
            { label: '检查和缩小过大的题内附件', href: '#/settings?tab=assets&sub=files' },
          ],
  };
}
