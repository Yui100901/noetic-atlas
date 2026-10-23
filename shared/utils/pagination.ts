export const PAGE_SIZES = [10, 20, 50, 100] as const;
export interface Paged<T> { items: T[]; total: number; page: number; pageSize: number }
