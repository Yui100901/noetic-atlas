import { z } from 'zod';
import { PDF_TEXT_VERSION } from '../../../shared/pdf/text.js';
export const pdfItemSchema = z.object({
  text: z.string().max(100000),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
});
export const pdfPageInputSchema = z.object({
  pageNumber: z.number().int().min(1).max(100000),
  text: z.string().max(1000000),
  width: z.number().positive().max(100000),
  height: z.number().positive().max(100000),
  items: z.array(pdfItemSchema).max(100000),
});
export const pdfCacheSchema = z.object({
  id: z.string(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  extractorVersion: z.literal(PDF_TEXT_VERSION),
  pageCount: z.number().int().nonnegative().max(100000),
  processedPages: z.number().int().nonnegative(),
  textPages: z.number().int().nonnegative(),
  status: z.enum(['queued', 'indexing', 'ready', 'needs_ocr']),
  updatedAt: z.string().datetime(),
});
export const pdfJobSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  cacheId: z.string(),
  filename: z.string(),
  status: z.enum(['queued', 'running', 'paused', 'complete', 'failed', 'cancelled']),
  nextPage: z.number().int().min(1),
  pageCount: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
  error: z.string().optional(),
  lease: z.string().optional(),
  leaseUntil: z.string().datetime().optional(),
});
export const pdfStoredPageSchema = pdfPageInputSchema.extend({
  id: z.string(),
  cacheId: z.string(),
  normalized: z.string().max(1000000),
});
export const pdfQueueInputSchema = z
  .object({ assetId: z.string().min(1).max(4096).optional(), all: z.boolean().optional() })
  .strict()
  .refine((input) => input.all || !!input.assetId, '请选择一个PDF或现有PDF批量索引');
export const pdfControlInputSchema = z
  .object({
    action: z.enum(['pause', 'resume', 'retry', 'cancel', 'fail', 'release']),
    error: z.string().max(2000).optional(),
    lease: z.string().optional(),
  })
  .strict();
export const pdfIngestInputSchema = z
  .object({
    lease: z.string(),
    pageCount: z.number().int().min(1).max(100000),
    pages: z.array(pdfPageInputSchema).max(8),
    complete: z.boolean().default(false),
  })
  .strict();
export const pdfSearchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(100),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
