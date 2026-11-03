/** Delayed reads must never replace the last record or backup the user selected. */
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const h = await startBrowserHarness({ name: 'authoring-request-safety-ui' });
const { page, origin } = h,
  checks = [];
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
try {
  const stamp = '2026-11-03T01:00:00.000Z';
  const runs = ['A', 'B'].map((id) => ({
    id,
    kind: 'explain',
    status: 'completed',
    createdAt: stamp,
    model: `RACE-${id}`,
    warnings: [],
    questionIds: [],
    result: { explanationMarkdown: `DETAIL-${id}` },
  }));
  let pending;
  await page.route('**/api/ai/runs?*', (route) =>
    route.fulfill({ json: { items: runs, total: 2, page: 1, pageSize: 20 } }),
  );
  await page.route('**/api/ai/runs/A', async (route) => {
    const active = pending;
    assert.ok(active);
    active.started.resolve();
    await active.release.promise;
    await route.fulfill(
      active.failure
        ? { status: 500, json: { error: { code: 'QA_OLD_ERROR', message: '过期记录读取失败' } } }
        : { json: runs[0] },
    );
    active.finished.resolve();
  });
  await page.route('**/api/ai/runs/B', (route) => route.fulfill({ json: runs[1] }));
  const openHistory = async () => {
    await page.goto(`${origin}/#/ai?tab=history`);
    await page.locator('.ai-history-item').nth(1).waitFor();
  };
  const startA = async (failure = false) => {
    pending = { started: deferred(), release: deferred(), finished: deferred(), failure };
    await page
      .locator('.ai-history-item')
      .nth(0)
      .getByRole('button', { name: '查看结果', exact: true })
      .click();
    await pending.started.promise;
    await page.getByRole('status').filter({ hasText: '正在读取AI处理记录' }).waitFor();
  };
  const dialog = () => page.getByRole('dialog', { name: 'AI处理结果', exact: true });
  for (const failure of [false, true]) {
    await openHistory();
    await startA(failure);
    await page
      .locator('.ai-history-item')
      .nth(1)
      .getByRole('button', { name: '查看结果', exact: true })
      .click();
    await dialog()
      .getByText(/DETAIL-B/)
      .waitFor();
    pending.release.resolve();
    await pending.finished.promise;
    await page
      .getByRole('status')
      .filter({ hasText: '正在读取AI处理记录' })
      .waitFor({ state: 'hidden' });
    assert.match(await dialog().innerText(), /DETAIL-B/);
    assert.doesNotMatch(await dialog().innerText(), /DETAIL-A/);
    assert.equal(await page.getByText('过期记录读取失败', { exact: true }).count(), 0);
    checks.push(
      failure
        ? '旧AI详情失败不覆盖最后选择的新记录或显示过期错误'
        : '后选择的AI详情优先，迟到成功不会覆盖新记录',
    );
    await dialog().getByRole('button', { name: '关闭', exact: true }).click();
  }
  await startA();
  await page.evaluate(() => {
    window.location.hash = '#/';
  });
  await page.locator('.ai-history-list').waitFor({ state: 'hidden' });
  pending.release.resolve();
  await pending.finished.promise;
  assert.equal(await page.getByRole('dialog', { name: 'AI处理结果', exact: true }).count(), 0);
  checks.push('离开AI记录页取消详情读取，迟到结果不会在其他页面弹窗');

  await page.goto(`${origin}/#/settings?tab=backup`);
  await page.getByRole('heading', { name: '从备份合并导入', exact: true }).waitFor();
  await page.evaluate(() => {
    const original = File.prototype.text;
    window.backupReads = {};
    File.prototype.text = function () {
      if (this.name.startsWith('held-'))
        return new Promise((resolve, reject) => {
          window.backupReads[this.name] = {
            success: () => original.call(this).then(resolve),
            fail: () => reject(new Error('旧文件读取失败')),
          };
        });
      return original.call(this);
    };
  });
  const input = () => page.getByLabel('选择 JSON 备份文件', { exact: true });
  const json = (prefix, count) => ({
    domains: [],
    questions: Array.from({ length: count }, (_, index) => ({ id: prefix + index })),
  });
  const choose = (name, body) =>
    input().setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(body) });
  const preview = () => page.locator('.import-preview');
  for (const fail of [false, true]) {
    const first = `held-${fail ? 'failure' : 'success'}.json`;
    await choose(first, JSON.stringify(json('A', 1)));
    await page.waitForFunction((name) => !!window.backupReads[name], first);
    await page.getByRole('status').filter({ hasText: '正在读取备份文件' }).waitFor();
    assert.equal(
      await preview().count(),
      0,
      'pending replacement cannot confirm the previous backup',
    );
    await choose('second-B.json', JSON.stringify(json('B', 2)));
    await preview().getByText('2 道题目', { exact: true }).waitFor();
    await page.evaluate(({ name, fail }) => window.backupReads[name][fail ? 'fail' : 'success'](), {
      name: first,
      fail,
    });
    // The held promise is settled before the next browser round trip; the
    // stale callback must not change either the preview or its error banner.
    assert.match(await preview().innerText(), /second-B\.json/);
    assert.match(await preview().innerText(), /2 道题目/);
    assert.equal(await page.getByText('旧文件读取失败', { exact: true }).count(), 0);
    checks.push(
      fail
        ? '旧备份读取失败不污染新文件预览，用户可继续确认新文件'
        : '旧备份迟到成功不替换新文件，文件名和预览题量一致',
    );
  }
  await choose('invalid-C.json', '{invalid');
  await page.locator('.notice.error').waitFor();
  assert.equal(await preview().count(), 0);
  assert.match(await page.locator('.import-dropzone').innerText(), /invalid-C\.json/);
  assert.equal(await page.getByRole('button', { name: '确认合并导入', exact: true }).count(), 0);
  await choose('recovered-D.json', JSON.stringify(json('D', 3)));
  await preview().getByText('3 道题目', { exact: true }).waitFor();
  assert.match(await preview().innerText(), /recovered-D\.json/);
  checks.push('无效JSON保留所选文件名并阻止导入，重新选文件可恢复且无旧数据混入');
  await choose('shared.json', JSON.stringify({ ...json('S', 1), format: 'learning-share' }));
  await page.getByRole('alert').filter({ hasText: '这是分享包' }).waitFor();
  assert.equal(await preview().count(), 0);
  assert.equal(await page.getByRole('button', { name: '确认合并导入', exact: true }).count(), 0);
  assert.equal(
    await page.getByRole('link', { name: '导入分享包', exact: true }).getAttribute('href'),
    '#/sharing',
  );
  checks.push('分享包不能通过可信备份入口跳过审核，提示使用正确导入入口');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: resolve(h.folder, 'backup-mobile.png'), fullPage: true });
  h.assertClean();
  await writeFile(
    resolve(h.folder, 'report.json'),
    JSON.stringify(
      {
        passed: checks.length,
        checks,
        errors: h.errors,
        external: h.external,
        database: ':memory:',
        provider: 'none',
        imported: false,
      },
      null,
      2,
    ),
  );
  await rm(resolve(h.folder, 'failure.json'), { force: true });
  await rm(resolve(h.folder, 'failure.png'), { force: true });
  console.log(JSON.stringify({ passed: checks.length, checks }));
} catch (error) {
  await h.captureFailure(error, { checks });
  throw error;
} finally {
  await h.close();
}
