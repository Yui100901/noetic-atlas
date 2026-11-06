import type { Category, Domain, Tag } from './types.js';

export interface ImportTaxonomyEntry {
  sourceId: string;
  targetId?: string;
  name?: string;
}
export interface ImportTaxonomyMapping {
  domains?: ImportTaxonomyEntry[];
  categories?: ImportTaxonomyEntry[];
  tags?: ImportTaxonomyEntry[];
}
export interface ImportTaxonomyCatalog {
  domains: Domain[];
  categories: Category[];
  tags: Tag[];
}
