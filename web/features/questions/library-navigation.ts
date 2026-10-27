import { PAGE_SIZES } from '../../../shared/utils/pagination';
import { emptyFilters, normalizeQuestionFilters, type Filters } from '../../shared/lib/learning-filters';

export interface LibraryLocation { filters: Filters; page: number; pageSize: number }
const id = /^[\p{L}\p{N}_.:-]{1,160}$/u;
const choices: Partial<Record<keyof Filters, readonly string[]>> = {
  type: ['short_answer','true_false','single_choice','multiple_choice','fill_blank','essay','group'],
  difficulty: ['1','2','3','4'], depth: ['1','2','3','4'], frequency: ['0','1','2','3'],
  collection: ['general','personal'], status: ['pending','draft','archived','all','published'], tagMode: ['all','any'],
};
export function readLibraryLocation(hash: string, fallback: Partial<Filters> = {}): LibraryLocation {
  const filters = normalizeQuestionFilters(fallback);
  if (hash.split('?')[0] !== '#/questions') return {filters,page:1,pageSize:20};
  const params = new URLSearchParams(hash.split('?')[1] || '');
  for (const key of Object.keys(emptyFilters) as Array<keyof Filters>) {
    const value = params.get(key); if (value === null) continue;
    if (key === 'tagIds') filters.tagIds = [...new Set(value.split(',').filter(value => id.test(value)))].slice(0,100);
    else if (key === 'favorite' || key === 'wrong' || key === 'due') filters[key] = value === 'true' || value === '1';
    else if (key === 'domainId' || key === 'categoryId') filters[key] = id.test(value) ? value : '';
    else if (key === 'search') filters.search = value.slice(0,500);
    else if (choices[key]?.includes(value)) filters[key] = value;
    else filters[key] = emptyFilters[key] as never;
  }
  const page = Number(params.get('page') || 1), size = Number(params.get('pageSize') || 20);
  return {filters,page:Number.isSafeInteger(page) && page > 0 && page <= 1_000_000 ? page : 1,pageSize:(PAGE_SIZES as readonly number[]).includes(size) ? size : 20};
}
export function libraryLocation(filters: Filters, page = 1, pageSize = 20): string {
  const params = new URLSearchParams();
  for (const [key,value] of Object.entries(filters)) {
    if (key === 'tagMode' && value === 'all' || value === '' || value === false || Array.isArray(value) && !value.length) continue;
    params.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  if (page !== 1) params.set('page',String(page)); if (pageSize !== 20) params.set('pageSize',String(pageSize));
  return '#/questions' + (params.size ? '?' + params : '');
}
export function safeLibraryReturn(value: string | null | undefined): string {
  if (!value || value.length > 20000 || value.split('?')[0] !== '#/questions') return '#/questions';
  const state = readLibraryLocation(value); return libraryLocation(state.filters,state.page,state.pageSize);
}
export const libraryReturnFromHash = (hash: string) => safeLibraryReturn(new URLSearchParams(hash.split('?')[1] || '').get('returnTo'));
export function libraryQuestionHref(questionId: string, returnTo = '#/questions', edit = false): string {
  const back = safeLibraryReturn(returnTo);
  return `#/questions/${encodeURIComponent(questionId)}${edit ? '/edit' : ''}${back === '#/questions' ? '' : '?returnTo=' + encodeURIComponent(back)}`;
}
export function rememberLibraryScroll(returnTo: string) { try { sessionStorage.setItem('noetic-atlas:library-scroll:' + safeLibraryReturn(returnTo),String(Math.max(0,window.scrollY))); } catch { /* URL state does not depend on storage. */ } }
export function libraryScroll(returnTo: string): number { try { const value = Number(sessionStorage.getItem('noetic-atlas:library-scroll:' + safeLibraryReturn(returnTo)) || 0); return Number.isFinite(value) && value >= 0 ? Math.min(value,10_000_000) : 0; } catch { return 0; } }
