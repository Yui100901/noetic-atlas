import { z } from 'zod';
import { SEARCH_TYPES } from '../../../shared/models/search.js';
import { paginationFields } from '../../core/pagination.js';

export const searchQuerySchema = z.object({
  q: z.string().trim().max(100, '搜索词最多100个字符').default('').refine(value => value.normalize('NFKC').trim().split(/\s+/u).filter(Boolean).length <= 8, '一次最多8个搜索词，请用空格分隔'),
  type: z.enum(['all', ...SEARCH_TYPES]).default('all'),
  sort: z.enum(['relevance', 'updatedAt']).default('relevance'),
  includeUnpublished: z.enum(['true', 'false']).default('false'),
  page: paginationFields.page.default(1), pageSize: paginationFields.pageSize.default(20),
}).strict();
export type SearchQuery = z.infer<typeof searchQuerySchema>;
