/** Online rubric diagnostics: in-memory content, no real model or operator DB. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const h = await startBrowserHarness({
  name: 'rubric-quality-ui',
  setup: String.raw`
const {learningSeed,fixtureQuestion}=await import('./tests/fixtures/learning-seed.ts');
const seed=learningSeed();
const malformed='### 必要核对点\n\n1. 说明整体回滚。\n2. ...';
const badMath='1. 结果采用 $\\unsupportedRubricCommand{x}$。';
seed.questions=[
 fixtureQuestion('RQ-SHORT','short_answer',{title:'标准格式验收',gradingRequirements:malformed}),
 fixtureQuestion('RQ-EMPTY','short_answer',{title:'标准可空验收',gradingRequirements:'',answerMarkdown:'',explanationMarkdown:'',sourceRefs:[]}),
 fixtureQuestion('RQ-PLAIN','short_answer',{title:'字面符号验收',mathEnabled:false,gradingRequirements:badMath}),
 fixtureQuestion('RQ-MATH','short_answer',{title:'公式标准验收',mathEnabled:true,gradingRequirements:badMath}),
 fixtureQuestion('RQ-GROUP','group',{title:'组合标准继承验收',mathEnabled:true,parts:[
  {id:'inherit',title:'继承公式',type:'short_answer',stemMarkdown:'解释表达式。',answerMarkdown:'条件应满足题意。',explanationMarkdown:'',options:[],correctAnswers:[],gradingRequirements:badMath},
  {id:'disabled',title:'关闭公式',type:'essay',mathEnabled:false,stemMarkdown:'解释字面符号。',answerMarkdown:'仅作为文本。',explanationMarkdown:'',options:[],correctAnswers:[],gradingRequirements:badMath},
  {id:'objective',title:'客观小题',type:'true_false',stemMarkdown:'核查结论。',answerMarkdown:'正确',explanationMarkdown:'',options:[],correctAnswers:['true']}
 ]}),
];
const imported=await app.inject({method:'POST',url:'/api/import',payload:{mode:'merge',data:seed}});assert.equal(imported.statusCode,200,imported.body);
const paper=await app.inject({method:'POST',url:'/api/papers',payload:{title:'题集标准格式验收',mode:'manual',questionIds:['RQ-MATH'],scoring:{enabled:false}}});assert.equal(paper.statusCode,201,paper.body);
return{paperId:paper.json().id,malformed,badMath};
`,
});
const { page, origin, state } = h,
  checks = [],
  aiWrites = [];
page.on('request', (request) => {
  if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/ai/'))
    aiWrites.push(request.url());
});
const api = async (path, method = 'GET', data) => {
  const response = await page.request.fetch(origin + path, {
    method,
    ...(data === undefined ? {} : { data }),
  });
  assert.ok(response.ok(), await response.text());
  return response.json();
};
const go = (hash) => page.goto(origin + '/?rubric-quality=' + Date.now() + hash);
const field = (label = '原题判题要求') => page.getByLabel(label, { exact: true });
const hints = (label = '原题判题要求') => page.getByLabel(label + '格式提示', { exact: true });
const editor = (label = '原题判题要求') =>
  page.locator('.question-grading-field').filter({ has: field(label) });
const wait = async (predicate, message) => {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw Error('Timeout: ' + message);
};
async function scan(questionId) {
  let scan = await api('/api/content-quality/scans', 'POST', { filters: { questionId } });
  while (scan.status === 'ready')
    scan = await api('/api/content-quality/scans/' + scan.id + '/process', 'POST', {
      batchSize: 100,
    });
  assert.equal(scan.status, 'completed');
  return api('/api/content-quality/issues?questionId=' + questionId + '&status=all&pageSize=100');
}
try {
  await go('#/questions/RQ-EMPTY/edit');
  await field().waitFor();
  assert.equal(await field().getAttribute('required'), null);
  assert.equal(await hints().count(), 0);
  await page.getByRole('button', { name: '保存题目', exact: true }).click();
  await page.waitForURL(/#\/questions\/RQ-EMPTY$/);
  assert.equal((await api('/api/questions/RQ-EMPTY')).gradingRequirements, '');
  assert.equal((await scan('RQ-EMPTY')).total, 0);
  checks.push('判题标准、来源与独立解析可空，编辑保存和在线扫描均不增加必填门槛');

  await go('#/questions/RQ-SHORT/edit');
  await hints().waitFor();
  assert.equal(await hints().evaluate((node) => node.open), false);
  await hints().locator('summary').click();
  assert.match(await hints().innerText(), /条目只有标点.*第4行/);
  assert.match(await hints().locator('pre').innerText(), /\.\.\./);
  await editor().getByRole('tab', { name: '预览', exact: true }).click();
  await hints().getByRole('button', { name: '定位第4行', exact: true }).click();
  await wait(
    async () => await field().evaluate((node) => node === document.activeElement),
    'located source field',
  );
  assert.equal(
    await field().evaluate((node) => node.selectionStart),
    state.malformed.indexOf('...'),
  );
  assert.equal(await field().isVisible(), true);
  checks.push('格式提示默认收起，显示行号和原文，可从预览切回编辑并定位选中问题');

  await field().fill('1. 整体成功或失败回滚。');
  assert.equal(await hints().count(), 0);
  await field().fill('1. ...');
  await field().fill('1. 完整说明整体提交与回滚。');
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(await hints().count(), 0);
  await field().fill(state.malformed + '\n');
  await hints().waitFor();
  await page.getByRole('button', { name: '保存题目', exact: true }).click();
  await page.waitForURL(/#\/questions\/RQ-SHORT$/);
  assert.equal((await api('/api/questions/RQ-SHORT')).gradingRequirements, state.malformed);
  const initial = await scan('RQ-SHORT');
  const issue = initial.items.find((item) => item.rule === 'rubric_format');
  assert.ok(issue);
  assert.equal(initial.total, 1);
  assert.match(issue.evidence, /gradingRequirements 第4行/);
  assert.equal((await scan('RQ-SHORT')).total, 1);
  checks.push('快速修订不显示旧提示，格式提示不阻保存，扫描持久化定位证据且重复扫描幂等');

  await go(
    '#/questions/RQ-SHORT/edit?returnTo=' +
      encodeURIComponent('#/content-quality') +
      '&qualityIssueId=' +
      issue.id,
  );
  const quality = page.getByRole('region', { name: '本题质量问题', exact: true });
  await quality.getByText('判题标准格式', { exact: true }).waitFor();
  await field().fill('1. 说明整体提交。\n2. 说明失败回滚。');
  await page.getByRole('button', { name: '保存题目', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '保存前核对质量问题', exact: true });
  await confirm.waitFor();
  await confirm.getByRole('button', { name: '保存并继续处理', exact: true }).click();
  await wait(
    async () =>
      (await api('/api/questions/RQ-SHORT')).gradingRequirements.includes('2. 说明失败回滚'),
    'fixed rubric saved',
  );
  const after = await scan('RQ-SHORT');
  assert.equal(after.items.find((item) => item.id === issue.id).status, 'stale');
  assert.equal((await api('/api/questions/RQ-SHORT')).status, 'published');
  checks.push('持久化问题进入现有编辑面板，修正文案后仍显式处理状态，发布状态保持');

  await go('#/questions/RQ-GROUP/edit');
  await hints('小题1原题判题要求').waitFor();
  await hints('小题1原题判题要求').locator('summary').click();
  assert.match(await hints('小题1原题判题要求').innerText(), /公式：.*第1行/);
  assert.equal(await hints('小题2原题判题要求').count(), 0);
  assert.equal(await field('小题3原题判题要求').count(), 0);
  const groupIssues = (await scan('RQ-GROUP')).items;
  assert.equal(groupIssues.filter((item) => item.rule === 'math_syntax').length, 1);
  assert.equal(groupIssues.find((item) => item.rule === 'math_syntax').partId, 'inherit');
  checks.push('组合主观小题继承公式开关，显式关闭时只检查文本，客观小题不显示主观标准输入');

  await go('#/questions/RQ-PLAIN/edit');
  await field().waitFor();
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(await hints().count(), 0);
  await editor().getByLabel('公式排版', { exact: true }).check();
  await hints().waitFor();
  await hints().locator('summary').click();
  assert.match(await hints().innerText(), /公式：/);
  await editor().getByLabel('公式排版', { exact: true }).uncheck();
  assert.equal(await hints().count(), 0);
  checks.push('本地检查跟随当前公式开关，关闭后不误报字面美元符号或迟到的公式结果');

  await go('#/papers/' + state.paperId + '/edit');
  await page.getByRole('button', { name: '全卷预览与调整', exact: true }).click();
  const preview = page.getByRole('dialog', { name: '全卷预览与调整', exact: true });
  await preview.getByLabel('RQ-MATH 判题要求来源', { exact: true }).selectOption('custom');
  await hints('RQ-MATH 本集判题要求').waitFor();
  await hints('RQ-MATH 本集判题要求').locator('summary').click();
  assert.match(await hints('RQ-MATH 本集判题要求').innerText(), /公式：/);
  assert.equal((await api('/api/questions/RQ-MATH')).gradingRequirements, state.badMath);
  checks.push('全卷预览的自定义标准沿用题目公式设置和同一编辑检查，不回写源题');

  await go('#/questions/RQ-MATH/edit');
  await hints().waitFor();
  await hints().locator('summary').click();
  for (const theme of ['green', 'dark']) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    await hints().scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    const colors = await hints().evaluate((node) => ({
      background: getComputedStyle(node).backgroundColor,
      color: getComputedStyle(node).color,
    }));
    assert.notEqual(colors.background, colors.color);
    await page.screenshot({ path: resolve(h.folder, 'rubric-hints-' + theme + '-mobile.png') });
  }
  assert.deepEqual(aiWrites, []);
  h.assertClean();
  checks.push('390px默认与暗色提示无横向溢出，检查不触发模型请求');
  const report = {
    passed: checks.length,
    checks,
    errors: h.errors,
    externalRequests: h.external,
    aiWrites,
    isolated: true,
  };
  await writeFile(resolve(h.folder, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await h.captureFailure(error, { checks });
  throw error;
} finally {
  await h.close();
}
