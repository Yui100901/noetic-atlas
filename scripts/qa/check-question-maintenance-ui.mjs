/** Persistent editor/revision acceptance against one disposable memory DB. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const h = await startBrowserHarness({
  name: 'question-maintenance-ui',
  setup: String.raw`
const {learningSeed,fixtureQuestion}=await import('./tests/fixtures/learning-seed.ts');
const seed=learningSeed();seed.questions=[fixtureQuestion('MAINT-Q','short_answer',{title:'内容维护示例',answerMarkdown:'最初的参考答案',explanationMarkdown:'说明整体提交与回滚。',gradingRequirements:'说明整体提交与回滚。'})];
const imported=await app.inject({url:'/api/import',method:'POST',payload:{mode:'merge',data:seed}});assert.equal(imported.statusCode,200,imported.body);return{};
`,
});
const { page, origin } = h,
  checks = [],
  writes = [];
page.on('request', (request) => {
  if (['POST', 'PUT', 'DELETE'].includes(request.method()))
    writes.push({ method: request.method(), path: new URL(request.url()).pathname });
});
const api = async (path, method = 'GET', data) => {
  const response = await page.request.fetch(origin + path, {
    method,
    ...(data === undefined ? {} : { data }),
  });
  assert.ok(response.ok(), await response.text());
  return response.json();
};
const question = () => api('/api/questions/MAINT-Q');
const drafts = (id) =>
  api('/api/question-drafts?' + new URLSearchParams(id ? { questionId: id } : {}));
const revisions = () => api('/api/questions/MAINT-Q/revisions?pageSize=100');
const field = (name) => page.getByLabel(name, { exact: true });
const button = (name) => page.getByRole('button', { name, exact: true });
const answer = () => field('参考答案');
const panel = () => page.getByRole('region', { name: '题目内容维护', exact: true });
let tick = 0;
const edit = async (id = 'MAINT-Q') => {
  await page.goto(
    origin + '/?maintenance=' + ++tick + '#/questions/' + id + (id === 'new' ? '' : '/edit'),
  );
  await field('标题 *').waitFor();
};
const wait = async (predicate, message) => {
  for (let i = 0; i < 120; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error(message);
};
async function openDrafts() {
  if (!(await page.getByRole('region', { name: '题目编辑草稿列表', exact: true }).count()))
    await panel()
      .getByRole('button', { name: /^编辑草稿/ })
      .click();
}
async function openHistory() {
  if (!(await page.getByRole('region', { name: '题目修订历史', exact: true }).count()))
    await panel().getByRole('button', { name: '修订历史', exact: true }).click();
  await page
    .getByRole('region', { name: '题目修订历史', exact: true })
    .getByText(/修订 #/)
    .first()
    .waitFor();
}
async function selectRevision(sequence) {
  await openHistory();
  const size = field('修订历史每页数量');
  if (await size.count()) await size.selectOption('20');
  const row = page
    .locator('.question-revision-history .question-maintenance-item')
    .filter({ hasText: new RegExp('修订 #' + sequence + ' ·') });
  await row.getByRole('button', { name: /查看差异|正在查看/ }).click();
  await page
    .getByRole('heading', { name: `修订 #${sequence} 与当前原题对照`, exact: true })
    .waitFor();
}
async function saveSource() {
  await button('保存题目').click();
  await page.waitForURL(/#\/questions\/MAINT-Q$/);
}
try {
  await edit('new');
  await button('保存编辑草稿').click();
  await wait(async () => (await drafts()).total === 1, 'blank new-question draft saved');
  assert.equal((await drafts()).items[0].questionId, null);
  await page.reload();
  await field('标题 *').waitFor();
  await openDrafts();
  await button('继续此草稿').click();
  await panel().getByText('正在继续编辑草稿', { exact: true }).waitFor();
  assert.equal(await field('标题 *').inputValue(), '');
  await field('标题 *').fill('尚未完成的新题');
  await field('参考来源').fill('来源 |');
  await button('保存编辑草稿').click();
  await wait(
    async () =>
      (await drafts()).total === 1 && (await drafts()).items[0].title === '尚未完成的新题',
    'continue overwrites the same new draft',
  );
  await page.reload();
  await field('标题 *').waitFor();
  await openDrafts();
  await button('继续此草稿').click();
  await panel().getByText('正在继续编辑草稿', { exact: true }).waitFor();
  assert.equal(await field('参考来源').inputValue(), '来源 |');
  assert.equal((await api('/api/questions?status=all')).total, 1);
  checks.push('空白与不完整新题可保存，刷新后恢复原始来源文本，继续覆盖同一草稿且不发布题目');

  await edit();
  await answer().fill('草稿中的参考答案');
  await field('参考来源').fill('尚未填完的来源 |');
  await panel().locator('.question-revision-reason > summary').click();
  await field('本次修改原因').fill('完善参考结论');
  await button('保存编辑草稿').click();
  await wait(async () => (await drafts('MAINT-Q')).total === 1, 'existing-question draft saved');
  const firstDraft = (await drafts('MAINT-Q')).items[0];
  await answer().fill('草稿中的参考答案，继续补充');
  await button('保存编辑草稿').click();
  await wait(
    async () => (await drafts('MAINT-Q')).items[0].updatedAt !== firstDraft.updatedAt,
    'existing draft updated',
  );
  assert.equal((await drafts('MAINT-Q')).items[0].id, firstDraft.id);
  assert.equal((await question()).answerMarkdown, '最初的参考答案');
  await page.reload();
  await field('标题 *').waitFor();
  await openDrafts();
  await button('继续此草稿').click();
  await panel().getByText('正在继续编辑草稿', { exact: true }).waitFor();
  assert.equal(await answer().inputValue(), '草稿中的参考答案，继续补充');
  assert.equal(await field('本次修改原因').inputValue(), '完善参考结论');
  await field('参考来源').fill('参考资料 | https://example.test/material');
  await saveSource();
  assert.equal((await drafts('MAINT-Q')).total, 0);
  assert.equal((await question()).status, 'published');
  const versions = await revisions();
  assert.equal(versions.total, 2);
  assert.equal(versions.items[0].reason, '完善参考结论');
  await edit();
  await panel().locator('.question-revision-reason > summary').click();
  await field('本次修改原因').fill('仅填写原因，没有改动正文');
  await saveSource();
  assert.equal((await revisions()).total, 2);
  checks.push('草稿继续与覆盖保留修改原因，正式保存原子清草稿，首次编辑保留基线及新修订');

  await edit();
  await answer().fill('本地冲突草稿');
  await button('保存编辑草稿').click();
  await wait(async () => (await drafts('MAINT-Q')).total === 1, 'conflict draft saved');
  const current = await question();
  await api('/api/questions/MAINT-Q', 'PUT', { ...current, answerMarkdown: '其他窗口更新的答案' });
  await openDrafts();
  await button('继续此草稿').click();
  await field('草稿版本冲突').waitFor();
  assert.equal(await answer().inputValue(), '本地冲突草稿');
  await button('保存题目').click();
  assert.equal((await question()).answerMarkdown, '其他窗口更新的答案');
  await button('已核对，以当前原题为基础').click();
  await saveSource();
  assert.equal((await question()).answerMarkdown, '本地冲突草稿');
  checks.push('源题远端更新后载入草稿仍保留表单，读取最新基线、对照并明确重定后才能保存');

  await edit();
  await answer().fill('当前未保存的手动编辑');
  const beforeConflict = await question();
  await api('/api/questions/MAINT-Q', 'PUT', { ...beforeConflict, answerMarkdown: '再次远端更新' });
  await button('保存题目').click();
  await field('草稿版本冲突').waitFor();
  assert.equal(await answer().inputValue(), '当前未保存的手动编辑');
  await button('保存编辑草稿').click();
  await wait(
    async () => (await drafts('MAINT-Q')).total === 1,
    'failed source save can still recover to draft',
  );
  await openDrafts();
  const recoverable = (await drafts('MAINT-Q')).items[0];
  await button(`删除编辑草稿 ${recoverable.id}`).click();
  await wait(async () => (await drafts('MAINT-Q')).total === 0, 'draft deleted');
  assert.equal(await answer().inputValue(), '当前未保存的手动编辑');
  assert.equal((await question()).answerMarkdown, '再次远端更新');
  checks.push('正常保存遭遇版本冲突保留本地编辑，仍可另存与删除草稿，删除不会丢掉当前表单');

  await edit();
  await selectRevision(1);
  await button('载入此版本到编辑器').click();
  assert.equal(await answer().inputValue(), '最初的参考答案');
  assert.equal((await question()).answerMarkdown, '再次远端更新');
  await saveSource();
  await edit();
  await selectRevision(2);
  await button('恢复此版本并保存').click();
  await wait(
    async () => (await revisions()).items[0].origin === 'restore',
    'restore creates a new revision',
  );
  assert.equal((await question()).answerMarkdown, '草稿中的参考答案，继续补充');
  assert.equal((await question()).status, 'published');
  checks.push('修订可先载入编辑预览，也可确认恢复成新修订，保持当前审核状态');

  await selectRevision(1);
  const protectedQuestion = await question(),
    protectedCount = (await revisions()).total;
  const failedRestore = async (route) =>
    route.fulfill({
      status: 400,
      json: { error: { code: 'ASSET_NOT_FOUND', message: '历史内容引用的图片不存在，恢复未完成' } },
    });
  await page.route('**/api/questions/MAINT-Q/revisions/*/restore', failedRestore);
  await button('恢复此版本并保存').click();
  await panel().getByText('历史内容引用的图片不存在，恢复未完成', { exact: true }).waitFor();
  assert.equal((await question()).answerMarkdown, protectedQuestion.answerMarkdown);
  assert.equal((await revisions()).total, protectedCount);
  await page.unroute('**/api/questions/MAINT-Q/revisions/*/restore', failedRestore);
  checks.push('历史引用不可恢复的失败明确显示，原题与修订计数不变');

  const headers = (await revisions()).items,
    a = headers[0],
    b = headers[1];
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const oldDetail = async (route) => {
    await held;
    await route.continue().catch(() => {});
  };
  await page.route(`**/api/questions/MAINT-Q/revisions/${a.id}`, oldDetail);
  const started = page.waitForRequest((request) => request.url().endsWith('/revisions/' + a.id));
  await page
    .locator('.question-revision-history .question-maintenance-item')
    .filter({ hasText: `修订 #${a.sequence} ·` })
    .getByRole('button', { name: /查看差异|正在查看/ })
    .click();
  await started;
  assert.equal(await button('恢复此版本并保存').count(), 0);
  await selectRevision(b.sequence);
  release();
  await page
    .getByRole('heading', { name: `修订 #${b.sequence} 与当前原题对照`, exact: true })
    .waitFor();
  await page.unroute(`**/api/questions/MAINT-Q/revisions/${a.id}`, oldDetail);
  assert.equal(
    await page
      .getByRole('heading', { name: `修订 #${a.sequence} 与当前原题对照`, exact: true })
      .count(),
    0,
  );
  checks.push('迟到修订详情不能覆盖新选择，切换请求期间隐藏旧恢复按钮');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  );
  await panel().screenshot({ path: resolve(h.folder, 'maintenance-dark-mobile.png') });
  await edit();
  await answer().fill('保存失败仍然保留的内容');
  let releaseDraft;
  const draftWait = new Promise((resolve) => {
    releaseDraft = resolve;
  });
  const slowDraft = async (route) => {
    await draftWait;
    await route.continue().catch(() => {});
  };
  await page.route('**/api/question-drafts', slowDraft);
  const draftStarted = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/api/question-drafts'),
  );
  await button('保存编辑草稿').click();
  await draftStarted;
  await page.locator('a.back-link').first().click();
  assert.match(page.url(), /\/edit$/);
  releaseDraft();
  await wait(async () => await button('保存编辑草稿').isEnabled(), 'draft write finished');
  await page.unroute('**/api/question-drafts', slowDraft);
  await page.locator('a.back-link').first().click();
  await page.waitForURL(/#\/questions\/MAINT-Q$/);
  checks.push('390px暗色无溢出，草稿保存中阻止离开，保存完成且未再改后可直接离开');
  h.assertClean();
  assert.ok(writes.every((item) => !item.path.startsWith('/api/ai/')));
  await writeFile(
    resolve(h.folder, 'report.json'),
    JSON.stringify(
      {
        passed: checks.length,
        checks,
        errors: h.errors,
        externalRequests: h.external,
        isolated: true,
        database: ':memory:',
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: checks.length, checks }));
} catch (error) {
  await h.captureFailure(error, { checks });
  throw error;
} finally {
  await h.close();
}
