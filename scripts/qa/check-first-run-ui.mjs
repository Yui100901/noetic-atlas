import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildDataPackage } from '../../shared/packages/data-package.ts';
import { fixtureQuestion, learningSeed } from '../../tests/fixtures/learning-seed.ts';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const h = await startBrowserHarness({ name: 'first-run-ui' });
const { page, origin } = h;
const checks = [];
const guide = page.getByRole('region', { name: '开始第一次学习', exact: true });
const brand = page.getByRole('link', { name: '认知星图，返回知识总览', exact: true });
const upgrade = page.getByRole('link', { name: '备份、升级与恢复', exact: true });
const title = '自建首题';
const imported = fixtureQuestion('FIRST-RUN-IMPORT', 'true_false', {
  title: '导入首题',
  stemMarkdown: '保存的复习记录可以用来安排下一次复习。',
});

async function verifyUpgradeLink() {
  await upgrade.click();
  await page.getByRole('heading', { name: '新版发布、升级与回滚', exact: true }).waitFor();
  await page.waitForFunction(() => {
    const rect = document.getElementById('新版发布升级与回滚')?.getBoundingClientRect();
    return rect && rect.top >= 0 && rect.top < innerHeight;
  });
}

try {
  await page.goto(origin + '/#/');
  await guide.waitFor();
  assert.equal(
    (await (await page.request.get(origin + '/api/bootstrap')).json()).ai.available,
    false,
  );
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await guide.getByRole('link', { name: '导入题库包', exact: true }).isVisible(),
      true,
    );
    assert.equal(
      await guide.getByRole('link', { name: '自己建题', exact: true }).isVisible(),
      true,
    );
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await verifyUpgradeLink();
  await brand.click();
  checks.push('空库引导在桌面及 390/320 像素可用，升级帮助定位到内置手册章节');

  await guide.getByRole('link', { name: '自己建题', exact: true }).click();
  await page.getByLabel('标题 *', { exact: true }).fill(title);
  await page.getByLabel('题干 Markdown', { exact: true }).fill('复习时为什么应先尝试回忆？');
  await page.getByLabel('参考答案', { exact: true }).fill('主动回忆能暴露记忆缺口。');
  await page.getByRole('button', { name: '保存题目', exact: true }).click();
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
  await brand.click();

  await guide.getByRole('link', { name: '导入题库包', exact: true }).click();
  const { domains, categories, tags } = learningSeed();
  const pack = await buildDataPackage({
    kind: 'share',
    title: '首次导入验收',
    payloads: [
      {
        path: 'data/questions.json',
        data: {
          format: 'learning-share',
          schemaVersion: 1,
          title: '首次导入验收',
          exportedAt: '2026-11-10T00:00:00Z',
          domains,
          categories,
          tags,
          questions: [imported],
          assets: [],
          papers: [],
          questionBanks: [],
        },
      },
    ],
  });
  await page.getByLabel('选择 ZIP 数据包', { exact: true }).setInputFiles({
    name: 'first-run.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(pack),
  });
  await page.getByRole('button', { name: '确认导入整个数据包', exact: true }).click();
  await page.getByText('数据包已完整导入', { exact: false }).first().waitFor();
  await brand.click();
  await guide.getByRole('link', { name: '前往审核', exact: true }).click();
  for (const name of [title, imported.title]) {
    await page.getByRole('heading', { name, exact: true }).waitFor();
  }
  const pending = await page.getByRole('checkbox', { name: /^审核选择 / }).all();
  assert.equal(pending.length, 2);
  for (const choice of pending) await choice.check();
  await page.getByRole('button', { name: '确认批量通过', exact: true }).click();
  await page.getByRole('heading', { name: '当前没有待审核题目', exact: true }).waitFor();
  await brand.click();
  await page.getByRole('link', { name: '创建题集', exact: true }).waitFor();
  assert.equal(await guide.count(), 0);
  checks.push('自建及 ZIP 导入均进入待审核，空库引导保留到审核通过');

  await page.getByRole('link', { name: '创建题集', exact: true }).click();
  await page.getByLabel('题集名称 *', { exact: true }).fill('第一次练习验收');
  const row = page.locator('.question-row').filter({ hasText: imported.title });
  await row.getByRole('checkbox').check();
  await page.getByRole('button', { name: '创建题集', exact: true }).click();
  await page.getByRole('button', { name: '开始练习', exact: true }).click();
  await page.waitForURL(/#\/attempts\/attempt-/);
  await page.getByRole('heading', { name: imported.title, exact: false }).waitFor();
  await page.getByRole('radio', { name: '对 / 正确', exact: true }).check();
  await page.getByRole('button', { name: '交卷并查看解析', exact: true }).first().click();
  await page.locator('.exam-question .answer-state-text.status-correct').waitFor();
  checks.push('从有题总览进入手动组题，完成首练并得到正确的判定');

  await brand.click();
  await page.getByRole('link', { name: '管理数据与备份', exact: true }).click();
  await page.getByText('Windows 免安装版', { exact: true }).waitFor();
  await verifyUpgradeLink();
  checks.push('迁移页显示免安装版恢复路径并可定位内置升级说明');

  h.assertClean();
  const report = { passed: checks.length, checks, isolatedDatabase: true };
  await writeFile(resolve(h.folder, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await h.captureFailure(error, { checks });
  throw error;
} finally {
  await h.close();
}
