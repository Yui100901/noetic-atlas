import { createHash, randomUUID } from 'node:crypto';
import { base64ToBytes } from '../../../shared/assets/assets.js';
import type { Store } from '../../core/store.js';
import { fail, parse } from '../../core/validation.js';
import {
  normalizePdfText,
  PDF_TEXT_VERSION,
  type PdfCache,
  type PdfJob,
  type PdfPage,
} from '../../../shared/pdf/text.js';

const stamp = () => new Date().toISOString(),
  jobId = (assetId: string) => `pdf-${assetId}`;
import { pdfControlInputSchema, pdfIngestInputSchema } from './pdf-index-schema.js';

export function queuePdfAsset(store: Store, assetId: string): PdfJob {
  const db = store.database,
    existing = db.getRecord<PdfJob>('pdf_jobs', jobId(assetId));
  if (existing) return existing;
  const asset = store.require<any>('assets', assetId);
  if (asset.mimeType !== 'application/pdf') fail(400, 'PDF_REQUIRED', '请选择PDF资料');
  const contentHash = createHash('sha256').update(base64ToBytes(asset.dataBase64)).digest('hex'),
    cacheId = `pdf-v${PDF_TEXT_VERSION}-${contentHash}`,
    previous = db.getRecord<PdfCache>('pdf_caches', cacheId),
    date = stamp();
  const cache: PdfCache = previous || {
    id: cacheId,
    contentHash,
    extractorVersion: PDF_TEXT_VERSION,
    pageCount: 0,
    processedPages: 0,
    textPages: 0,
    status: 'queued',
    updatedAt: date,
  };
  const ready = ['ready', 'needs_ocr'].includes(cache.status),
    job: PdfJob = {
      id: jobId(assetId),
      assetId,
      cacheId,
      filename: asset.filename || 'PDF',
      status: ready ? 'complete' : 'queued',
      nextPage: cache.processedPages + 1,
      pageCount: cache.pageCount,
      updatedAt: date,
    };
  db.transaction(() => {
    if (!previous) db.putRecord('pdf_caches', cacheId, cache);
    db.putRecord('pdf_jobs', job.id, job);
  });
  return job;
}
export function queueDocumentPdf(
  store: Store,
  document: { format?: string; assetId?: string | null },
) {
  if (document.format === 'pdf' && document.assetId) queuePdfAsset(store, document.assetId);
}
export function listPdfJobs(store: Store) {
  return store.database
    .records<PdfJob>('pdf_jobs')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((job) => ({
      ...job,
      lease: undefined,
      cache: store.database.getRecord<PdfCache>('pdf_caches', job.cacheId),
    }));
}
function requireJob(store: Store, id: string) {
  const job = store.database.getRecord<PdfJob>('pdf_jobs', id);
  if (!job) fail(404, 'PDF_JOB_NOT_FOUND', 'PDF索引任务不存在');
  return job!;
}
function requireLease(store: Store, id: string, lease: string) {
  const job = requireJob(store, id);
  if (
    job.status !== 'running' ||
    job.lease !== lease ||
    !job.leaseUntil ||
    job.leaseUntil < stamp()
  )
    fail(409, 'PDF_LEASE_EXPIRED', 'PDF任务已暂停或由另一个页面接管');
  return job;
}
export function claimPdfJob(store: Store, id: string) {
  const db = store.database;
  return db.transaction(() => {
    const job = requireJob(store, id),
      cache = db.getRecord<PdfCache>('pdf_caches', job.cacheId)!;
    if (['ready', 'needs_ocr'].includes(cache.status)) {
      const done = {
        ...job,
        status: 'complete' as const,
        nextPage: cache.pageCount + 1,
        pageCount: cache.pageCount,
        updatedAt: stamp(),
        lease: undefined,
        leaseUntil: undefined,
      };
      db.putRecord('pdf_jobs', id, done);
      return done;
    }
    if (!['queued', 'running'].includes(job.status))
      fail(409, 'PDF_JOB_NOT_QUEUED', '请先继续或重试该任务');
    const busy = db
      .records<PdfJob>('pdf_jobs')
      .some(
        (other) =>
          other.cacheId === job.cacheId &&
          other.status === 'running' &&
          other.leaseUntil! >= stamp(),
      );
    if (busy) fail(409, 'PDF_JOB_BUSY', '该文件正在其他页面建立索引');
    const next = {
      ...job,
      status: 'running' as const,
      nextPage: cache.processedPages + 1,
      pageCount: cache.pageCount,
      lease: randomUUID(),
      leaseUntil: new Date(Date.now() + 120000).toISOString(),
      updatedAt: stamp(),
      error: undefined,
    };
    db.putRecord('pdf_jobs', id, next);
    return next;
  });
}
export function controlPdfJob(store: Store, id: string, body: unknown) {
  const input = parse(pdfControlInputSchema, body),
    job = requireJob(store, id);
  if (input.action === 'fail' || input.action === 'release')
    requireLease(store, id, input.lease || '');
  const next: PdfJob = {
    ...job,
    status:
      input.action === 'pause'
        ? 'paused'
        : input.action === 'cancel'
          ? 'cancelled'
          : input.action === 'fail'
            ? 'failed'
            : 'queued',
    error: input.action === 'fail' ? input.error || 'PDF解析失败' : undefined,
    lease: undefined,
    leaseUntil: undefined,
    updatedAt: stamp(),
  };
  store.database.putRecord('pdf_jobs', id, next);
  return next;
}
export function ingestPdfPages(store: Store, id: string, body: unknown) {
  const input = parse(pdfIngestInputSchema, body),
    db = store.database;
  return db.transaction(() => {
    const job = requireLease(store, id, input.lease),
      cache = db.getRecord<PdfCache>('pdf_caches', job.cacheId)!;
    if (cache.pageCount && cache.pageCount !== input.pageCount)
      fail(409, 'PDF_PAGE_COUNT_CHANGED', '文件页数不一致，请重新建立索引');
    let next = cache.processedPages + 1,
      textPages = cache.textPages;
    for (const page of input.pages) {
      if (page.pageNumber !== next || page.pageNumber > input.pageCount)
        fail(409, 'PDF_PAGE_SEQUENCE', '索引页码不连续，请从保存进度继续');
      if (
        page.items.some(
          (item) =>
            item.end < item.start ||
            item.end > page.text.length ||
            page.text.slice(item.start, item.end) !== item.text,
        )
      )
        fail(400, 'PDF_ITEM_RANGE', '文字定位范围无效');
      const record: PdfPage = {
        ...page,
        id: `${cache!.id}:${page.pageNumber}`,
        cacheId: cache.id,
        normalized: normalizePdfText(page.text),
      };
      db.putRecord('pdf_pages', record.id, record);
      db.pdf.put(record);
      if (record.normalized) textPages++;
      next++;
    }
    const complete = input.complete && next === input.pageCount + 1;
    if (input.complete && !complete) fail(409, 'PDF_INCOMPLETE', '仍有未处理的PDF页面');
    const date = stamp(),
      updated: PdfCache = {
        ...cache,
        pageCount: input.pageCount,
        processedPages: next - 1,
        textPages,
        status: complete ? (textPages ? 'ready' : 'needs_ocr') : 'indexing',
        updatedAt: date,
      },
      updatedJob: PdfJob = {
        ...job,
        pageCount: input.pageCount,
        nextPage: next,
        status: complete ? 'complete' : 'running',
        lease: complete ? undefined : job.lease,
        leaseUntil: complete ? undefined : new Date(Date.now() + 120000).toISOString(),
        updatedAt: date,
      };
    db.putRecord('pdf_caches', cache.id, updated);
    db.putRecord('pdf_jobs', id, updatedJob);
    return updatedJob;
  });
}
export function searchPdfAsset(
  store: Store,
  assetId: string,
  query: string,
  page = 1,
  pageSize = 20,
) {
  const job = store.database.getRecord<PdfJob>('pdf_jobs', jobId(assetId));
  return {
    job: job ? { ...job, lease: undefined } : null,
    cache: job ? store.database.getRecord<PdfCache>('pdf_caches', job.cacheId) : null,
    ...(job
      ? store.database.pdf.search(job.cacheId, query, (page - 1) * pageSize, pageSize)
      : { total: 0, hits: [] }),
    page,
    pageSize,
  };
}
