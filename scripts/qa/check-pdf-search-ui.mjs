/** Real text-layer PDFs, isolated memory DB and an ephemeral loopback server. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const harness = await startBrowserHarness({
  name: 'pdf-search-ui',
  setup: String.raw`
const api=async(url,method='GET',payload,status=200)=>{const response=await app.inject({url,method,...(payload===undefined?{}:{payload})});assert.equal(response.statusCode,status,response.body);return response.json();};
const {PDFDocument}=await import('pdf-lib'),fontkit=await import('@pdf-lib/fontkit'),{readFileSync}=await import('node:fs');
const pdf=await PDFDocument.create();pdf.registerFontkit(fontkit.default);const {gunzipSync}=await import('node:zlib');const font=await pdf.embedFont(gunzipSync(readFileSync('public/fonts/NotoSansSC-Regular.ttf.bin')),{subset:true});
for(const text of ['沉没成本 Opportunity cost chapter one','第二页 沉没成本 Opportunity cost chapter two']){const page=pdf.addPage([500,600]);page.drawText(text,{font,size:17,x:25,y:520});}
const asset=await api('/api/assets','POST',{filename:'search-textbook.pdf',mimeType:'application/pdf',dataBase64:Buffer.from(await pdf.save()).toString('base64')},201);
await api('/api/documents','POST',{id:'search-book',title:'全文检索教材',kind:'书籍',format:'pdf',assetId:asset.id},201);
const blank=await PDFDocument.create();blank.addPage([500,600]).drawRectangle({x:20,y:40,width:200,height:100});const blankAsset=await api('/api/assets','POST',{filename:'image-only.pdf',mimeType:'application/pdf',dataBase64:Buffer.from(await blank.save()).toString('base64')},201);
await api('/api/documents','POST',{id:'image-book',title:'无文本教材',kind:'书籍',format:'pdf',assetId:blankAsset.id},201);
return {assetId:asset.id,blankAssetId:blankAsset.id};`,
});
const { page, origin, folder } = harness,
  checks = [];
const api = (url) =>
  page.evaluate(async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw Error(await response.text());
    return response.json();
  }, url);
const until = async (check, timeout = 45000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error('PDF index/UI condition timed out');
};
try {
  await page.goto(origin + '/#/documents/search-book');
  await page.getByRole('heading', { name: '全文检索教材', exact: true }).waitFor();
  await until(async () => {
    const jobs = await api('/api/pdf-index/jobs');
    return jobs.length === 2 && jobs.every((job) => job.status === 'complete');
  });
  assert.equal(
    (
      await api(
        `/api/pdf-index/assets/${harness.state.assetId}/search?q=${encodeURIComponent('沉没成本')}`,
      )
    ).total,
    2,
  );
  assert.equal(
    (await api(`/api/pdf-index/assets/${harness.state.blankAssetId}/search?q=anything`)).cache
      .status,
    'needs_ocr',
  );
  checks.push('PDF.js实际抽取中英双页文本、后台索引、无文本OCR状态');
  await page.goto(origin + '/#/search?q=' + encodeURIComponent('沉没成本'));
  await page.getByRole('list', { name: '统一搜索结果' }).waitFor();
  assert.equal(await page.locator('.result-document').count(), 1);
  const second = page.locator('.result-document').getByRole('link').filter({ hasText: '第2页' });
  await second.click();
  await page.locator('canvas[aria-label="PDF文件第2页"]').waitFor();
  await until(() =>
    page
      .locator('.pdf-text-highlight')
      .count()
      .then((count) => count > 0),
  );
  assert.equal(await page.getByRole('spinbutton', { name: 'PDF文件页码' }).inputValue(), '2');
  checks.push('统一搜索按资料合并命中、直达第二页、文字坐标高亮');
  await page
    .getByRole('region', { name: 'PDF全文搜索' })
    .getByRole('button', { name: '第1页', exact: false })
    .click();
  await until(() =>
    page
      .getByRole('spinbutton', { name: 'PDF文件页码' })
      .inputValue()
      .then((value) => value === '1'),
  );
  await page.getByRole('button', { name: '下一处匹配页', exact: true }).click();
  await until(() =>
    page
      .getByRole('spinbutton', { name: 'PDF文件页码' })
      .inputValue()
      .then((value) => value === '2'),
  );
  checks.push('文内搜索及前后匹配页导航');
  const input = page.getByRole('searchbox', { name: '在本文中查找' });
  await input.fill('Opport');
  await page.getByRole('button', { name: '查找原文', exact: true }).click();
  await until(() =>
    page
      .getByRole('region', { name: 'PDF全文搜索' })
      .getByText('2个匹配页面', { exact: true })
      .isVisible(),
  );
  checks.push('英文前缀检索与命中页分页');
  await page.setViewportSize({ width: 320, height: 800 });
  await page.locator('.pdf-search-hits .pdf-hit').first().click();
  await until(() =>
    page
      .locator('.pdf-text-highlight')
      .count()
      .then((count) => count > 0),
  );
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
    false,
  );
  await page.screenshot({ path: resolve(folder, 'pdf-search-mobile.png'), fullPage: true });
  checks.push('320像素PDF阅读/高亮/查找布局');
  await page.goto(origin + '/#/documents/image-book');
  await page.getByText(/仍可阅读原文件。.*外部 OCR 工具.*带文字层的 PDF.*资料库上传/).waitFor();
  checks.push('扫描件可读，提示先用外部 OCR 生成带文字层的 PDF 再上传');
  harness.assertClean();
  await writeFile(
    resolve(folder, 'report.json'),
    JSON.stringify({ passed: checks.length, checks }, null, 2),
  );
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} catch (error) {
  await harness.captureFailure(error, { checks });
  throw error;
} finally {
  await harness.close();
}
