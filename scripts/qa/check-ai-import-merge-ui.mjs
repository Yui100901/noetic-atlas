/** Unified single/batched material workflow and configuration in an isolated DB. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const h = await startBrowserHarness({ name: 'ai-import-merge-ui' });
const { page, origin } = h,
  checks = [];
const api = async (path, method = 'GET', data) => {
  const response = await page.request.fetch(origin + path, { method, ...(data ? { data } : {}) });
  assert.ok(response.ok(), await response.text());
  return response.json();
};
try {
  let settings = await api('/api/settings');
  await api('/api/settings', 'PUT', {
    settings: { ...settings, aiImport: { ...settings.aiImport, sourceCharacters: 1000 } },
  });
  await page.goto(origin + '/#/sharing?tab=import');
  const workflow = page.getByRole('region', { name: 'AI整理处理方式', exact: true });
  await workflow.waitFor();
  assert.equal(
    await page
      .locator('.sharing-import-tabs')
      .getByRole('button', { name: '教材分批出题', exact: true })
      .count(),
    0,
  );
  await page
    .getByLabel('待转换文本', { exact: true })
    .fill('这是一份尚未处理的单次整理材料，切换分批后应能恢复。');
  await page.getByRole('button', { name: '保存草稿', exact: true }).first().click();
  await workflow.getByRole('button', { name: '教材分批出题', exact: true }).click();
  await page.getByLabel('AI分批原始文件', { exact: true }).waitFor({ state: 'attached' });
  assert.match(page.url(), /process=batch/);
  await page.getByLabel('AI分批原始文件', { exact: true }).setInputFiles({
    name: 'chapter.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('x'.repeat(1500)),
  });
  await page
    .getByRole('alert')
    .filter({ hasText: /当前配置/ })
    .waitFor();
  assert.equal((await api('/api/ai/document-jobs')).length, 0);
  checks.push('AI整理统一入口包含两种规模，材料超过当前配置会本机停止且不创建任务');
  await workflow.getByRole('button', { name: '单次整理', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '继续AI辅助草稿', exact: true });
  await picker.waitFor();
  await picker.getByRole('button', { name: '继续此草稿', exact: true }).first().click();
  assert.match(await page.getByLabel('待转换文本', { exact: true }).inputValue(), /应能恢复/);
  checks.push('在统一页切换单次与分批时保存草稿，返回可选择继续原输入');
  settings = await api('/api/settings');
  await api('/api/settings', 'PUT', {
    settings: { ...settings, aiImport: { ...settings.aiImport, sourceCharacters: 5000 } },
  });
  await page.goto(origin + '/#/sharing?tab=documents');
  // This fixture writes settings externally through HTTP. Reload bootstrap as
  // a separate tab would; the real settings form calls the shared reload hook.
  await page.reload();
  await page.getByLabel('AI分批原始文件', { exact: true }).waitFor({ state: 'attached' });
  await page.getByLabel('AI分批原始文件', { exact: true }).setInputFiles({
    name: 'chapter.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('x'.repeat(1500)),
  });
  await page.getByText(/共1,500字符/).waitFor();
  assert.equal(
    await page.locator('.sharing-import-tabs button[aria-current=page]').innerText(),
    'AI整理题目',
  );
  await page.getByRole('button', { name: '保存草稿', exact: true }).first().click();
  await page.reload();
  const batchPicker = page.getByRole('dialog', { name: '继续AI辅助草稿', exact: true });
  await batchPicker.waitFor();
  await batchPicker.getByRole('button', { name: '继续此草稿', exact: true }).first().click();
  await page.getByText(/共1,500字符/).waitFor();
  checks.push('修改后台限额后实际提取成功，旧教材链接与分批正文草稿仍可恢复');
  // Follow the real link so the AI draft session can save before navigation.
  // Direct scripted hash changes deliberately use the Back/Forward save guard.
  await page.locator('.sidebar-bottom a[href="#/settings"]').click();
  await page.waitForURL(/#\/settings/);
  await page
    .getByRole('navigation', { name: '系统配置分区', exact: true })
    .getByRole('link', { name: /文件资源/ })
    .click();
  const size = page.getByLabel('AI材料单文件上限（MiB）', { exact: true });
  await size.waitFor();
  assert.equal(await size.inputValue(), '128');
  await size.fill('64');
  await page.getByRole('button', { name: '保存系统配置', exact: true }).click();
  await page
    .getByRole('region', { name: '系统配置保存操作', exact: true })
    .getByText('系统配置已保存', { exact: true })
    .waitFor();
  assert.equal((await api('/api/settings')).aiImport.fileMiB, 64);
  checks.push('材料大小与页数限制在文件资源分区可配置并真实保存');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(origin + '/#/sharing?tab=import');
    const choices = page.getByRole('dialog', { name: '继续AI辅助草稿', exact: true });
    if (await choices.isVisible())
      await choices.getByRole('button', { name: '新建草稿', exact: true }).click();
    await page.getByRole('region', { name: 'AI整理处理方式', exact: true }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: join(h.folder, `unified-${width}.png`), fullPage: true });
  }
  h.assertClean();
  await writeFile(
    join(h.folder, 'report.json'),
    JSON.stringify({ passed: checks.length, checks }, null, 2),
  );
  console.log(JSON.stringify({ passed: checks.length, checks }));
} catch (error) {
  await h.captureFailure(error, { checks });
  throw error;
} finally {
  await h.close();
}
