import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildDataPackage } from '../../shared/packages/data-package.ts';
import { questionSchema } from '../../server/core/validation.ts';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const h = await startBrowserHarness({
  name: 'import-dedup-ui',
  viewport: { width: 390, height: 844 },
});
const { page, origin } = h,
  checks = [];
const source = questionSchema.parse({
  id: 'tcp-original',
  title: 'TCP握手',
  type: 'short_answer',
  stemMarkdown: 'TCP为何使用三次握手建立连接？',
  answerMarkdown: '确认双方的收发能力并同步初始序号。',
});
const incoming = questionSchema.parse({
  ...source,
  id: 'tcp-new-source',
  answerMarkdown: '确认双方收发能力、同步初始序号，并避免旧连接请求导致无效连接。',
});
async function api(path, options) {
  const response = await page.request.fetch(origin + path, options);
  assert.ok(response.ok(), await response.text());
  return response.json();
}
async function packet(questions) {
  return Buffer.from(
    await buildDataPackage({
      kind: 'question-template',
      title: '导入查重测试',
      payloads: [
        {
          path: 'data/questions.json',
          data: { format: 'learning-new-questions', schemaVersion: 1, questions },
        },
      ],
    }),
  );
}
async function load(questions) {
  await page.getByLabel('选择 ZIP 数据包').setInputFiles({
    name: 'dedup.zip',
    mimeType: 'application/zip',
    buffer: await packet(questions),
  });
  await page.getByRole('heading', { name: '题目查重', exact: true }).waitFor();
}
async function apply() {
  await page.getByRole('button', { name: '确认导入整个数据包', exact: true }).click();
  await page.getByText('数据包已完整导入。', { exact: false }).waitFor();
}
async function layout(name) {
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
    name,
  );
  await page.screenshot({ path: join(h.folder, name + '.png'), fullPage: true });
}
try {
  await api('/api/questions', { method: 'POST', data: source });
  await page.goto(origin + '/#/sharing?tab=template');
  const different = questionSchema.parse({
    id: 'argon',
    title: 'Argon lattice',
    type: 'short_answer',
    stemMarkdown: 'Describe an argon crystal.',
    answerMarkdown: 'A noble-gas solid.',
  });
  await load([{ ...source, id: 'duplicate-source' }, incoming, different]);
  assert.equal(
    await page.getByRole('button', { name: '确认导入整个数据包', exact: true }).isDisabled(),
    true,
  );
  checks.push('unresolved similar question disables package commit');
  await page.getByRole('button', { name: '查看差异', exact: true }).click();
  await page
    .locator('.import-compare-pane')
    .getByText(source.answerMarkdown, { exact: true })
    .first()
    .waitFor();
  await page
    .locator('.import-compare-pane')
    .getByText(incoming.answerMarkdown, { exact: true })
    .first()
    .waitFor();
  await layout('mobile-comparison');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await layout('desktop-comparison');
  checks.push('both original and incoming answers are visible in an inline responsive comparison');
  await page.getByRole('button', { name: '保留原题', exact: true }).click();
  await apply();
  assert.equal((await api('/api/questions?page=1&pageSize=10&status=all')).total, 2);
  assert.equal((await api('/api/questions/tcp-original')).answerMarkdown, source.answerMarkdown);
  checks.push('exact duplicate reused, keep-original skipped incoming, unrelated question added');
  await load([incoming]);
  await page.getByRole('button', { name: '查看差异', exact: true }).click();
  await page.getByRole('button', { name: '采用导入内容覆盖', exact: true }).click();
  await apply();
  assert.equal((await api('/api/questions/tcp-original')).answerMarkdown, incoming.answerMarkdown);
  assert.equal((await api('/api/questions?page=1&pageSize=10&status=all')).total, 2);
  checks.push('replace retains local identity and does not add a second bank row');
  await load([incoming]);
  await apply();
  assert.equal((await api('/api/questions?page=1&pageSize=10&status=all')).total, 2);
  checks.push('reimporting exact content adds zero questions');
  await load([{ ...incoming, answerMarkdown: '另一个需要保留的参考解释。' }]);
  await page.getByRole('button', { name: '保留两者', exact: true }).click();
  await apply();
  assert.equal((await api('/api/questions?page=1&pageSize=10&status=all')).total, 3);
  checks.push('keep-both creates an independent pending question');
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
