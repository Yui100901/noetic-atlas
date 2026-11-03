/** Delayed starts must not switch drafts or redirect after the learner leaves. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const harness = await startBrowserHarness({
  name: 'focus-entry-safety-ui',
  setup: `
const {Store}=await import('./server/core/store.ts');
const {questionSchema}=await import('./server/core/validation.ts');
const {DEFAULT_SETTINGS}=await import('./shared/models/settings.ts');
const {buildPaper}=await import('./server/modules/practice/service.ts');
const {exportData}=await import('./server/modules/transfer/migration.ts');
const store=new Store(':memory:');store.put('settings','system',structuredClone(DEFAULT_SETTINGS));
const cards=[{id:'WORD',title:'abandon',type:'short_answer',stemMarkdown:'解释abandon',answerMarkdown:'放弃',vocabulary:{language:'en',headword:'abandon',meaningPrompt:'放弃',acceptedAnswers:['abandon'],pronunciations:[{label:'英式',ipa:'əˈbændən',sourceLabel:'隔离测试',sourceUrl:'https://example.test/word',license:'测试',method:'manual'}]}},
{id:'CONCEPT',title:'沉没成本',type:'short_answer',stemMarkdown:'解释沉没成本',answerMarkdown:'已经发生且无法收回的支出',concept:{term:'沉没成本',meaningPrompt:'已经发生且无法收回的支出',acceptedAnswers:['沉没成本','sunk cost']}}];
for(const card of cards){const q=questionSchema.parse({...card,status:'published'});store.put('questions',q.id,q);const paper=buildPaper(store,{id:'P-'+q.id,title:card.title+'练习集',description:'',mode:'manual',questionIds:[q.id],practiceKind:q.vocabulary?'vocabulary':'concept'});store.put('papers',paper.id,paper);}
const imported=await app.inject({method:'POST',url:'/api/import',payload:{mode:'merge',data:exportData(store)}});assert.equal(imported.statusCode,200,imported.body);store.db.close();return {};`,
});
const { page, origin, folder } = harness,
  checks = [];
let release;
const api = async (path, method = 'GET', body) => {
  const response = await page.request.fetch(origin + path, {
    method,
    ...(body ? { data: body } : {}),
  });
  assert.ok(response.ok(), await response.text());
  return response.json();
};
const dialog = () => page.getByRole('dialog', { name: '开始专注复习' });
async function openReview(id) {
  await page.goto(`${origin}/#/papers/P-${id}?tab=review`);
  await page
    .locator('.focus-context-entry')
    .getByRole('button', { name: '专注复习', exact: true })
    .click();
  await dialog().waitFor();
}
async function holdCreate() {
  let held = false;
  await page.route('**/api/focus-sessions', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    held = true;
    await new Promise((resolve) => {
      release = resolve;
    });
    return route.continue();
  });
  const response = page.waitForResponse(
    (reply) =>
      reply.url() === origin + '/api/focus-sessions' && reply.request().method() === 'POST',
  );
  await dialog()
    .getByRole('button', { name: /开始新的复习|开始本次复习/, exact: true })
    .click();
  for (let n = 0; n < 100 && !held; n++) await page.waitForTimeout(25);
  assert.ok(held, 'new session request should be held');
  return { response };
}
try {
  for (const id of ['WORD', 'CONCEPT']) {
    await openReview(id);
    await dialog().getByLabel('复习方向', { exact: true }).selectOption('meaning_to_word');
    await dialog().getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '选择练习模式', exact: true }).click();
    await page.getByRole('menuitem', { name: '专注复习', exact: true }).click();
    await dialog().getByLabel('复习方向', { exact: true }).waitFor();
    await dialog().getByRole('button', { name: '取消', exact: true }).click();
  }
  checks.push('词汇与概念题集的复习页签、顶部菜单均可选择顺逆向');

  const old = await api('/api/focus-sessions', 'POST', {
    paperId: 'P-WORD',
    scope: 'all',
    count: 1,
  });
  await openReview('WORD');
  await dialog().getByLabel('复习范围', { exact: true }).selectOption('all');
  const pending = await holdCreate();
  const resume = dialog().locator(`a.focus-resume-item[href="#/focus-review/${old.id}"]`);
  assert.equal(await resume.isEnabled(), false);
  await resume.evaluate((element) => element.click());
  assert.match(page.url(), /papers\/P-WORD/);
  assert.equal(await dialog().getByLabel('复习方向', { exact: true }).isDisabled(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.screenshot({ path: resolve(folder, 'starting-mobile-dark.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  release();
  const created = await (await pending.response).json();
  await page.waitForURL(`**/#/focus-review/${created.id}`);
  await page.unroute('**/api/focus-sessions');
  checks.push('启动新会话时旧草稿和方向字段禁用，合成点击也不切换，成功只进入新会话');

  await openReview('WORD');
  await dialog().getByLabel('复习范围', { exact: true }).selectOption('all');
  await dialog().getByLabel('复习方向', { exact: true }).selectOption('meaning_to_word');
  await dialog().getByLabel('本次复习任务数', { exact: true }).fill('7');
  await page.route('**/api/focus-sessions', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'QA_START_FAILED', message: '隔离启动失败' } }),
        })
      : route.continue(),
  );
  await dialog().getByRole('button', { name: '开始新的复习', exact: true }).click();
  await dialog().getByText('隔离启动失败', { exact: true }).waitFor();
  assert.equal(
    await dialog().getByLabel('复习方向', { exact: true }).inputValue(),
    'meaning_to_word',
  );
  assert.equal(await dialog().getByLabel('本次复习任务数', { exact: true }).inputValue(), '7');
  assert.equal(await dialog().locator('a.focus-resume-item').first().isEnabled(), true);
  await page.unroute('**/api/focus-sessions');
  await dialog().locator(`a.focus-resume-item[href="#/focus-review/${old.id}"]`).click();
  await page.waitForURL(`**/#/focus-review/${old.id}`);
  checks.push('启动失败保留方向、数量和具体错误，恢复旧草稿可操作');

  await openReview('WORD');
  await dialog().getByLabel('复习范围', { exact: true }).selectOption('all');
  const late = await holdCreate();
  await page.evaluate(() => (location.hash = '#/questions'));
  await page.getByRole('heading', { name: '把知识，积累成自己的能力。', exact: true }).waitFor();
  release();
  await late.response;
  await page.waitForTimeout(500);
  assert.equal(new URL(page.url()).hash, '#/questions');
  await page.unroute('**/api/focus-sessions');
  checks.push('离开启动页后迟到成功响应不会劫持当前页面，测试端口与数据隔离');
  harness.assertClean();
  await writeFile(
    resolve(folder, 'report.json'),
    JSON.stringify(
      {
        passed: checks.length,
        checks,
        errors: harness.errors,
        external: harness.external,
        database: ':memory:',
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: checks.length, checks }));
} catch (error) {
  release?.();
  await harness.captureFailure(error, { checks });
  throw error;
} finally {
  await harness.close();
}
