import type { DocumentCitation } from '../../../shared/models/document-citations';
import { contentReturn } from '../../shared/lib/content-navigation';

export function documentSourceHref(citation: DocumentCitation, back = '#/documents'): string {
  if (!citation.documentId || !citation.versionId) return '#/documents';
  const params = new URLSearchParams({
    version: citation.versionId,
    returnTo: contentReturn(back),
  });
  if (citation.pageStart) params.set('page', String(citation.pageStart));
  if (citation.startOffset !== undefined && citation.endOffset !== undefined) {
    params.set('start', String(citation.startOffset));
    params.set('end', String(citation.endOffset));
  }
  return `#/documents/${encodeURIComponent(citation.documentId)}/source?${params}`;
}
export function sourceLocation(params: URLSearchParams) {
  const start = Number(params.get('start')),
    end = Number(params.get('end')),
    page = Number(params.get('page'));
  const range =
    params.has('start') &&
    params.has('end') &&
    Number.isSafeInteger(start) &&
    start >= 0 &&
    Number.isSafeInteger(end) &&
    end > start &&
    end <= 50 * 1024 * 1024
      ? { start, end }
      : undefined;
  return { range, page: Number.isSafeInteger(page) && page > 0 && page <= 100000 ? page : 1 };
}
