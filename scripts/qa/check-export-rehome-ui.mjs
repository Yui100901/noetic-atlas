import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { readDataPackage } from '../../shared/packages/data-package.ts';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const h = await startBrowserHarness({
  name: 'export-rehome-ui',
  setup: `
const {learningSeed}=await import('./tests/fixtures/learning-seed.ts');
const seed=learningSeed();const imported=await app.inject({method:'POST',url:'/api/import',payload:{mode:'merge',data:seed}});assert.equal(imported.statusCode,200,imported.body);
const paper=await app.inject({method:'POST',url:'/api/papers',payload:{title:'ZIP题集验收',mode:'manual',questionIds:seed.questions.slice(0,2).map(q=>q.id),scoring:{enabled:false}}});assert.equal(paper.statusCode,201,paper.body);return {paperId:paper.json().id};
`,
});
const { page, origin } = h,
  checks = [];
const pdfEvidence = { responses: [], workers: [], warnings: [] };
const goto = (path) => page.goto(origin + '/#/' + path);
const api = async (path, data) => {
  const r = await page.request.post(origin + path, { data });
  assert.ok(r.ok(), await r.text());
  return r.json();
};
try {
  await goto('');
  await page.locator('.sidebar nav').getByRole('link', { name: '综合统计', exact: true }).waitFor();
  assert.equal(
    await page.locator('.sidebar nav').getByRole('link', { name: 'AI工作台', exact: true }).count(),
    0,
  );
  assert.equal(
    await page.locator('.sidebar nav').getByRole('link', { name: '综合统计', exact: true }).count(),
    1,
  );
  await goto('sharing?tab=import');
  await page.waitForURL(/#\/sharing\?/);
  await page.getByLabel('待转换文本', { exact: true }).waitFor();
  await page.getByRole('button', { name: '教材分批出题', exact: true }).click();
  await page.getByLabel('AI分批原始文件', { exact: true }).waitFor({ state: 'attached' });
  await goto('sharing?tab=template');
  await page.waitForURL(/#\/sharing\?tab=template/);
  await page.getByRole('button', { name: '下载新增题目模板包（ZIP）', exact: true }).waitFor();
  checks.push('侧栏移除AI工作台，原始资料与模板在导入中心，旧书签跳转到实际功能');

  await goto('papers/new/ai');
  await page.getByLabel('AI组题要求', { exact: true }).waitFor();
  await page.getByLabel('AI组题要求', { exact: true }).fill('恢复这个推荐要求，不应丢失');
  await page.getByRole('button', { name: '保存草稿', exact: true }).first().click();
  await page.reload();
  const picker = page.getByRole('dialog', { name: '继续AI辅助草稿', exact: true });
  await picker.waitFor();
  await picker.getByRole('button', { name: '继续此草稿', exact: true }).first().click();
  assert.match(await page.getByLabel('AI组题要求', { exact: true }).inputValue(), /不应丢失/);
  checks.push('AI推荐位于创建题集，归位后仍可恢复原有种类的推荐草稿');

  await goto('papers/' + h.state.paperId);
  await page.getByRole('button', { name: '分享', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '分享题集', exact: true });
  await dialog.getByRole('radio', { name: 'PDF 文档', exact: true }).check();
  page.on('response', (response) => {
    const { pathname } = new URL(response.url());
    if (/export-document|NotoSansSC|pdf-render-worker/.test(pathname))
      pdfEvidence.responses.push({ pathname, status: response.status() });
  });
  page.on('worker', (worker) => pdfEvidence.workers.push(worker.url()));
  page.on('console', (entry) => {
    if (['warning', 'error'].includes(entry.type())) pdfEvidence.warnings.push(entry.text());
  });
  const releasePdf = Promise.withResolvers();
  const exportDocumentPath = '**/api/papers/*/export-document?*';
  await page.route(exportDocumentPath, async (route) => {
    await releasePdf.promise;
    await route.continue();
  });
  const [pdfDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.waitForEvent('worker', {
      predicate: (worker) => /\/pdf-render-worker-[^/]+\.js$/.test(new URL(worker.url()).pathname),
      timeout: 60_000,
    }),
    (async () => {
      try {
        await dialog.getByRole('button', { name: '下载文件', exact: true }).click();
        await dialog.getByRole('button', { name: '关闭并继续生成', exact: true }).click();
        await goto('questions');
        await dialog.waitFor({ state: 'hidden' });
      } finally {
        releasePdf.resolve();
      }
    })(),
  ]);
  await page.unroute(exportDocumentPath);
  assert.match(pdfDownload.suggestedFilename(), /\.pdf$/i);
  const pdf = await PDFDocument.load(await readFile(await pdfDownload.path()));
  assert.match(pdf.getTitle(), /ZIP题集验收/);
  assert.ok(pdf.getPageCount() > 0);
  checks.push('关闭分享窗口并切页后，独立线程继续渲染并下载可打开的题集 PDF');

  await goto('papers/' + h.state.paperId);
  await page.getByRole('button', { name: '分享', exact: true }).click();
  await dialog.getByRole('radio', { name: '题集数据包（ZIP）', exact: true }).check();
  const button = dialog.getByRole('button', { name: '下载文件', exact: true });
  await dialog.getByText('导出规模检查通过', { exact: true }).waitFor();
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  const data = await readDataPackage(new Uint8Array(await readFile(await download.path())));
  assert.equal(data.manifest.kind, 'share');
  assert.equal(data.payloads[0].data.papers.length, 1);
  assert.equal(data.payloads[0].data.questions.length, 2);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  checks.push('题集导出新增ZIP，先展示规模预检，真实下载manifest包并包含完整题集和题目');

  const config = await api('/api/packages/export', { kind: 'configuration' });
  await goto('sharing');
  await page.getByLabel('选择 ZIP 数据包', { exact: true }).setInputFiles({
    name: 'configuration.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(config.dataBase64, 'base64'),
  });
  await page.getByRole('link', { name: '前往 SQLite 迁移', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: '确认导入整个数据包', exact: true }).count(),
    0,
  );
  await page.getByRole('link', { name: '前往 SQLite 迁移', exact: true }).click();
  await page.waitForURL(/sub=migration/);
  await goto('settings?tab=backup&sub=migration');
  await page.getByRole('heading', { name: '数据迁移', exact: true }).waitFor();
  assert.equal(await page.getByLabel('选择 ZIP 数据包', { exact: true }).count(), 0);
  checks.push('设置合并为SQLite迁移，内容分享转至导入中心，旧配置包提示重新使用SQLite迁移');

  await goto('analytics');
  await page.getByRole('heading', { name: '综合统计', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'AI 用量与处理记录', exact: true }).click();
  await page.getByRole('heading', { name: '处理记录', exact: true }).waitFor();
  await page.getByRole('button', { name: '全部记录', exact: true }).click();
  await page.getByRole('tab', { name: '学习统计', exact: true }).click();
  await page.getByRole('heading', { name: /学习周报/ }).waitFor();
  checks.push('综合统计内切换学习和AI用量，保留统一日历范围与全部AI记录入口');

  let exportCalls = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/packages/export')) exportCalls++;
  });
  await page.route('**/api/packages/export-preview', (route) =>
    route.fulfill({
      json: {
        allowed: false,
        questionCount: 50001,
        estimatedExpandedBytes: 200000000,
        estimatedZipBytes: 210000000,
        attachmentBytes: 0,
        estimatedFiles: 2,
        maxQuestions: 50000,
        estimateIsUpperBound: true,
        reasons: ['当前范围超过单包上限，尚未生成文件。'],
        recommendations: [
          {
            label: '按领域缩小范围或分组导出（总量超限仍需分次）',
            href: '#/sharing?tab=export',
          },
        ],
      },
    }),
  );
  await goto('papers/' + h.state.paperId);
  await page.getByRole('button', { name: '分享', exact: true }).click();
  const blocked = page.getByRole('dialog', { name: '分享题集', exact: true });
  await blocked.getByRole('radio', { name: '题集数据包（ZIP）', exact: true }).check();
  await blocked.getByText('当前范围不适合一次导出', { exact: true }).waitFor();
  assert.equal(
    await blocked.getByRole('button', { name: '下载文件', exact: true }).isDisabled(),
    true,
  );
  await page.setViewportSize({ width: 390, height: 900 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
  );
  await blocked
    .getByRole('link', { name: '按领域缩小范围或分组导出（总量超限仍需分次）', exact: true })
    .click();
  await page.waitForURL(/sharing\?tab=export/);
  assert.equal(exportCalls, 0);
  checks.push('超限预检阻止封包请求，并指向领域分享以缩小范围');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await goto('sharing');
    await page
      .getByRole('heading', { name: '接收内容，整理成自己的知识。', exact: true })
      .waitFor();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      true,
    );
    await page.screenshot({ path: join(h.folder, `sharing-${width}.png`), fullPage: true });
  }
  h.assertClean();
  await writeFile(
    join(h.folder, 'report.json'),
    JSON.stringify({ passed: checks.length, checks }, null, 2),
  );
  console.log(JSON.stringify({ passed: checks.length, checks }));
} catch (error) {
  await h.captureFailure(error, { checks, pdfEvidence });
  throw error;
} finally {
  await h.close();
}
