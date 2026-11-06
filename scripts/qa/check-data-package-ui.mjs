import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readDataPackage } from '../../shared/packages/data-package.ts';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const h = await startBrowserHarness({
  name: 'data-package-ui',
  viewport: { width: 390, height: 844 },
});
const { page, origin } = h;
const checks = [];
const download = async (action) => {
  const [file] = await Promise.all([page.waitForEvent('download'), action.click()]);
  assert.match(file.suggestedFilename(), /\.zip$/);
  return { filename: file.suggestedFilename(), bytes: await readFile(await file.path()) };
};
const api = async (path, options) => {
  const response = await page.request.fetch(origin + path, options);
  assert.ok(response.ok(), await response.text());
  return response.json();
};
const noHorizontalOverflow = async () => {
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
  );
};
async function disclosure(summaryText) {
  const details = page
    .locator('details.help-disclosure')
    .filter({ has: page.getByText(summaryText, { exact: true }) });
  const summary = details.locator('summary');
  const body = details.locator(':scope > :not(summary)').first();
  await summary.waitFor();
  assert.equal(await details.getAttribute('open'), null);
  assert.equal(await body.isVisible(), false);
  assert.ok((await summary.boundingBox()).height >= 44, '手机说明入口至少44px高');
  await summary.press('Enter');
  assert.equal(await body.isVisible(), true);
  await noHorizontalOverflow();
  await summary.press('Enter');
  assert.equal(await details.getAttribute('open'), null);
  assert.equal(await body.isVisible(), false);
}
async function prepare(input, title, id) {
  await page.getByText('整理JSON并生成数据包', { exact: true }).click();
  await page
    .getByLabel('整理题目数据文件')
    .setInputFiles({ name: input.filename, mimeType: 'application/zip', buffer: input.bytes });
  const editor = page.getByLabel('整理题目JSON');
  await page.waitForFunction(
    () => !!document.querySelector('textarea[aria-label="整理题目JSON"]')?.value,
  );
  const data = JSON.parse(await editor.inputValue());
  data.questions = [
    { ...data.questions[0], title, ...(id ? { id, categoryIds: [], tagIds: [] } : {}) },
  ];
  await editor.fill(JSON.stringify(data));
  await page.getByRole('button', { name: '生成数据包并预览导入' }).click();
  await page.getByRole('button', { name: '确认导入整个数据包' }).click();
  await page.getByText('数据包已完整导入。', { exact: false }).waitFor();
}
try {
  await page.goto(origin + '/#/questions/import');
  const template = await download(page.getByRole('button', { name: '下载新增题目模板包（ZIP）' }));
  const packageData = await readDataPackage(template.bytes);
  assert.equal(packageData.manifest.kind, 'question-template');
  assert.ok(packageData.files.has('taxonomy/reference.json'));
  await prepare(template, '本地封包验收题', 'PACKAGE-UI');
  const pending = await api('/api/questions/PACKAGE-UI');
  assert.equal(pending.status, 'pending');
  checks.push('下载新题模板ZIP，修改JSON后重新封包，预览并提交待审核');

  await page.goto(origin + '/#/questions/review');
  await page.getByLabel('审核选择 PACKAGE-UI').check();
  const edit = await download(page.getByRole('button', { name: '导出待审修改包（ZIP）' }));
  assert.equal((await readDataPackage(edit.bytes)).manifest.kind, 'question-update');
  await prepare(edit, '修订后的待审核题');
  const updated = await api('/api/questions/PACKAGE-UI');
  assert.equal(updated.title, '修订后的待审核题');
  assert.equal(updated.status, 'pending');
  checks.push('待审核题修改包重新封包，保留原题号和待审核状态');

  await api('/api/questions/review', {
    method: 'POST',
    data: {
      ids: [updated.id],
      action: 'approve',
      confirmed: true,
      expectedUpdatedAt: { [updated.id]: updated.updatedAt },
    },
  });
  await page.goto(origin + '/#/questions/PACKAGE-UI');
  await page.getByRole('button', { name: '题目操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '分享题目', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '分享内容' });
  await dialog.getByRole('button', { name: '导出分享PDF' }).waitFor();
  const shared = await download(dialog.getByRole('button', { name: '导出完整分享数据包（ZIP）' }));
  const unpacked = await readDataPackage(shared.bytes);
  assert.equal(unpacked.manifest.kind, 'share');
  assert.deepEqual(
    unpacked.payloads[0].data.questions.map((q) => q.id),
    ['PACKAGE-UI'],
  );
  checks.push('单题分享下载含清单的ZIP，保留PDF入口');

  await page.goto(origin + '/#/sharing');
  const input = page.getByLabel('选择 ZIP 数据包');
  await input.setInputFiles({
    name: 'damaged.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from('invalid'),
  });
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByRole('button', { name: '确认导入整个数据包' }).count(), 0);
  const longFilename = `手机换行验收_${'unbrokenfilename'.repeat(12)}.zip`;
  await input.setInputFiles({
    name: longFilename,
    mimeType: 'application/zip',
    buffer: shared.bytes,
  });
  await page.getByText('内容分享', { exact: true }).waitFor();
  const guidance = page
    .locator('details.help-disclosure')
    .filter({ has: page.getByText(/查看完整导入说明/) });
  assert.equal(await guidance.getAttribute('open'), null);
  assert.equal(await guidance.locator('li').first().isVisible(), false);
  assert.equal(
    await page.getByText('分享新增题目进入待审核，完全重复复用原题；', { exact: false }).isVisible(),
    true,
  );
  await guidance.locator('summary').click();
  assert.equal(await guidance.locator('li').first().isVisible(), true);
  await guidance.locator('summary').click();
  await disclosure(await guidance.locator('summary').innerText());
  assert.equal(await page.getByRole('button', { name: '确认导入整个数据包' }).isVisible(), true);
  const filenameButton = page.getByText(longFilename, { exact: true });
  assert.equal(await filenameButton.isVisible(), true);
  assert.equal(
    await filenameButton.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    true,
  );
  await noHorizontalOverflow();
  checks.push('说明默认隐藏正文，可鼠标和键盘展开收起；审核规则与确认入口常显，手机无空格长文件名无溢出');
  await page.getByRole('button', { name: '确认导入整个数据包' }).click();
  await page.getByText('数据包已完整导入。', { exact: false }).waitFor();
  assert.equal((await api('/api/export')).questions.length, 1);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
  );
  checks.push('损坏ZIP无确认按钮，重新选择有效包可导入并复用已有内容，手机页面无横向溢出');

  const migration = await api('/api/packages/export', { method: 'POST', data: { kind: 'migration' } });
  await input.setInputFiles({
    name: 'trusted-migration.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(migration.dataBase64, 'base64'),
  });
  const trusted = page.getByLabel('我确认这是自己的备份或可信来源的迁移包。', { exact: true });
  await trusted.waitFor();
  const importButton = page.getByRole('button', { name: '确认导入整个数据包', exact: true });
  assert.equal(await trusted.isVisible(), true);
  assert.equal(await trusted.isChecked(), false);
  assert.equal(await trusted.evaluate((element) => element.closest('details') === null), true);
  assert.equal(await importButton.isDisabled(), true);
  await disclosure(await guidance.locator('summary').innerText());
  assert.equal(await trusted.isVisible(), true);
  assert.equal(await importButton.isDisabled(), true);
  await trusted.check();
  assert.equal(await importButton.isEnabled(), true);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  checks.push('可信迁移确认位于折叠说明之外，展开说明不会越过确认门槛，勾选后才允许导入');

  for (const [route, summaries] of [
    ['/#/ai?tab=import', ['文件提取与题目核对说明']],
    ['/#/ai?tab=documents', ['文件容量与提取说明']],
    ['/#/settings?tab=backup&sub=migration', ['迁移包含什么，如何恢复？']],
  ]) {
    await page.goto(origin + route);
    for (const summary of summaries) await disclosure(summary);
    await noHorizontalOverflow();
  }
  checks.push('AI单次与教材工作台、设置迁移长提示默认收起，键盘可切换且手机布局无横向溢出');
  h.assertClean();
  await writeFile(
    resolve(h.folder, 'report.json'),
    JSON.stringify({ passed: checks.length, checks }, null, 2),
  );
  console.log(JSON.stringify({ passed: checks.length, checks }));
} catch (error) {
  await h.captureFailure(error, { checks });
  throw error;
} finally {
  await h.close();
}
