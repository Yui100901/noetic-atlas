export const SEARCH_TYPES = ['question', 'paper', 'document', 'note', 'domain', 'category', 'tag'] as const;
export type SearchType = typeof SEARCH_TYPES[number];
export type SearchSort = 'relevance' | 'updatedAt';
export const SEARCH_TYPE_LABELS: Record<SearchType, string> = { question: '题目', paper: '题集', document: '资料', note: '学习笔记', domain: '领域', category: '分类', tag: '标签' };
export interface SearchItem {
  key: string; type: SearchType; id: string; title: string; excerpt: string; href: string; description: string;
  status?: string; domainIds: string[]; questionId?: string; partId?: string; updatedAt?: string;
  matchIn: 'title' | 'id' | 'content' | 'reference';
}
export interface SearchResponse {
  query: string; type: SearchType | 'all'; sort: SearchSort; includeUnpublished: boolean;
  page: number; pageSize: number; total: number; totalAll: number; counts: Record<SearchType, number>; items: SearchItem[];
  scope: { pdf: 'metadata'; answers: 'match_only'; notes: boolean; excluded: string[] };
}
