/** Synthetic records only; owns an ephemeral service and never touches operator data. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const harness = await startBrowserHarness({
  name: 'focus-review-ui',
  staticRoot: process.env.FOCUS_WEB_ROOT || 'dist/web',
  setup: `
const {Store}=await import('./server/core/store.ts');
const {questionSchema}=await import('./server/core/validation.ts');
const {DEFAULT_SETTINGS}=await import('./shared/models/settings.ts');
const {buildPaper}=await import('./server/modules/practice/service.ts');
const {exportData}=await import('./server/modules/transfer/migration.ts');
const store=new Store(':memory:');store.put('settings','system',structuredClone(DEFAULT_SETTINGS));
store.put('domains','D',{id:'D',name:'隔离领域',description:'',sortOrder:0});
store.put('categories','C',{id:'C',domainId:'D',parentId:null,name:'基础',description:'',sortOrder:0});
const values=[{id:'TF',title:'判断题',type:'true_false',stemMarkdown:'进程通常具有独立地址空间。',correctAnswers:['true'],answerMarkdown:'答案隐私标记'},
{id:'SA',title:'同步与互斥',type:'short_answer',stemMarkdown:'解释同步与互斥。',answerMarkdown:'答案隐私标记'},
{id:'WORD',title:'abandon',type:'short_answer',stemMarkdown:'abandon',answerMarkdown:'放弃',vocabulary:{language:'en',headword:'abandon',meaningPrompt:'放弃',acceptedAnswers:['abandon'],pronunciations:[{label:'英式',ipa:'əˈbændən',sourceLabel:'隔离测试',sourceUrl:'https://example.test/word',license:'测试',method:'manual'}]}},
{id:'GROUP',title:'程序阅读',type:'group',stemMarkdown:'for (;;) { break; }',parts:[{id:'a',title:'小题一',type:'true_false',stemMarkdown:'程序会结束。',correctAnswers:['true']},{id:'b',title:'小题二',type:'short_answer',stemMarkdown:'说明原因。',answerMarkdown:'break 结束循环。'}]}];
for(const value of values){const q=questionSchema.parse({...value,status:'published',domainIds:['D'],categoryIds:['C']});store.put('questions',q.id,q);store.putStudy({...store.study(q.id),notes:'笔记隐私标记',nextReviewAt:'2020-01-01T00:00:00.000Z'});const paper=buildPaper(store,{id:'P-'+q.id,title:'隔离复习 '+q.id,description:'',mode:'manual',questionIds:[q.id],...(q.id==='WORD'?{practiceKind:'vocabulary'}:{})});store.put('papers',paper.id,paper);}
const imported=await app.inject({method:'POST',url:'/api/import',payload:{mode:'merge',data:exportData(store)}});assert.equal(imported.statusCode,200,imported.body);store.db.close();return {};`,
});
const { page, origin, folder } = harness,
  checks = [];
const api = async (path, method = 'GET', body) =>
  page.evaluate(
    async ({ path, method, body }) => {
      const response = await fetch(path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    },
    { path, method, body },
  );
const wait = async (predicate) => {
  for (let i = 0; i < 60; i++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('condition timed out');
};
async function startPaper(id, direction) {
  await page.goto(`${origin}/#/papers/P-${id}`);
  await page.getByRole('button', { name: '选择练习模式', exact: true }).click();
  await page.getByRole('menuitem', { name: '专注复习' }).click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('复习范围', { exact: true }).selectOption('all');
  if (direction) await modal.getByLabel('复习方向', { exact: true }).selectOption(direction);
  await modal.getByRole('button', { name: /开始本次复习|开始新的复习/ }).click();
  await page.getByRole('article', { name: '专注复习会话' }).waitFor();
}
const sessionId = () => page.url().split('/focus-review/')[1];
try {
  await startPaper('TF');
  assert.equal(await page.getByText('答案隐私标记', { exact: true }).count(), 0);
  assert.equal(await page.getByText('笔记隐私标记', { exact: true }).count(), 0);
  await page.getByLabel('正确', { exact: true }).check();
  await page.getByRole('button', { name: '提交回答并核对' }).click();
  await page.getByRole('heading', { name: '参考答案与解析' }).waitFor();
  await page.getByRole('button', { name: /良好.*正常独立/ }).click();
  await page.getByRole('heading', { name: '本次复习已结束' }).waitFor();
  assert.equal((await api('/api/questions/TF/history')).summary.correct, 1);
  await page.getByRole('link', { name: '查看实际作答', exact: true }).click();
  await page
    .getByText('此处保留实际作答结果；回忆评级在专注复习会话中记录。', { exact: true })
    .waitFor();
  assert.equal(await page.locator('.attempt-review-scheduling').count(), 0);
  checks.push('题集入口、答案隐藏、客观作答、FSRS评级、总结与作答详情入口');

  await startPaper('SA');
  await page.getByRole('button', { name: '填写回答', exact: true }).click();
  await page.getByLabel('本次回答', { exact: true }).fill('先写下一段可恢复的回答。');
  await wait(async () => !(await page.getByText('正在暂存输入…', { exact: true }).count()));
  const draftId = sessionId();
  await page.waitForTimeout(1250);
  await page.getByRole('button', { name: '保存并退出', exact: true }).click();
  await page.waitForURL((url) => url.hash.includes('papers/P-SA?tab=review'));
  const paused = await api('/api/focus-sessions/' + draftId);
  assert.equal(paused.practiceTiming.running, false);
  await page.waitForTimeout(1200);
  assert.equal((await api('/api/focus-sessions/' + draftId)).elapsedSeconds, paused.elapsedSeconds);
  await page.getByRole('button', { name: '专注复习', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('link', { name: /已复习 0\/1/ })
    .click();
  await page.getByLabel('本次回答', { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel('本次回答', { exact: true }).inputValue(),
    '先写下一段可恢复的回答。',
  );
  await page.getByRole('button', { name: '提交回答并核对' }).click();
  await page.getByLabel('本次主观回答判定', { exact: true }).selectOption('partial');
  assert.equal(await page.getByRole('button', { name: /良好.*正常独立/ }).isDisabled(), true);
  await page.getByRole('button', { name: /重学.*想不起/ }).click();
  await page.getByRole('heading', { name: '本次复习已结束' }).waitFor();
  checks.push('草稿自动保存、退出暂停、原会话恢复、主观部分正确');

  await startPaper('WORD', 'meaning_to_word');
  assert.equal(await page.getByText('abandon', { exact: true }).count(), 0);
  await page.getByLabel('1. 词语', { exact: true }).fill('abandon');
  await page.getByRole('button', { name: '提交回答并核对' }).click();
  await page.getByRole('heading', { name: '参考答案与解析' }).waitFor();
  await page.getByRole('button', { name: /轻松.*几乎不费力/ }).click();
  await page.getByRole('heading', { name: '本次复习已结束' }).waitFor();
  checks.push('词卡逆向隐藏目标词并自动核对');

  await startPaper('GROUP');
  await page.locator('.group-material').waitFor();
  await page.getByRole('button', { name: '心答自评', exact: true }).click();
  await page.getByRole('button', { name: /我已回忆，核对答案/ }).click();
  await page.getByRole('button', { name: /良好.*正常独立/ }).click();
  await page.getByText('当前第 2 / 2 项', { exact: false }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(folder, 'focus-mobile.png'), fullPage: true });
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `horizontal overflow at ${width}`,
    );
  }
  const settings = await api('/api/settings');
  await api('/api/settings', 'PUT', { settings: { ...settings, theme: 'dark' } });
  await page.reload();
  await page.getByRole('article', { name: '专注复习会话' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(folder, 'focus-mobile-dark.png'), fullPage: true });
  await page.getByRole('button', { name: '跳过本题', exact: true }).click();
  await page.getByRole('heading', { name: '本次复习已结束' }).waitFor();
  assert.equal((await api('/api/questions/GROUP/history')).summary.answered, 0);
  checks.push('组合小题、共享材料、跳过不计作答、320/390/1440布局');

  await page.goto(`${origin}/#/learning/due`);
  await page.getByRole('button', { name: '专注复习', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /开始本次复习|开始新的复习/ })
    .click();
  await page.getByRole('article', { name: '专注复习会话' }).waitFor();
  await page.getByRole('button', { name: '心答自评', exact: true }).click();
  await page.locator('.focus-question h2').click();
  await page.keyboard.press('Space');
  await page.getByRole('heading', { name: '参考答案与解析' }).waitFor();
  await page.keyboard.press('3');
  await wait(async () => (await api('/api/focus-sessions/' + sessionId())).rated === 1);
  checks.push('实时待复习入口、心答模式与键盘快捷键');
  if (await page.getByRole('button', { name: '保存并退出', exact: true }).count())
    await page.getByRole('button', { name: '保存并退出', exact: true }).click();
  else await page.getByRole('link', { name: '返回待复习', exact: true }).click();
  await page.getByText('专注复习记录', { exact: true }).click();
  await page.locator('.focus-history-row').first().waitFor();
  checks.push('待复习中的专注复习记录');
  await startPaper('SA');
  await page.getByRole('button', { name: '填写回答', exact: true }).click();
  await page.route('**/api/focus-sessions/**/current', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'TEST_SAVE_FAILED', message: '隔离测试保存失败' } }),
    }),
  );
  const unsaved = '保存失败也不丢失的草稿';
  await page.getByLabel('本次回答', { exact: true }).fill(unsaved);
  await page.getByText('隔离测试保存失败', { exact: true }).waitFor();
  const before = page.url();
  await page.getByRole('button', { name: '保存并退出', exact: true }).click();
  await page.getByText('隔离测试保存失败', { exact: true }).waitFor();
  assert.equal(page.url(), before);
  assert.equal(await page.getByLabel('本次回答', { exact: true }).inputValue(), unsaved);
  await page.unroute('**/api/focus-sessions/**/current');
  await page.getByRole('button', { name: '保存并退出', exact: true }).click();
  await page.waitForURL((url) => url.hash.includes('papers/P-SA?tab=review'));
  checks.push('保存失败保留输入并阻止退出，恢复后可正常保存');
  harness.assertClean();
  await writeFile(resolve(folder, 'report.json'), JSON.stringify({ checks }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, checks }));
} catch (error) {
  await harness.captureFailure(error, { checks });
  throw error;
} finally {
  await harness.close();
}
