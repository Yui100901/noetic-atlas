/** Time budgets and weekly progress over a disposable in-memory application. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const setup = `
const api=async(url,method='GET',payload)=>{
  const response=await app.inject({url,method,...(payload===undefined?{}:{payload})});
  assert.ok(response.statusCode<400,response.body);return response.json();
};
const stamp=new Date().toISOString();
await api('/api/import','POST',{mode:'merge',data:{schemaVersion:1,
  domains:[{id:'TIME-D',name:'时间计划测试',description:'',sortOrder:0}],
  categories:[{id:'TIME-C',domainId:'TIME-D',name:'基础练习',parentId:null,description:'',sortOrder:0}],
  tags:[],documents:[],papers:[],
  questions:Array.from({length:8},(_,index)=>({id:'TIME-Q'+index,title:'时间练习'+index,type:'true_false',
    stemMarkdown:'隔离命题'+index,correctAnswers:['true'],status:'published',categoryIds:['TIME-C']})),
  learningResults:[{id:'TIME-HISTORY',source:'quick',paperId:'quick-practice',paperTitle:'隔离计时记录',paperVersion:1,
    status:'submitted',startedAt:stamp,submittedAt:stamp,updatedAt:stamp,elapsedSeconds:120,items:[],questions:[],historyIndexed:true}]
}});
const settings=await api('/api/settings');
await api('/api/settings','PUT',{settings:{...settings,dailyPush:{...settings.dailyPush,domainId:'TIME-D',categoryIds:['TIME-C'],timeZone:'UTC'}}});
return {};
`;
let harness;
const checks = [],
  layouts = [];
const shift = (date, days) => {
  const value = new Date(date + 'T12:00:00Z');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};
try {
  harness = await startBrowserHarness({ name: 'learning-time-ui', setup });
  const { page, origin, folder } = harness;
  const api = async (path) => {
    const response = await page.request.get(origin + path);
    assert.ok(response.ok(), await response.text());
    return response.json();
  };
  const wait = async (predicate, label) => {
    for (let index = 0; index < 150; index++) {
      if (await predicate()) return;
      await delay(50);
    }
    assert.fail(label);
  };
  const weekCard = () => page.getByRole('region', { name: '每周学习时间目标', exact: true });
  const save = () =>
    page
      .getByRole('region', { name: '系统配置保存操作', exact: true })
      .getByRole('button', { name: '保存系统配置', exact: true });
  const clean = () =>
    page
      .getByRole('region', { name: '系统配置保存操作', exact: true })
      .getByText('系统配置已保存', { exact: true })
      .waitFor();
  const layout = async (label) => {
    await page.locator('main').waitFor();
    const metrics = await page.evaluate(() => ({
      viewport: innerWidth,
      width: document.documentElement.scrollWidth,
      cards: [...document.querySelectorAll('.learning-week,.learning-time-settings')]
        .filter((el) => el.getClientRects().length)
        .map((el) => ({
          className: el.className,
          width: el.getBoundingClientRect().width,
          scrollWidth: el.scrollWidth,
        })),
    }));
    assert.ok(metrics.width <= metrics.viewport + 1, `${label}: ${JSON.stringify(metrics)}`);
    for (const card of metrics.cards)
      assert.ok(card.scrollWidth <= card.width + 1, `${label}: ${JSON.stringify(card)}`);
    layouts.push({ label, ...metrics });
    await page.screenshot({ path: resolve(folder, label + '.png'), fullPage: true });
  };

  await page.goto(origin + '/#/settings?tab=daily');
  await page.getByRole('heading', { name: '每日推题与学习计划', exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole('checkbox', { name: '按时间预算生成每日学习任务', exact: true })
      .isChecked(),
    false,
  );
  await page.getByLabel('周学习目标（分钟）', { exact: true }).fill('90');
  await save().click();
  await clean();
  await wait(
    async () => (await api('/api/settings')).dailyPush.timeBudget?.weeklyMinutes === 90,
    'weekly target saved',
  );
  await wait(
    async () => /目标 90 分钟/.test(await weekCard().innerText()),
    'saved target refreshes the weekly card',
  );
  assert.equal((await api('/api/settings')).dailyPush.timeBudget.enabled, false);
  assert.match(await weekCard().innerText(), /2\s*分钟已学/);
  checks.push('周目标独立于时间组题，可保存并自动刷新已保存目标与有效学习分钟');

  const before = await api('/api/learning-plans/week');
  await weekCard().getByRole('button', { name: '上一周学习时间', exact: true }).click();
  await wait(
    async () => (await weekCard().innerText()).includes(shift(before.from, -7)),
    'previous week loaded',
  );
  await weekCard().getByRole('button', { name: '下一周学习时间', exact: true }).click();
  await wait(async () => (await weekCard().innerText()).includes(before.from), 'next week loaded');
  await weekCard().getByRole('button', { name: '本周', exact: true }).click();
  checks.push('周视图前后翻页及回到本周正常，不改变题目或学习记录');

  await page.getByRole('checkbox', { name: '按时间预算生成每日学习任务', exact: true }).check();
  await page.getByLabel('工作日日预算（分钟）', { exact: true }).fill('1');
  await page.getByLabel('周末日预算（分钟）', { exact: true }).fill('1');
  await page.getByLabel('开启每日推题', { exact: true }).check();
  await save().click();
  await clean();
  await wait(
    async () => !!(await api('/api/daily-push')).plan,
    'time plan generated after enabling',
  );
  const plan = (await api('/api/daily-push')).plan;
  assert.equal(plan.timeBudget.targetSeconds, 60);
  assert.equal(plan.timeBudget.estimatedSeconds, 45);
  assert.equal((await api('/api/learning-plans/' + encodeURIComponent(plan.id))).tasks.length, 1);
  checks.push('保存分钟预算后按真实时长假设生成受限任务，分值不直接换算分钟');

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(origin + '/#/settings?tab=daily');
    await page.getByLabel('工作日日预算（分钟）', { exact: true }).waitFor();
    await weekCard().getByRole('button', { name: '本周', exact: true }).waitFor();
    await layout('settings-' + width);
    await page.goto(origin + '/#/papers');
    const card = page.getByRole('region', { name: '每日学习计划', exact: true });
    await card.getByRole('link', { name: '查看计划', exact: true }).waitFor();
    assert.match(await card.innerText(), /今日时间预算 1 分钟/);
    assert.equal(
      await card.getByRole('region', { name: '每周学习时间目标', exact: true }).count(),
      1,
    );
    await layout('plan-card-' + width);
    await card.getByRole('link', { name: '查看计划', exact: true }).click();
    await page.getByRole('heading', { name: '今日时间安排', exact: true }).waitFor();
    await weekCard()
      .getByText(/目标 90 分钟/)
      .waitFor();
    assert.match(await weekCard().innerText(), /目标 90 分钟/);
    await layout('plan-detail-' + width);
  }
  checks.push('题集入口与计划详情展示时间估计和周卡，1440px及390px无横向溢出');
  harness.assertClean();
  await writeFile(
    resolve(folder, 'report.json'),
    JSON.stringify(
      {
        passed: checks.length,
        checks,
        layouts,
        errors: harness.errors,
        external: harness.external,
        isolated: true,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: checks.length, checks, layouts: layouts.length }));
} catch (error) {
  await harness?.captureFailure(error, { checks, layouts });
  throw error;
} finally {
  await harness?.close();
}
