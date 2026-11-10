/** Explicit operator-selected book on the separate QA installation. The book
 * is never copied into project data or public fixtures; QA data is cleared. */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { connectAndroid, until } from '../testing/android/device.mjs';

const { values } = parseArgs({
  options: {
    serial: { type: 'string' },
    pdf: { type: 'string' },
    query: { type: 'string' },
    page: { type: 'string' },
    'index-through': { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(
    'check-android-real-pdf.mjs --serial DEVICE --pdf SELECTED_FILE --query TERM [--page FILE_PAGE] [--index-through FILE_PAGE]\nRequires the separate QA APK. No model requests; clears only QA data. Never copies the book into project data.',
  );
  process.exit(0);
}
assert.ok(values.pdf && values.query, 'Select an explicit PDF and a known query');
const expectedPage = Number(values.page || 1);
assert.ok(Number.isSafeInteger(expectedPage) && expectedPage >= 1);
const indexThrough =
  values['index-through'] === undefined ? undefined : Number(values['index-through']);
assert.ok(
  indexThrough === undefined ||
    (Number.isSafeInteger(indexThrough) && indexThrough >= expectedPage),
);
const bytes = await readFile(resolve(values.pdf));
assert.ok(bytes.length <= 20 * 1024 * 1024, 'Use a book within the default library upload limit');
const folder = resolve(
  indexThrough ? 'test-results/android-real-pdf-reader' : 'test-results/android-real-pdf',
);
await mkdir(folder, { recursive: true });
const report = {
  ok: false,
  isolated: true,
  filename: basename(values.pdf),
  bytes: bytes.length,
  query: values.query,
  expectedPage,
  indexThrough,
  checks: [],
};
let device;
try {
  device = await connectAndroid({ serial: values.serial });
  const { api, go } = device;
  const page = () => device.page;
  report.serial = device.serial;
  report.original = device.original;
  assert.equal((await api('/api/bootstrap')).stats.totalQuestions, 0);
  await api('/api/domains', 'POST', { id: 'android-book', name: '真实教材验收' });
  await go('documents/new');
  await page().getByLabel('资料标题 *', { exact: true }).fill('QA真实教材全文检索');
  await page().getByLabel('资料类型', { exact: true }).fill('书籍');
  await page().getByRole('checkbox', { name: '真实教材验收', exact: true }).check();
  const uploadStart = performance.now();
  await page().getByLabel('上传资料文件', { exact: true }).setInputFiles({
    name: report.filename,
    mimeType: 'application/pdf',
    buffer: bytes,
  });
  const save = page().getByRole('button', { name: '保存资料', exact: true });
  await until(() => save.isEnabled(), 'native PDF file selected and saved to draft', 60000);
  await save.click();
  await page().waitForURL(/#\/documents\/(?!new)[^/?]+/);
  const documentId = decodeURIComponent(new URL(page().url()).hash.split('/')[2]);
  const document = await api('/api/documents/' + documentId);
  assert.equal(document.kind, '书籍');
  assert.deepEqual(document.domainIds, ['android-book']);
  const asset = await api('/api/assets/' + document.assetId);
  assert.equal(asset.filename, report.filename);
  report.uploadMs = Math.round(performance.now() - uploadStart);
  report.checks.push('actual selected book is persisted through Capacitor file storage');
  await writeFile(join(folder, 'progress.json'), JSON.stringify(report, null, 2));
  const job = async () =>
    (await api('/api/pdf-index/jobs')).find((item) => item.assetId === asset.id);
  const indexingStart = performance.now();
  await go('documents/' + document.id, { reload: false });
  await until(
    async () => {
      const value = await job();
      return value?.cache?.processedPages >= 8 || value?.status === 'complete';
    },
    'first saved PDF checkpoint',
    120000,
  );
  const progress = await job();
  report.pages = progress.cache.pageCount;
  if (progress.status !== 'complete') {
    const panel = page().getByRole('region', { name: 'PDF全文索引', exact: true });
    await panel.getByRole('button', { name: '暂停', exact: true }).click();
    await until(async () => (await job()).status === 'paused', 'index pause persisted');
    const paused = await job();
    await delay(2000);
    assert.equal((await job()).cache.processedPages, paused.cache.processedPages);
    await panel.getByRole('button', { name: '继续', exact: true }).click();
    await go('questions', { reload: false });
    report.pausedAtPage = paused.cache.processedPages;
    report.checks.push('real multi-page indexing pauses at a saved page and resumes across routes');
  }
  await writeFile(join(folder, 'progress.json'), JSON.stringify(report, null, 2));
  let lastMilestone = 0;
  await until(
    async () => {
      const value = await job();
      const processed = value?.cache?.processedPages || 0;
      const milestone = Math.floor(processed / 50);
      if (milestone > lastMilestone) {
        lastMilestone = milestone;
        console.log(JSON.stringify({ stage: 'indexing', processed, total: report.pages }));
      }
      if (value?.status === 'failed') throw Error(value.error || 'Indexing failed');
      return value?.status === 'complete' || (indexThrough && processed >= indexThrough);
    },
    'whole real book indexed',
    600000,
  );
  report.indexMs = Math.round(performance.now() - indexingStart);
  if (indexThrough && (await job()).status !== 'complete') {
    await go('documents/' + document.id, { reload: false });
    await page()
      .getByRole('region', { name: 'PDF全文索引', exact: true })
      .getByRole('button', { name: '暂停', exact: true })
      .click();
    await until(async () => (await job()).status === 'paused', 'reader checkpoint paused');
  }
  const completed = await job();
  assert.ok(completed.cache.processedPages >= (indexThrough || completed.cache.pageCount));
  assert.ok(completed.cache.textPages > 0);
  const searchStart = performance.now();
  const query =
    '/api/pdf-index/assets/' +
    asset.id +
    '/search?q=' +
    encodeURIComponent(values.query) +
    '&pageSize=100';
  let found = await api(query),
    hits = found.hits;
  for (
    let pageNumber = 2;
    hits.length < found.total && !hits.some((hit) => hit.pageNumber === expectedPage);
    pageNumber++
  )
    hits.push(...(await api(query + '&page=' + pageNumber)).hits);
  report.searchMs = Math.round(performance.now() - searchStart);
  assert.ok(
    hits.some((hit) => hit.pageNumber === expectedPage),
    'Known source file page must be searchable',
  );
  report.matchingPages = found.total;
  const global = await api('/api/search?q=' + encodeURIComponent(values.query));
  assert.equal(global.counts.document, 1);
  report.checks.push('Chinese query and exact known file page agree');
  await go('search?q=' + encodeURIComponent(values.query), { reload: false });
  const result = page().locator('.result-document').filter({ hasText: 'QA真实教材全文检索' });
  await result.waitFor();
  const links = result.locator('a[href*="/source?"]');
  const exactLink = links.filter({ hasText: new RegExp(`^第${expectedPage}页`) });
  if (await links.count()) {
    await ((await exactLink.count()) ? exactLink : links.first()).click();
  } else {
    // The API emits the same immutable source link independently of the first
    // three visible search snippets; use it when the known page is a later hit.
    const item = global.items.find((item) => item.type === 'document');
    const link = item.pdfHits?.find((hit) => hit.href)?.href;
    assert.ok(link, 'Global source hit must carry a reader link');
    await go(link.slice(2));
  }
  const match = page()
    .locator('.pdf-search-hits button')
    .filter({ has: page().getByText(`第${expectedPage}页`, { exact: true }) });
  await match.click();
  const canvas = page().locator(
    `canvas[aria-label="PDF文件第${expectedPage}页"][aria-busy="false"]`,
  );
  await canvas.waitFor();
  await until(
    () =>
      page()
        .locator('.pdf-text-highlight')
        .count()
        .then((count) => count > 0),
    'real book text highlights',
  );
  await canvas.scrollIntoViewIfNeeded();
  await page().screenshot({ path: join(folder, 'book-source.png') });
  assert.ok(await page().evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  report.checks.push('native source reader and search links render without page overflow');
  await device.restart();
  assert.equal((await job()).status, completed.status);
  assert.equal((await api(query)).total, report.matchingPages);
  report.checks.push('PDF cache and FTS remain searchable after process restart');
  assert.deepEqual(device.errors, []);
  assert.deepEqual(device.network, []);
  report.ok = true;
} catch (error) {
  report.error = String(error.stack || error);
  if (device) {
    report.webViewErrors = device.errors;
    report.readerState = await device.page
      .evaluate(() => {
        const reader = document.querySelector('[aria-label="PDF原文阅读器"]');
        if (!reader) return undefined;
        const canvas = reader.querySelector('canvas');
        return {
          pageInput: reader.querySelector('input')?.value,
          canvasPage: canvas?.getAttribute('aria-label'),
          canvasBusy: canvas?.getAttribute('aria-busy'),
          alert: reader.querySelector('[role="alert"]')?.textContent,
        };
      })
      .catch(() => undefined);
  }
  await device?.page
    .screenshot({ path: join(folder, 'failure.png'), fullPage: true })
    .catch(() => {});
  process.exitCode = 1;
} finally {
  try {
    await device?.close();
    report.deviceRestored = true;
  } catch (error) {
    report.cleanupError = String(error);
    report.ok = false;
    process.exitCode = 1;
  }
  if (device)
    await writeFile(
      join(folder, 'device-cleanup.json'),
      await readFile(join(device.folder, 'device-cleanup.json')),
    );
  await writeFile(join(folder, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
