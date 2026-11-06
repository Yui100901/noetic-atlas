import { z } from 'zod';
import { exportPreflightSchema } from './export-preflight-schema.js';
import { id } from '../../core/validation.js';

const selectionFields = {
  domainIds: z
    .array(id)
    .max(10000)
    .refine((values) => values.length === new Set(values).size, '领域不能重复'),
  purpose: z.enum(['migration', 'share']).optional(),
  mode: z.enum(['combined', 'per_domain']).optional(),
  status: z.enum(['all', 'published', 'pending', 'draft', 'archived']).optional(),
  collection: z.enum(['all', 'general', 'personal']).optional(),
};
export const contentExportSelectionSchema = z.object(selectionFields).strict();
export const contentExportBuildSchema = z
  .object({ ...selectionFields, expectedFingerprint: z.string().length(64) })
  .strict();
const scope = z
  .object({
    ...selectionFields,
    purpose: z.enum(['migration', 'share']),
    mode: z.enum(['combined', 'per_domain']),
    status: z.enum(['all', 'published', 'pending', 'draft', 'archived']),
    collection: z.enum(['all', 'general', 'personal']),
  })
  .strict();
const domain = z
  .object({ id, name: z.string(), questionCount: z.number().int().nonnegative() })
  .strict();
export const contentExportPreviewSchema = z
  .object({
    preflight: exportPreflightSchema,
    fingerprint: z.string().length(64),
    scope,
    domains: z.array(domain),
    selectedDomains: z.array(domain),
    questionCount: z.number().int().nonnegative(),
    memberships: z.number().int().nonnegative(),
    emptyDomainIds: z.array(id),
    estimatedQuestionBytes: z.number().int().nonnegative(),
    categories: z.number().int().nonnegative(),
    tags: z.number().int().nonnegative(),
    limits: z
      .object({
        maxQuestions: z.number().int(),
        maxPackageBytes: z.number().int(),
        maxCombinedBytes: z.number().int(),
        maxPartQuestions: z.number().int(),
        maxPartBytes: z.number().int(),
      })
      .strict(),
    warnings: z.array(z.string()),
  })
  .strict();
export const contentExportFileSchema = z
  .object({
    filename: z.string(),
    mimeType: z.literal('application/zip'),
    dataBase64: z.string(),
    byteLength: z.number().int().nonnegative(),
    summary: z
      .object({
        questionCount: z.number().int().nonnegative(),
        domainCount: z.number().int().nonnegative(),
        fileCount: z.number().int().nonnegative(),
        purpose: z.enum(['migration', 'share']),
        mode: z.enum(['combined', 'per_domain']),
      })
      .strict(),
  })
  .strict();
