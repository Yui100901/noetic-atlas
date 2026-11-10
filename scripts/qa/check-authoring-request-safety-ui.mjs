import { zipSync } from 'fflate';
import { createHash } from 'node:crypto';
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
    await page.goto(`${origin}/#/analytics?tab=ai&mode=all`);
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

  await page.goto(`${origin}/#/sharing?tab=package`);
  const panel = page.getByRole('region', { name: '导入内容数据包' });
  await panel.waitFor();
  await page.evaluate(() => {
    const original = File.prototype.arrayBuffer;
    window.backupReads = {};
    File.prototype.arrayBuffer = function () {
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
  const encode = (value) => Buffer.from(JSON.stringify(value));
  const zip = (title, count, share = false) => {
    const path = 'data/questions.json';
    const payload = encode({
      ...(share
        ? { format: 'learning-share', title, exportedAt: '2026-11-04T00:00:00Z' }
        : { documents: [] }),
      schemaVersion: 1,
      domains: [],
      categories: [],
      tags: [],
      assets: [],
      papers: [],
      questionBanks: [],
      questions: Array.from({ length: count }, (_, i) => ({
        id: 'safety-' + i,
        title: '隔离测试题 ' + i,
        type: 'true_false',
        stemMarkdown: '测试题干',
        correctAnswers: ['true'],
        categoryIds: [],
        tagIds: [],
        status: 'published',
        createdAt: '2026-11-04T00:00:00Z',
        updatedAt: '2026-11-04T00:00:00Z',
      })),
    });
    return Buffer.from(
      zipSync({
        'manifest.json': encode({
          format: 'noetic-atlas-package',
          schemaVersion: 1,
          id: title,
          kind: share ? 'share' : 'migration',
          title,
          createdAt: '2026-11-04T00:00:00Z',
          payloads: [{ path }],
          files: [
            {
              path,
              mediaType: 'application/json',
              byteLength: payload.length,
              sha256: createHash('sha256').update(payload).digest('hex'),
            },
          ],
        }),
        [path]: payload,
      }),
    );
  };
  const choose = (name, buffer) =>
    panel
      .getByLabel('选择 ZIP 数据包', { exact: true })
      .setInputFiles({ name, mimeType: 'application/zip', buffer });
  const confirmImport = () => panel.getByRole('button', { name: '确认导入整个数据包' });
  for (const fail of [false, true]) {
    const first = `held-${fail ? 'failure' : 'success'}.zip`;
    await choose(first, zip('旧包A', 1));
    await page.waitForFunction((name) => !!window.backupReads[name], first);
    await panel.getByRole('status').filter({ hasText: '正在读取数据包' }).waitFor();
    assert.equal(await confirmImport().count(), 0);
    await choose('second-B.zip', zip('新包B', 2));
    await panel.getByRole('heading', { name: '新包B' }).waitFor();
    await page.evaluate(({ name, fail }) => window.backupReads[name][fail ? 'fail' : 'success'](), {
      name: first,
      fail,
    });
    assert.equal(await panel.getByRole('heading', { name: '新包B' }).count(), 1);
    assert.match(await panel.getByRole('row').filter({ hasText: '题目' }).first().innerText(), /2/);
    assert.equal(await panel.getByText('旧文件读取失败', { exact: true }).count(), 0);
    checks.push(fail ? '旧文件读取失败不污染新包预览' : '旧文件迟到成功不替换新包预览');
  }
  await choose('invalid-C.zip', Buffer.from('invalid ZIP'));
  await panel.getByRole('alert').waitFor();
  assert.equal(await confirmImport().count(), 0);
  assert.match(await panel.innerText(), /invalid-C\.zip/);
  await choose('recovered-D.zip', zip('恢复D', 3));
  await panel.getByRole('heading', { name: '恢复D' }).waitFor();
  assert.equal(await confirmImport().isDisabled(), true);
  checks.push('无效ZIP后可重新选择，可信迁移要求明确确认');
  await choose('shared.zip', zip('分享用途', 0, true));
  await panel.getByText('内容分享', { exact: true }).waitFor();
  assert.equal(
    await panel
      .getByRole('checkbox', { name: '我确认这是自己的备份或可信来源的迁移包。', exact: true })
      .count(),
    0,
  );
  checks.push('同一上传入口依据manifest识别分享用途并展示待审核规则');

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
