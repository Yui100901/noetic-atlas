import { z } from 'zod';
import { dataPackageKinds } from '../../../shared/models/data-packages.js';
import { DATA_PACKAGE_LIMITS } from '../../../shared/packages/schema.js';
import { id } from '../../core/validation.js';
import { configurationPreviewSchema } from '../settings/configuration.js';
import { shareSelectionSchema } from '../sharing/schema.js';

const MiB = 1024 * 1024;
export const PACKAGE_HTTP_BODY_LIMIT = 192 * MiB;
const packageKindSchema = z.enum(dataPackageKinds);
export const packageExportSchema = z
  .object({
    kind: z.enum(['share', 'migration', 'configuration', 'question-template', 'question-update']),
    selection: shareSelectionSchema.optional(),
    includeAi: z.boolean().optional(),
    ids: z.array(id).min(1).max(500).optional(),
  })
  .strict();
const base64Schema = z
  .string()
  .min(4)
  .max(Math.ceil(DATA_PACKAGE_LIMITS.maxBytes / 3) * 4)
  .refine(
    (value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value),
    '数据包编码无效',
  );
export const packagePreviewInputSchema = z.object({ dataBase64: base64Schema }).strict();
export const packageImportInputSchema = packagePreviewInputSchema
  .extend({
    expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    confirmed: z.literal(true),
    confirmedRetention: z.literal(true).optional(),
    confirmedTrusted: z.literal(true).optional(),
  })
  .strict();
const countSchema = z
  .object({
    added: z.number().int().nonnegative(),
    reused: z.number().int().nonnegative(),
    remapped: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  })
  .strict();
export const packageFileSchema = z
  .object({
    filename: z.string(),
    mimeType: z.literal('application/zip'),
    dataBase64: z.string(),
    byteLength: z.number().int().nonnegative(),
  })
  .strict();
export const packagePreviewSchema = z
  .object({
    kind: packageKindSchema,
    title: z.string(),
    fingerprint: z.string(),
    counts: z.record(z.string(), countSchema),
    warnings: z.array(z.string()),
    details: configurationPreviewSchema.optional(),
    questions: z
      .array(
        z
          .object({ id: z.string(), title: z.string(), status: z.enum(['pending', 'reused']) })
          .strict(),
      )
      .optional(),
  })
  .strict();
export const packageImportResultSchema = packagePreviewSchema
  .extend({ ok: z.literal(true), result: z.unknown() })
  .strict();
