import { z } from 'zod';
import type { SharePackage } from '../../../shared/models/sharing.js';
import {
  id,
  fail,
  domainSchema,
  categorySchema,
  tagSchema,
  questionSchema,
  questionBankSchema,
  storedScoringSchema,
  gradingRequirementsSchema,
  questionGradingRequirementsSchema,
} from '../../core/validation.js';
import { assetRecordSchema } from '../assets/schema.js';

export const shareQuestionSchema = questionSchema.safeExtend({ id });
const shareQuestion = shareQuestionSchema;
const paperSchema = z
  .object({
    id,
    title: z.string().min(1).max(300),
    description: z.string().max(500000),
    gradingRequirements: gradingRequirementsSchema.optional(),
    questionGradingRequirements: questionGradingRequirementsSchema.optional(),
    inheritedGradingRequirements: questionGradingRequirementsSchema.optional(),
    mode: z.enum(['manual', 'random']),
    practiceKind: z.enum(['standard', 'vocabulary', 'concept']).optional(),
    legacyBankId: id.optional(),
    questionIds: z.array(id).max(50000),
    questionCount: z.number().int().min(0).max(50000),
    archived: z.boolean(),
    version: z.number().int().min(1),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    scoring: storedScoringSchema.optional(),
    snapshot: z.array(shareQuestion).max(50000),
    organization: z.enum(['domain', 'other']).optional(),
    domainId: id.nullable().optional(),
    filters: z.null().default(null),
  })
  .strict();
/** The same admission contract validates both producers and recipients. */
export const sharePackageSchema = z
  .object({
    format: z.literal('learning-share'),
    schemaVersion: z.literal(1),
    exportedAt: z.string().datetime({ offset: true }),
    title: z.string().min(1).max(300),
    domains: z.array(domainSchema.extend({ id })).max(10000),
    categories: z.array(categorySchema.extend({ id })).max(50000),
    tags: z.array(tagSchema.extend({ id })).max(50000),
    assets: z.array(assetRecordSchema).max(10000),
    questions: z.array(shareQuestion).max(50000),
    papers: z.array(paperSchema).max(100),
    questionBanks: z.array(questionBankSchema.safeExtend({ id })).max(100).default([]),
  })
  .strict();

/** Never hand the user a package that the ordinary share importer will reject. */
export function validateShareExport(value: unknown): SharePackage {
  const result = sharePackageSchema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    fail(
      422,
      'CONTENT_EXPORT_INVALID_SHARE',
      '分享封包不满足接收方导入规则，请减少所选领域或题内附件，或改用完整 SQLite 迁移；详细原因见字段校验信息',
      details,
    );
  }
  return result.data as SharePackage;
}
