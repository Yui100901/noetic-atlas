/** Isolated multi-domain planning checks; never uses the operator database. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const harness = await startBrowserHarness({
  name: 'learning-plans-ui',
  staticRoot: process.env.PLAN_WEB_ROOT || 'dist/web',
  setup: `
const {Store}=await import('./server/core/store.ts');const {questionSchema}=await import('./server/core/validation.ts');const {DEFAULT_SETTINGS}=await import('./shared/models/settings.ts');const {exportData}=await import('./server/modules/transfer/migration.ts');
const store=new Store(':memory:');for(const [id,name] of [['A','计算机'],['B','英语']]){store.put('domains',id,{id,name,description:'',sortOrder:0});store.put('categories','C'+id,{id:'C'+id,name:name+'基础分类',domainId:id,parentId:null,description:'',sortOrder:0});}
for(let i=0;i<30;i++){const q=questionSchema.parse({id:'TF-'+i,title:'进程基础'+i,type:'true_false',stemMarkdown:'进程通常具有独立地址空间。',correctAnswers:['true'],answerMarkdown:'参考答案隐私标记',status:'published',categoryIds:['CA']});store.put('questions',q.id,q);}
const word=questionSchema.parse({id:'WORD',title:'abandon',type:'short_answer',stemMarkdown:'abandon',answerMarkdown:'放弃',categoryIds:['CB'],status:'published',vocabulary:{language:'en',headword:'abandon',meaningPrompt:'放弃',acceptedAnswers:['abandon'],pronunciations:[{label:'英式',ipa:'əˈbændən',sourceLabel:'隔离测试',sourceUrl:'https://example.test/word',license:'测试',method:'manual'}]}});store.put('questions',word.id,word);
const goal=(id,name,domainId,extra={})=>({id,name,enabled:true,domainId,categoryIds:['C'+domainId],tagIds:[],tagMode:'all',weekdays:[1,2,3,4,5,6,7],priority:3,weight:1,reviewPoints:0,newPoints:2,mode:'focus',direction:'default',...extra});
store.put('settings','system',{...structuredClone(DEFAULT_SETTINGS),dailyPush:{...DEFAULT_SETTINGS.dailyPush,enabled:false,timeZone:'UTC',allocationMode:'fixed',goals:[goal('G-A','后端基础','A',{priority:5,mode:'practice'}),goal('G-B','英语词卡','B',{newPoints:DEFAULT_SETTINGS.pointsByType.short_answer+DEFAULT_SETTINGS.pointsByType.fill_blank,direction:'both'})]}});
const result=await app.inject({method:'POST',url:'/api/import',payload:{mode:'merge',data:exportData(store)}});assert.equal(result.statusCode,200,result.body);store.db.close();return {};`,
});
const { page, origin, folder } = harness,
  checks = [];
const api = (path, method = 'GET', body) =>
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
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('condition timed out');
};
try {
  await page.goto(`${origin}/#/settings?tab=daily`);
  await page.getByLabel('计划范围', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('计划范围', { exact: true }).inputValue(), 'multi');
  await page.getByRole('button', { name: '添加学习目标', exact: true }).click();
  const added = page.locator('.learning-goal-editor').last();
  await added.getByLabel('目标名称', { exact: true }).fill('临时目标');
  await added.getByLabel('学习领域', { exact: true }).selectOption('A');
  await added.getByRole('checkbox', { name: '计算机基础分类', exact: true }).check();
  await added.getByRole('checkbox', { name: '启用此目标', exact: true }).uncheck();
  await page.getByRole('button', { name: '保存系统配置', exact: true }).click();
  await page
    .getByRole('region', { name: '系统配置保存操作', exact: true })
    .getByText('系统配置已保存', { exact: true })
    .waitFor();
  assert.equal((await api('/api/settings')).dailyPush.goals.length, 3);
  checks.push('多目标编辑、分类筛选、暂停与保存');
  await added.getByRole('button', { name: '移除目标', exact: true }).click();
  await page.getByLabel('开启每日推题', { exact: true }).check();
  await page.getByRole('button', { name: '保存系统配置', exact: true }).click();
  await wait(async () => !!(await api('/api/daily-push')).plan);
  await page.goto(`${origin}/#/papers`);
  const card = page
    .getByRole('region', { name: '每日学习计划' })
    .or(page.locator('.learning-plan-card'));
  await card.waitFor();
  let day = (await api('/api/daily-push')).plan;
  assert.equal(day.progress.total, 4);
  assert.equal(day.progress.completed, 0);
  await page.screenshot({ path: resolve(folder, 'plan-card-desktop.png'), fullPage: true });
  checks.push('按目标生成题集、总览卡片与去重任务');
  await page.getByRole('button', { name: '继续今日学习', exact: true }).click();
  await page.waitForURL((url) => url.hash.startsWith('#/attempts/'));
  const attemptId = page.url().split('/attempts/')[1],
    attempt = await api('/api/attempts/' + attemptId);
  assert.equal(attempt.questions.length, 2);
  await page.getByRole('radio', { name: /正确/ }).first().waitFor();
  for (const radio of await page.getByRole('radio', { name: /正确/ }).all()) await radio.check();
  await page.getByRole('button', { name: '交卷并查看解析', exact: true }).first().click();
  await wait(async () => (await api('/api/attempts/' + attemptId)).status === 'submitted');
  await page.getByRole('link', { name: '返回每日计划', exact: true }).click();
  await page.getByRole('heading', { name: day.title, exact: true }).waitFor();
  day = await api('/api/learning-plans/' + day.id);
  assert.equal(day.progress.completed, 2);
  checks.push('普通练习按目标启动、提交计进度并返回原计划');
  const wordGoal = page
    .locator('.learning-plan-goal')
    .filter({ has: page.getByRole('heading', { name: '英语词卡', exact: true }) });
  await wordGoal.getByRole('button', { name: '专注复习', exact: true }).click();
  await page.getByRole('article', { name: '专注复习会话' }).waitFor();
  const focusId = page.url().split('/focus-review/')[1];
  for (let i = 0; i < 2; i++) {
    const focus = await api('/api/focus-sessions/' + focusId);
    if (focus.current.direction === 'meaning_to_word')
      assert.equal(await page.getByText('abandon', { exact: true }).count(), 0);
    await page.getByRole('button', { name: '心答自评', exact: true }).click();
    await page.getByRole('button', { name: /我已回忆，核对答案/ }).click();
    await page.getByRole('heading', { name: '参考答案与解析', exact: true }).waitFor();
    await page.getByRole('button', { name: /良好.*正常独立/ }).click();
    await wait(async () => (await api('/api/focus-sessions/' + focusId)).rated === i + 1);
  }
  await page.getByRole('heading', { name: '本次复习已结束', exact: true }).waitFor();
  await page.getByRole('link', { name: '返回每日计划', exact: true }).click();
  await page.getByRole('heading', { name: day.title, exact: true }).waitFor();
  day = await api('/api/learning-plans/' + day.id);
  assert.equal(day.progress.completed, 4);
  assert.equal(day.progress.answered, 2);
  assert.equal((await api('/api/questions/WORD/history')).summary.answered, 0);
  checks.push('顺逆向专注复习、心答统计与计划完成分开');
  await page.getByLabel('完成状态', { exact: true }).selectOption('pending');
  await page.getByText('当前筛选没有任务。', { exact: true }).waitFor();
  await page.getByLabel('完成状态', { exact: true }).selectOption('all');
  await page.getByLabel('计划任务每页数量', { exact: true }).selectOption('10');
  await page.getByText('每日学习计划历史', { exact: true }).click();
  await page.locator('.learning-plan-history-row').first().waitFor();
  checks.push('目标和状态筛选、可调分页、历史安排');
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `overflow at ${width}`,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(folder, 'plan-mobile.png'), fullPage: true });
  const settings = await api('/api/settings');
  await api('/api/settings', 'PUT', { settings: { ...settings, theme: 'dark' } });
  await page.reload();
  await page.getByRole('heading', { name: day.title, exact: true }).waitFor();
  await page.screenshot({ path: resolve(folder, 'plan-mobile-dark.png'), fullPage: true });
  checks.push('320/390/1440布局与深色主题');
  await page.goto(`${origin}/#/analytics`);
  await page.getByRole('heading', { name: '学习目标完成情况', exact: true }).waitFor();
  const report = await api('/api/analytics?from=' + day.dateKey + '&to=' + day.dateKey);
  assert.equal(report.learningPlans.completedPoints, day.totalPoints);
  checks.push('学习统计与本周周报展示目标完成量');
  await page.goto(`${origin}/#/`);
  await page.getByRole('link', { name: /今日学习计划/ }).waitFor();
  checks.push('知识总览快速入口显示进度');
  harness.assertClean();
  await writeFile(resolve(folder, 'report.json'), JSON.stringify({ checks }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, checks }));
} catch (error) {
  await harness.captureFailure(error, { checks });
  throw error;
} finally {
  await harness.close();
}
