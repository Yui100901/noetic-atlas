import type { PaperFilters } from '../../../shared/models/types';

export interface Filters {
  search: string; bankId: string; domainId: string; categoryId: string;
  tagIds: string[]; tagMode: string; type: string; difficulty: string;
  depth: string; frequency: string; collection: string; status: string;
  favorite: boolean; wrong: boolean; due: boolean;
}

export const emptyFilters: Filters = {
  search: '', bankId: '', domainId: '', categoryId: '', tagIds: [],
  tagMode: 'all', type: '', difficulty: '', depth: '', frequency: '',
  collection: '', status: '', favorite: false, wrong: false, due: false,
};

/** Restore only the current filter controls, including their expected value types. */
export function normalizeQuestionFilters(value?: object): Filters {
  const input = (value || {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(emptyFilters).map(([key, fallback]) => {
    const current = input[key];
    if (Array.isArray(fallback)) return [key, Array.isArray(current) ? current.filter(item => typeof item === 'string') : []];
    return [key, typeof current === typeof fallback ? current : fallback];
  })) as unknown as Filters;
}

const paperFilterKeys = [
  'tagIds', 'tagMode', 'categoryId', 'domainId', 'bankId', 'types',
  'difficultyMin', 'difficultyMax', 'frequencyMin', 'collection',
] as const satisfies readonly (keyof PaperFilters)[];

/** Drafts and requests share the same explicit set of supported selection fields. */
export function normalizePaperFilters(value?: object): PaperFilters {
  const input = (value || {}) as Record<string, unknown>;
  return Object.fromEntries(paperFilterKeys
    .filter(key => input[key] !== '' && input[key] !== undefined)
    .map(key => [key, input[key]])) as PaperFilters;
}
