import type { SearchType, SearchSort } from '../../../shared/models/search';

export interface SearchState {
  q: string; type: 'all' | SearchType; sort: SearchSort; includeUnpublished: boolean; page: number; pageSize: number;
}
export const searchTypeLabels: Record<SearchType, string> = {
  question: '题目', paper: '题集', document: '资料', note: '笔记', domain: '领域', category: '分类', tag: '标签',
};
export const searchTypes = Object.keys(searchTypeLabels) as SearchType[];

export function readSearchState(hash: string): SearchState {
  const index = hash.indexOf('?'), query = new URLSearchParams(index < 0 ? '' : hash.slice(index + 1));
  const type = query.get('type') || 'all', page = Number(query.get('page') || 1), pageSize = Number(query.get('pageSize') || 20);
  return {
    q: query.get('q') || '', type: searchTypes.includes(type as SearchType) ? type as SearchType : 'all',
    sort: query.get('sort') === 'updatedAt' ? 'updatedAt' : 'relevance', includeUnpublished: query.get('includeUnpublished') === 'true',
    page: Number.isInteger(page) && page > 0 && page <= 1_000_000 ? page : 1,
    pageSize: [10, 20, 50, 100].includes(pageSize) ? pageSize : 20,
  };
}

export function searchHref(state: SearchState): string {
  const query = new URLSearchParams();
  if (state.q.trim()) query.set('q', state.q.trim());
  if (state.type !== 'all') query.set('type', state.type);
  if (state.sort !== 'relevance') query.set('sort', state.sort);
  if (state.includeUnpublished) query.set('includeUnpublished', 'true');
  if (state.page !== 1) query.set('page', String(state.page));
  if (state.pageSize !== 20) query.set('pageSize', String(state.pageSize));
  return '#/search' + (query.size ? '?' + query.toString() : '');
}

/** The only return destination is this app's search page; arbitrary URLs and
 * nested redirects are discarded rather than copied into navigation. */
export function searchReturnTarget(hash: string): string | null {
  const index = hash.indexOf('?'); if (index < 0 || /^#\/search(?:\?|$)/.test(hash)) return null;
  const target = new URLSearchParams(hash.slice(index + 1)).get('returnTo');
  if (!target || target.length > 3000 || !/^#\/search(?:\?|$)/.test(target)) return null;
  const state = readSearchState(target); if (state.q.length > 100) return null;
  return searchHref(state);
}

export function searchResultHref(href: string, current: SearchState): string | null {
  if (!/^#\/[\w-]+(?:[/?]|$)/.test(href)) return null;
  const index = href.indexOf('?'), route = index < 0 ? href : href.slice(0, index);
  const query = new URLSearchParams(index < 0 ? '' : href.slice(index + 1));
  query.set('returnTo', searchHref(current)); return route + '?' + query.toString();
}

export function searchInputError(q: string): string {
  if (q.length > 100) return '搜索关键词最多100个字符。';
  if (q.normalize('NFKC').trim().split(/\s+/u).filter(Boolean).length > 8) return '一次最多输入8个关键词，使用空格分隔。';
  return '';
}

/** Map normalized matches back to the original graphemes. Rendering stays plain
 * React text, including literal HTML and full-width/ligature characters. */
export function searchHighlights(text: string, query: string): Array<{ text: string; matched: boolean }> {
  const tokens = [...new Set(query.normalize('NFKC').toLowerCase().trim().split(/\s+/u).filter(Boolean))].slice(0, 8);
  if (!text || !tokens.length) return [{ text, matched: false }];
  const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)];
  let normalized = ''; const starts: number[] = [], ends: number[] = [];
  for (const segment of segments) {
    const value = segment.segment.normalize('NFKC').toLowerCase();
    normalized += value;
    for (let index = 0; index < value.length; index++) { starts.push(segment.index); ends.push(segment.index + segment.segment.length); }
  }
  const ranges: Array<[number, number]> = [];
  for (const token of tokens) for (let at = normalized.indexOf(token); at >= 0; at = normalized.indexOf(token, at + Math.max(1, token.length))) ranges.push([starts[at]!, ends[at + token.length - 1]!]);
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) { const last = merged[merged.length - 1]; if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]); else merged.push([...range]); }
  const output: Array<{ text: string; matched: boolean }> = []; let cursor = 0;
  for (const [start, end] of merged) { if (start > cursor) output.push({ text: text.slice(cursor, start), matched: false }); output.push({ text: text.slice(start, end), matched: true }); cursor = end; }
  if (cursor < text.length) output.push({ text: text.slice(cursor), matched: false });
  return output.length ? output : [{ text, matched: false }];
}
