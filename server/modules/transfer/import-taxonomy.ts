import { z } from 'zod';
import type { ImportTaxonomyMapping } from '../../../shared/models/import-taxonomy.js';
import { id } from '../../core/validation.js';

const entry = z
  .object({
    sourceId: id,
    targetId: id.optional(),
    name: z.string().trim().min(1).max(160).optional(),
  })
  .strict()
  .refine((value) => !(value.targetId && value.name), '目标映射与新名称不能同时填写');
const entries = z
  .array(entry)
  .max(50000)
  .refine(
    (values) => new Set(values.map((value) => value.sourceId)).size === values.length,
    '来源归类不能重复映射',
  );
export const importTaxonomyMappingSchema = z
  .object({ domains: entries.optional(), categories: entries.optional(), tags: entries.optional() })
  .strict();
export const mappingEntries = (
  mapping: ImportTaxonomyMapping | undefined,
  table: 'domains' | 'categories' | 'tags',
) => new Map((mapping?.[table] || []).map((value) => [value.sourceId, value]));
