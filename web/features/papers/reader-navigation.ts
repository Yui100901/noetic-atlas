import { PAGE_SIZES } from '../../../shared/utils/pagination';

export interface PaperContentsContext { search: string; page: number; pageSize: number }

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE = 1_000_000;
const MAX_SEARCH_LENGTH = 1000;

/** URLSearchParams converts malformed surrogate sequences to well-formed
 * Unicode without interpreting the text as a route or nested return URL. */
const unicodeText = (value: string) => new URLSearchParams({ value }).get('value')!;
const pathPart = (value: string) => encodeURIComponent(unicodeText(value));

function searchText(value: unknown): string {
  if (typeof value !== 'string') return '';
  let bounded = value.slice(0, MAX_SEARCH_LENGTH);
  const last = bounded.charCodeAt(bounded.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) bounded = bounded.slice(0, -1);
  return unicodeText(bounded);
}

export function normalizePaperContentsContext(input: Partial<PaperContentsContext> = {}): PaperContentsContext {
  return {
    search: searchText(input.search),
    page: Number.isSafeInteger(input.page) && input.page! > 0 && input.page! <= MAX_PAGE ? input.page! : 1,
    pageSize: PAGE_SIZES.includes(input.pageSize as typeof PAGE_SIZES[number]) ? input.pageSize! : DEFAULT_PAGE_SIZE,
  };
}

/** Repeated known parameters are ambiguous, so that field falls back to its
 * default. Unknown parameters, including returnTo, never enter this context. */
export function readPaperContentsContext(params: URLSearchParams): PaperContentsContext {
  const one = (name: string) => { const values = params.getAll(name); return values.length === 1 ? values[0] : undefined; };
  const integer = (value: string | undefined) => value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;
  return normalizePaperContentsContext({
    search: one('contentsSearch'), page: integer(one('contentsPage')), pageSize: integer(one('contentsPageSize')),
  });
}

function contextParams(context: Partial<PaperContentsContext>): URLSearchParams {
  const value = normalizePaperContentsContext(context), params = new URLSearchParams();
  if (value.search) params.set('contentsSearch', value.search);
  if (value.page !== 1) params.set('contentsPage', String(value.page));
  if (value.pageSize !== DEFAULT_PAGE_SIZE) params.set('contentsPageSize', String(value.pageSize));
  return params;
}

export function paperContentsHref(paperId: string, context: Partial<PaperContentsContext> = {}): string {
  const params = new URLSearchParams({ tab: 'content' });
  for (const [key, value] of contextParams(context)) params.set(key, value);
  return `#/papers/${pathPart(paperId)}?${params.toString()}`;
}

/** The context restores only the originating list. Reader previous/next
 * selection must use the complete saved order of the current question set. */
export function paperQuestionHref(paperId: string, questionId: string, context: Partial<PaperContentsContext> = {}): string {
  const params = contextParams(context);
  return `#/papers/${pathPart(paperId)}/questions/${pathPart(questionId)}${params.size ? '?' + params.toString() : ''}`;
}
