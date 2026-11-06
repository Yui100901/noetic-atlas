/** Usage UI uses real audit/provider parsing with an in-process synthetic
 * transport. No network model, working configuration or operator service. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const harness = await startBrowserHarness({
  name: 'ai-usage-ui',
  setup: `
const {configureAiTransport}=await import('./shared/ai/ai-transport.ts');
let calls=0;
configureAiTransport(async(_url,options)=>{
 const body=JSON.parse(options.body);calls++;
 if(body.model==='usage-failed')return {status:429,body:JSON.stringify({error:{message:'synthetic limit'}})};
 const usage=body.model==='usage-normal'?{prompt_tokens:100,completion_tokens:20,total_tokens:120,prompt_tokens_details:{cached_tokens:40}}:body.model==='usage-zero'?{input_tokens:0,output_tokens:0,total_tokens:0}:body.model==='usage-partial'?{input_tokens:9}:undefined;
 return {status:200,body:JSON.stringify({usage,choices:[{finish_reason:'stop',message:{content:JSON.stringify({ok:true,message:'合成连通性正常'})}}]})};
});
async function api(url,method='GET',payload,status=200){const response=await app.inject({url,method,...(payload===undefined?{}:{payload})});assert.equal(response.statusCode,status,response.body);return response.json();}
let expected;app.get('/qa/ai-usage-state',async()=>({calls,expected}));
for(const model of ['usage-normal','usage-unknown','usage-zero','usage-partial','usage-failed']){
 await api('/api/ai/settings','PUT',{enabled:true,baseUrl:'https://usage-fixture.invalid/v1',model,key:'synthetic-public-key',supportsImages:false,sendImages:false,timeoutSeconds:5,maxTokens:1000});
 await api('/api/ai/test','POST',{},model==='usage-failed'?502:200);
}
expected=await api('/api/ai/usage');assert.equal(expected.runs,5);assert.equal(expected.usage.totalTokens,120);assert.equal(expected.usage.inputTokens,109);assert.equal(expected.usage.status,'partial');
return {expected,calls};
`,
});
const { page, folder, origin } = harness;
const checks = [],
  geometry = [];
try {
  await page.goto(origin + '/#/ai?tab=history');
  const summary = page.getByRole('region', { name: 'AI用量统计', exact: true });
  const metric = (index) => summary.locator('.ai-usage-metrics').first().locator('dd').nth(index);
  await page.getByRole('heading', { name: '处理记录', exact: true }).waitFor();
  await metric(0).filter({ hasText: /^109$/ }).waitFor();
  assert.equal(await metric(2).innerText(), '120');
  assert.equal(await page.locator('.ai-history-item').count(), 5);
  assert.ok((await summary.innerText()).includes('3/5次调用有用量'));
  checks.push('实际provider/audit路径生成5条记录，跨调用已知用量及部分覆盖正确，失败调用保留');

  const model = page.getByLabel('AI记录模型', { exact: true });
  await model.fill('usage-zero');
  await metric(2).filter({ hasText: /^0$/ }).waitFor();
  await page.locator('.ai-history-item').filter({ hasText: 'usage-zero' }).waitFor();
  assert.equal(await page.locator('.ai-history-item').count(), 1);
  assert.ok((await summary.innerText()).includes('完整实报'));
  await page
    .locator('.ai-history-item')
    .getByRole('button', { name: '查看结果', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('region', { name: '本次Token用量', exact: true }).waitFor();
  assert.equal(await dialog.locator('.ai-usage-metrics dd').nth(0).innerText(), '0');
  assert.equal(await dialog.locator('.ai-usage-metrics dd').nth(3).innerText(), '未知');
  await dialog.getByRole('button', { name: /关闭/ }).first().click();
  checks.push('模型筛选同时作用于记录和聚合；真实0与未报告明细区分，单记录详情一致');

  await model.fill('usage-unknown');
  await metric(2)
    .filter({ hasText: /^未知$/ })
    .waitFor();
  await page.locator('.ai-history-item').filter({ hasText: 'usage-unknown' }).waitFor();
  assert.ok((await summary.innerText()).includes('未报告用量'));
  await model.fill('usage-partial');
  await metric(0).filter({ hasText: /^9$/ }).waitFor();
  assert.equal(await metric(2).innerText(), '未知');
  assert.ok((await summary.innerText()).includes('部分已知'));
  checks.push('缺失用量显示未知，只有输入计数时保留部分已知且不推算总量');

  await model.fill('');
  await metric(2).filter({ hasText: /^120$/ }).waitFor();
  await page.getByLabel('AI记录类型', { exact: true }).selectOption('grade');
  await page.getByText('还没有符合条件的AI处理记录', { exact: true }).waitFor();
  assert.ok((await summary.innerText()).includes('0条失败'));
  await page.getByLabel('AI记录类型', { exact: true }).selectOption('');
  await metric(2).filter({ hasText: /^120$/ }).waitFor();
  await page.getByRole('button', { name: '自定义', exact: true }).click();
  await page.getByLabel('开始日期', { exact: true }).fill('2000-01-01');
  await page.getByLabel('结束日期', { exact: true }).fill('2000-01-01');
  await page.getByRole('button', { name: '应用日期范围', exact: true }).click();
  await page.getByText('还没有符合条件的AI处理记录', { exact: true }).waitFor();
  await page.getByRole('button', { name: '全部记录', exact: true }).click();
  await metric(2).filter({ hasText: /^120$/ }).waitFor();
  checks.push('任务和日期筛选同步更新汇总与记录，清除筛选可恢复结果');

  await summary.locator('summary').filter({ hasText: '按服务、模型和任务查看' }).click();
  assert.equal(await summary.locator('.ai-usage-table tbody tr').count(), 5);
  assert.ok((await summary.innerText()).includes('跨模型总计为供应商原始数值之和'));
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await summary.scrollIntoViewIfNeeded();
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      `page horizontal overflow at ${width}px`,
    );
    const box = await summary.boundingBox();
    assert.ok(box && box.width <= width && box.width > 0);
    geometry.push({ width, summary: box });
    await page.screenshot({ path: resolve(folder, `usage-${width}.png`), fullPage: true });
  }
  checks.push('服务/模型/任务分组与分页可查看，1440和390布局无页面横向溢出');
  const state = await (await page.request.get(origin + '/qa/ai-usage-state')).json();
  assert.equal(state.calls, 5);
  harness.assertClean();
  await writeFile(
    resolve(folder, 'report.json'),
    JSON.stringify(
      {
        passed: checks.length,
        checks,
        geometry,
        calls: state.calls,
        simulatedProvider: true,
        isolated: true,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: checks.length, checks, geometry }));
} catch (error) {
  await harness.captureFailure(error, { checks, geometry });
  throw error;
} finally {
  await harness.close();
}
