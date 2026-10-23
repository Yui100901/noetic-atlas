import { z } from 'zod';
import type { Paged } from '../../shared/utils/pagination.js';
import { PAGE_SIZES } from '../../shared/utils/pagination.js';
import { parse } from './validation.js';
export const paginationFields = {
  page: z.coerce.number().int().min(1).max(1_000_000).optional(),
  pageSize: z.coerce.number().int().refine(value => (PAGE_SIZES as readonly number[]).includes(value), '每页数量应为10、20、50或100').optional(),
};
/** Unpaged access remains available to internal selectors. */
export function paginate<T>(query: { page?: number; pageSize?: number } | Record<string, unknown>, items: T[]): T[] | Paged<T> {
  if (query.page === undefined && query.pageSize === undefined) return items;
  const input = parse(z.object(paginationFields), query);
  const page = input.page ?? 1, pageSize = input.pageSize ?? 20;
  return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize };
}
