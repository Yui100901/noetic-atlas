import { createHash } from 'node:crypto';
import { base64ToBytes } from '../../../shared/assets/assets.js';
import type { Store } from '../../core/store.js';
import { fail, parse } from '../../core/validation.js';
import { normalizePdfText, PDF_TEXT_VERSION, type PdfCache } from '../../../shared/pdf/text.js';
import { pdfCacheSchema, pdfJobSchema, pdfStoredPageSchema } from './pdf-index-schema.js';
const jobId = (assetId: string) => `pdf-${assetId}`;
/** Restored text is validated independently from the disposable FTS tables. */
export function validatePdfRecords(store: Store) {
  const db = store.database,
    caches = new Map<string, PdfCache>();
  for (const raw of db.records('pdf_caches')) {
    const cache = parse(pdfCacheSchema, raw);
    if (
      cache.id !== `pdf-v${PDF_TEXT_VERSION}-${cache.contentHash}` ||
      cache.processedPages > cache.pageCount ||
      cache.textPages > cache.processedPages ||
      (['ready', 'needs_ocr'].includes(cache.status) &&
        (!cache.pageCount || cache.processedPages !== cache.pageCount)) ||
      (cache.status === 'ready' && !cache.textPages) ||
      (cache.status === 'needs_ocr' && !!cache.textPages) ||
      (cache.status === 'queued' && !!cache.pageCount)
    )
      fail(400, 'PDF_CACHE_INVALID', 'PDF文字缓存状态无效');
    caches.set(cache.id, cache);
  }
  const seen = new Map<string, Set<number>>(),
    textPages = new Map<string, number>();
  for (const raw of db.records('pdf_pages')) {
    const page = parse(pdfStoredPageSchema, raw),
      cache = caches.get(page.cacheId);
    if (!cache) fail(400, 'PDF_PAGE_INVALID', 'PDF缓存引用无效');
    if (
      page.id !== `${cache!.id}:${page.pageNumber}` ||
      page.pageNumber > cache!.processedPages ||
      page.normalized !== normalizePdfText(page.text) ||
      page.items.some(
        (item) =>
          item.end < item.start ||
          item.end > page.text.length ||
          page.text.slice(item.start, item.end) !== item.text,
      )
    )
      fail(400, 'PDF_PAGE_INVALID', 'PDF缓存页或定位无效');
    const pages = seen.get(cache!.id) || new Set();
    pages.add(page.pageNumber);
    seen.set(cache!.id, pages);
    if (page.normalized) textPages.set(cache!.id, (textPages.get(cache!.id) || 0) + 1);
  }
  for (const cache of caches.values())
    if (
      (seen.get(cache!.id)?.size || 0) !== cache.processedPages ||
      (textPages.get(cache!.id) || 0) !== cache.textPages
    )
      fail(400, 'PDF_CACHE_INCOMPLETE', 'PDF缓存页不完整');
  const assetHashes = new Map<string, string>();
  for (const raw of db.records('pdf_jobs')) {
    const job = parse(pdfJobSchema, raw);
    if (
      job.id !== jobId(job.assetId) ||
      !caches.has(job.cacheId) ||
      store.get<any>('assets', job.assetId)?.mimeType !== 'application/pdf'
    )
      fail(400, 'PDF_JOB_INVALID', 'PDF任务引用无效');
    const cache = caches.get(job.cacheId)!;
    // Multiple assets can share a cache. An older queued/paused task may lag
    // behind another task's progress, but cannot claim unprocessed pages or a
    // completed cache that is actually partial.
    if (
      (job.pageCount !== 0 && job.pageCount !== cache.pageCount) ||
      job.nextPage > cache.processedPages + 1 ||
      (job.status === 'complete' &&
        (!['ready', 'needs_ocr'].includes(cache.status) ||
          job.pageCount !== cache.pageCount ||
          job.nextPage !== cache.pageCount + 1)) ||
      (job.status === 'running' && (!job.lease || !job.leaseUntil))
    )
      fail(400, 'PDF_JOB_PROGRESS_INVALID', 'PDF任务进度与缓存不一致');
    let digest = assetHashes.get(job.assetId);
    if (!digest) {
      digest = createHash('sha256')
        .update(
          base64ToBytes(store.require<{ dataBase64: string }>('assets', job.assetId).dataBase64),
        )
        .digest('hex');
      assetHashes.set(job.assetId, digest);
    }
    if (digest !== caches.get(job.cacheId)!.contentHash)
      fail(400, 'PDF_CACHE_HASH_MISMATCH', 'PDF缓存与原始文件不一致');
  }
}
