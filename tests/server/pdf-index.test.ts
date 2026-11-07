import { validatePdfRecords } from '../../server/modules/library/pdf-index-validation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { Store } from '../../server/core/store.js';
import { createAsset } from '../../server/modules/assets/service.js';
import { createDocument, updateDocument } from '../../server/modules/library/service.js';
import {
  claimPdfJob,
  controlPdfJob,
  ingestPdfPages,
  queuePdfAsset,
  searchPdfAsset,
} from '../../server/modules/library/pdf-index-service.js';
import { unifiedSearch } from '../../server/modules/search/service.js';
import { searchQuerySchema } from '../../server/modules/search/schema.js';
import {
  exportSQLiteMigration,
  sqliteMigrationPlan,
} from '../../server/modules/transfer/sqlite-migration.js';
import {
  normalizePdfText,
  pdfMatchingItems,
  pdfSearchTokens,
  type PdfJob,
} from '../../shared/pdf/text.js';
async function fixture(t: test.TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText('PDF source fixture', { font });
  const asset = createAsset(store, {
    filename: 'textbook.pdf',
    mimeType: 'application/pdf',
    dataBase64: Buffer.from(await pdf.save()).toString('base64'),
  });
  return { store, asset };
}
const page = (pageNumber: number, text: string) => ({
  pageNumber,
  text,
  width: 600,
  height: 800,
  items: text ? [{ text, start: 0, end: text.length, x: 30, y: 750, width: 200, height: 12 }] : [],
});
function finish(store: Store, job: PdfJob, texts: string[]) {
  const claimed = claimPdfJob(store, job.id);
  ingestPdfPages(store, job.id, {
    lease: claimed.lease,
    pageCount: texts.length,
    pages: texts.map((text, i) => page(i + 1, text)),
    complete: true,
  });
  return claimed;
}

test('PDF FTS supports CJK singles/bigrams, verifies phrases, and binds hostile query input', async (t) => {
  const { store, asset } = await fixture(t),
    job = queuePdfAsset(store, asset.id);
  finish(store, job, [
    '沉 没 成 本是无法回收的支出。Opportunity COST.',
    '成本影响决策，沉没只是另一个词。',
    'Java Spring transactions. TCP/IP protocols.',
  ]);
  assert.equal(normalizePdfText('沉 没 成 本'), '沉没成本');
  assert.ok(pdfSearchTokens('沉没成本').includes('没成'));
  assert.equal(searchPdfAsset(store, asset.id, '沉没成本').total, 1);
  assert.equal(searchPdfAsset(store, asset.id, '沉').total, 2);
  assert.equal(searchPdfAsset(store, asset.id, 'opportunity cost').total, 1);
  assert.equal(searchPdfAsset(store, asset.id, 'COST').hits[0]?.pageNumber, 1);
  assert.equal(searchPdfAsset(store, asset.id, 'opport').total, 1);
  assert.equal(searchPdfAsset(store, asset.id, 'java spring').total, 1);
  assert.equal(searchPdfAsset(store, asset.id, 'TCP IP').total, 1);
  assert.equal(searchPdfAsset(store, asset.id, '" OR 1=1 --').total, 0);
  assert.equal(searchPdfAsset(store, asset.id, '%_').total, 0);
  const indexes = pdfMatchingItems([{ text: '沉' }, { text: '没' }, { text: '成本' }], '沉没成本');
  assert.deepEqual([...indexes], [0, 1, 2]);
  validatePdfRecords(store);
});
test('leased PDF checkpoints pause safely, reject stale writers, resume without duplicate pages and reuse file hashes', async (t) => {
  const { store, asset } = await fixture(t),
    job = queuePdfAsset(store, asset.id),
    claimed = claimPdfJob(store, job.id);
  assert.throws(() => claimPdfJob(store, job.id), /其他页面/);
  ingestPdfPages(store, job.id, { lease: claimed.lease, pageCount: 3, pages: [page(1, 'first')] });
  controlPdfJob(store, job.id, { action: 'pause' });
  assert.throws(
    () =>
      ingestPdfPages(store, job.id, {
        lease: claimed.lease,
        pageCount: 3,
        pages: [page(2, 'late')],
      }),
    /暂停/,
  );
  controlPdfJob(store, job.id, { action: 'resume' });
  const resumed = claimPdfJob(store, job.id);
  assert.equal(resumed.nextPage, 2);
  assert.throws(
    () =>
      ingestPdfPages(store, job.id, {
        lease: resumed.lease,
        pageCount: 3,
        pages: [page(3, 'gap')],
      }),
    /不连续/,
  );
  ingestPdfPages(store, job.id, {
    lease: resumed.lease,
    pageCount: 3,
    pages: [page(2, 'second'), page(3, 'third')],
    complete: true,
  });
  assert.equal(store.db.records('pdf_pages').length, 3);
  const source = store.get<any>('assets', asset.id);
  store.put('assets', 'duplicate', { ...source, id: 'duplicate' });
  const duplicate = queuePdfAsset(store, 'duplicate');
  assert.equal(duplicate.cacheId, job.cacheId);
  assert.equal(duplicate.status, 'complete');
  assert.equal(store.db.records('pdf_caches').length, 1);
  validatePdfRecords(store);
});
test('PDF empty-text, parser failure, cancellation and item range validation remain explicit', async (t) => {
  const { store, asset } = await fixture(t),
    job = queuePdfAsset(store, asset.id);
  let claimed = claimPdfJob(store, job.id);
  assert.throws(
    () =>
      ingestPdfPages(store, job.id, {
        lease: claimed.lease,
        pageCount: 1,
        pages: [{ ...page(1, 'hello'), items: [{ ...page(1, 'hello').items[0], end: 500 }] }],
      }),
    /定位范围/,
  );
  controlPdfJob(store, job.id, {
    action: 'fail',
    lease: claimed.lease,
    error: 'PasswordException: encrypted PDF',
  });
  assert.equal(
    store.db.getRecord<PdfJob>('pdf_jobs', job.id)?.error,
    'PasswordException: encrypted PDF',
  );
  controlPdfJob(store, job.id, { action: 'retry' });
  claimed = claimPdfJob(store, job.id);
  controlPdfJob(store, job.id, { action: 'cancel' });
  assert.throws(() => claimPdfJob(store, job.id), /继续或重试/);
  controlPdfJob(store, job.id, { action: 'resume' });
  claimed = claimPdfJob(store, job.id);
  ingestPdfPages(store, job.id, {
    lease: claimed.lease,
    pageCount: 1,
    pages: [page(1, '')],
    complete: true,
  });
  assert.equal(searchPdfAsset(store, asset.id, 'OCR').cache?.status, 'needs_ocr');
});
test('global PDF results group pages per document, retain accurate counts and route to immutable source pages', async (t) => {
  const { store, asset } = await fixture(t),
    document = createDocument(store, {
      title: '一本教材',
      format: 'pdf',
      assetId: asset.id,
      bodyMarkdown: '',
      kind: '书籍',
    });
  const job = queuePdfAsset(store, asset.id);
  finish(store, job, [
    '原文独有关键字 transactions',
    'another transactions page',
    'third transactions page',
  ]);
  const response = unifiedSearch(store, searchQuerySchema.parse({ q: 'transactions' }));
  assert.equal(response.total, 1);
  assert.equal(response.counts.document, 1);
  assert.equal(response.items[0]?.pdfHits?.length, 3);
  assert.equal(response.items[0]?.pdfTotalPages, 3);
  assert.match(
    response.items[0]!.pdfHits![1]!.href,
    /\/source\?version=[a-f0-9]{64}&page=2&q=transactions/,
  );
  assert.equal(response.items[0]?.matchIn, 'pdf');
  const updated = updateDocument(store, document.id, { ...document, title: 'transactions 教材' });
  assert.equal(
    unifiedSearch(store, searchQuerySchema.parse({ q: 'transactions' })).counts.document,
    1,
  );
  store.put('documents', document.id, { ...updated, _archived: true });
  assert.equal(unifiedSearch(store, searchQuerySchema.parse({ q: 'transactions' })).total, 0);
});
test('domain SQLite migrations retain related PDF pages/jobs and rebuild FTS without unselected content', async (t) => {
  const { store, asset } = await fixture(t);
  store.put('domains', 'selected', { id: 'selected', name: '领域', description: '', sortOrder: 0 });
  store.put('categories', 'category', {
    id: 'category',
    domainId: 'selected',
    name: '分类',
    parentId: null,
    description: '',
    sortOrder: 0,
  });
  createDocument(store, {
    id: 'selected-book',
    title: '选中教材',
    kind: '书籍',
    format: 'pdf',
    assetId: asset.id,
    categoryIds: ['category'],
  });
  finish(store, queuePdfAsset(store, asset.id), ['retained-pdf-needle']);
  const source = store.get<any>('assets', asset.id),
    other = {
      ...source,
      id: 'other-pdf',
      dataBase64: Buffer.from('%PDF-1.4\nother\n%%EOF').toString('base64'),
    };
  store.put('assets', other.id, other);
  store.put('documents', 'other-book', {
    id: 'other-book',
    title: '无关教材',
    kind: '书籍',
    format: 'pdf',
    assetId: other.id,
    categoryIds: [],
    tagIds: [],
    collection: 'general',
    bodyMarkdown: '',
    updatedAt: new Date().toISOString(),
  });
  finish(store, queuePdfAsset(store, other.id), ['unselected-private-pdf-needle']);
  const plan = sqliteMigrationPlan(store, { domainIds: ['selected'] });
  assert.equal(plan.retained.get('pdf_pages')?.size, 1);
  assert.equal(plan.retained.get('pdf_caches')?.size, 1);
  const result = await exportSQLiteMigration(
      store,
      { domainIds: ['selected'] },
      plan.preview.fingerprint,
    ),
    folder = mkdtempSync(join(tmpdir(), 'atlas-pdf-migration-')),
    path = join(folder, 'copy.sqlite');
  let copy: Store | undefined;
  try {
    writeFileSync(path, result.bytes);
    copy = new Store(path);
    assert.equal(copy.db.records('pdf_pages').length, 1);
    assert.equal(copy.db.pdf.cacheIds('retained-pdf-needle').length, 1);
    assert.equal(copy.db.pdf.cacheIds('unselected-private-pdf-needle').length, 0);
    validatePdfRecords(copy);
    assert.ok(!Buffer.from(result.bytes).includes(Buffer.from('unselected-private-pdf-needle')));
  } finally {
    copy?.db.close();
    assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
    rmSync(folder, { recursive: true, force: true });
  }
});

test('deleting unused PDF assets removes orphan caches and FTS while shared hashes remain reusable', async (t) => {
  const { store, asset } = await fixture(t),
    job = queuePdfAsset(store, asset.id);
  finish(store, job, ['orphan-index-needle']);
  const source = store.get<any>('assets', asset.id);
  store.put('assets', 'same-file', { ...source, id: 'same-file' });
  queuePdfAsset(store, 'same-file');
  store.remove('assets', asset.id);
  assert.equal(store.db.records('pdf_jobs').length, 1);
  assert.equal(store.db.pdf.cacheIds('orphan-index-needle').length, 1);
  store.remove('assets', 'same-file');
  assert.equal(store.db.records('pdf_jobs').length, 0);
  assert.equal(store.db.records('pdf_caches').length, 0);
  assert.equal(store.db.records('pdf_pages').length, 0);
  assert.equal(store.db.pdf.cacheIds('orphan-index-needle').length, 0);
  validatePdfRecords(store);
});
test('PDF restoration rejects incomplete completed caches and impossible job progress but accepts a lagging shared task', async (t) => {
  const { store, asset } = await fixture(t),
    job = queuePdfAsset(store, asset.id);
  const claimed = claimPdfJob(store, job.id);
  ingestPdfPages(store, job.id, {
    lease: claimed.lease,
    pageCount: 2,
    pages: [page(1, 'first page')],
  });
  const cache = store.db.getRecord<any>('pdf_caches', job.cacheId)!;
  const partialJob = store.db.getRecord<any>('pdf_jobs', job.id)!;
  store.db.putRecord('pdf_caches', cache.id, { ...cache, status: 'ready' });
  assert.throws(() => validatePdfRecords(store), /缓存状态无效/);
  store.db.putRecord('pdf_caches', cache.id, cache);
  for (const patch of [
    { status: 'complete' },
    { pageCount: 999 },
    { nextPage: 999 },
    { lease: undefined },
  ]) {
    store.db.putRecord('pdf_jobs', job.id, { ...partialJob, ...patch });
    assert.throws(() => validatePdfRecords(store), /任务进度与缓存不一致/);
  }
  store.db.putRecord('pdf_jobs', job.id, partialJob);
  store.put('assets', 'shared-copy', { ...store.get<any>('assets', asset.id), id: 'shared-copy' });
  const lagging = queuePdfAsset(store, 'shared-copy');
  ingestPdfPages(store, job.id, {
    lease: claimed.lease,
    pageCount: 2,
    pages: [page(2, 'second page')],
    complete: true,
  });
  validatePdfRecords(store);
  const completed = claimPdfJob(store, lagging.id);
  assert.equal(completed.status, 'complete');
  assert.equal(completed.nextPage, 3);
  const ready = store.db.getRecord<any>('pdf_caches', cache.id)!;
  store.db.putRecord('pdf_caches', cache.id, { ...ready, status: 'needs_ocr' });
  assert.throws(() => validatePdfRecords(store), /缓存状态无效/);
});

test('PDF restoration rejects forged cache hash, unsupported extraction version and altered normalized text', async (t) => {
  const { store, asset } = await fixture(t),
    job = queuePdfAsset(store, asset.id);
  finish(store, job, ['source text']);
  const cache = store.db.getRecord<any>('pdf_caches', job.cacheId),
    saved = store.db.records<any>('pdf_pages')[0]!;
  store.db.putRecord('pdf_pages', saved.id, { ...saved, normalized: 'poison' });
  assert.throws(() => validatePdfRecords(store), /缓存页或定位无效/);
  store.db.putRecord('pdf_pages', saved.id, saved);
  store.db.putRecord('pdf_caches', cache.id, { ...cache, extractorVersion: 999 });
  assert.throws(() => validatePdfRecords(store));
  store.db.putRecord('pdf_caches', cache.id, cache);
  store.put('assets', asset.id, {
    ...store.get<any>('assets', asset.id),
    dataBase64: Buffer.from('different bytes').toString('base64'),
  });
  assert.throws(() => validatePdfRecords(store), /原始文件不一致/);
});
