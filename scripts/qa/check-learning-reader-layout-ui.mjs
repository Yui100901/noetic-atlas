/** Special-set readers must own their page layout, including cold route loads.
 * Every mutation below targets a disposable in-memory fixture, never port 4317. */
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { startBrowserHarness } from './helpers/browser-harness.mjs';

const baseline = process.env.QA_BASELINE === '1';
const fixture = `
const call=async(method,url,payload)=>{const response=await app.inject({method,url,...(payload===undefined?{}:{payload})});assert.ok(response.statusCode<400,url+': '+response.body);return response.json();};
let settings=await call('GET','/api/settings');
await call('PUT','/api/settings',{settings:{...settings,reviewScheduling:{...settings.reviewScheduling,strategy:'fixed'}}});
await call('POST','/api/domains',{id:'reader-layout',name:'阅读布局隔离领域'});
await call('POST','/api/categories',{id:'reader-layout-category',domainId:'reader-layout',name:'基础与场景'});
const questions=[];
for(let index=1;index<=23;index++)questions.push({id:'RL-'+String(index).padStart(2,'0'),title:'布局回归题 '+String(index).padStart(2,'0'),type:'true_false',stemMarkdown:'### 阅读条件\\n\\n事务提交后，已持久化的数据应在重启后保持。\\n\\n- 先理解事务边界。\\n- 再检查恢复条件。',answerMarkdown:'正确，持久性约束已提交事务的结果。',explanationMarkdown:'区分已提交事务、未提交修改与具体数据库实现。',correctAnswers:['true']});
questions.push({id:'RL-GROUP',title:'布局组合材料',type:'group',stemMarkdown:'公共程序材料：const values = [1, 2, 3]；后续两题共用这段程序。',parts:[{id:'first',title:'求和条件',type:'true_false',stemMarkdown:'数组元素之和为6。',correctAnswers:['true'],answerMarkdown:'正确。'},{id:'second',title:'长度条件',type:'true_false',stemMarkdown:'数组长度为3。',correctAnswers:['true'],answerMarkdown:'正确。'}]});
questions.push({id:'RL-WORD',title:'secretwordcanary',type:'short_answer',stemMarkdown:'secretwordcanary',answerMarkdown:'secretwordcanary is a protected reverse fixture.',explanationMarkdown:'This example contains secretwordcanary.',vocabulary:{language:'en',headword:'secretwordcanary',meaningPrompt:'an isolated definition used to test reverse recall without revealing the word',acceptedAnswers:['secretwordcanary'],pronunciations:[{label:'测试',ipa:'/test/',sourceLabel:'隔离合成数据',sourceUrl:'https://example.invalid/fixture',license:'fixture',method:'manual'}]}});
const saved=[];
for(const question of questions)saved.push(await call('POST','/api/questions',{...question,categoryIds:['reader-layout-category'],sourceRefs:[{label:'仅供布局测试的合成参考资料',url:'https://example.invalid/reference'}]}));
await call('POST','/api/questions/review',{ids:saved.map(q=>q.id),action:'approve',confirmed:true,expectedUpdatedAt:Object.fromEntries(saved.map(q=>[q.id,q.updatedAt]))});
const paper=await call('POST','/api/papers',{title:'布局回归来源题集',mode:'manual',questionIds:saved.filter(q=>q.id!=='RL-WORD').map(q=>q.id),scoring:{enabled:false}});
const attempt=await call('POST','/api/papers/'+paper.id+'/attempts');
const answers=Object.fromEntries(saved.filter(q=>q.type==='true_false').map(q=>[q.id,{value:'false'}]));
answers['RL-GROUP::first']={value:'false'};answers['RL-GROUP::second']={value:'false'};
await call('POST','/api/attempts/'+attempt.id+'/submit',{answers});
for(const q of saved)await call('PUT','/api/study/'+q.id,{favorite:true,notes:'隔离笔记：注意边界与适用条件。',nextReviewAt:'2000-01-01T00:00:00.000Z'});
for(const partId of ['first','second'])await call('PUT','/api/study/RL-GROUP',{partId,nextReviewAt:'2000-01-01T00:00:00.000Z',notes:'组合小题的隔离笔记。'});
return{paperId:paper.id,attemptId:attempt.id};`;

const qa = await startBrowserHarness({
  name: `learning-reader-layout${baseline ? '-baseline' : ''}`,
  staticRoot: process.env.QA_WEB_ROOT || 'dist/web',
  setup: fixture,
});
const { page, origin, folder } = qa;
const checks = [],
  samples = [],
  findings = [];
let serial = 0;
const api = async (path, method = 'GET', data) => {
  const response = await page.request.fetch(origin + path, {
    method,
    ...(data === undefined ? {} : { data }),
  });
  assert.ok(response.ok(), path + ': ' + (await response.text()));
  return response.json();
};
const go = async (href) => {
  await page.goto(
    origin + '/?reader-layout=' + ++serial + (href.startsWith('#') ? href : '#/' + href),
  );
  await page.waitForLoadState('networkidle');
};
const reader = () => page.getByRole('article', { name: '特殊题集题目详情', exact: true });
const ready = async () => {
  await reader()
    .locator('.question-viewer-reading .markdown:not([role="status"])')
    .first()
    .waitFor();
  await reader().getByRole('button', { name: '展开答案与解析', exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
};
const checkGeometry = async (name) => {
  const sample = await reader().evaluate((element) => {
    const reading = element.querySelector('.question-viewer-reading');
    const main = element.querySelector('.question-viewer-main');
    const aside = element.querySelector('.question-viewer-aside');
    const layout = element.querySelector('.question-viewer-layout');
    const rect = (node) => {
      const b = node.getBoundingClientRect();
      return { x: b.x, y: b.y, right: b.right, bottom: b.bottom, width: b.width, height: b.height };
    };
    const bounds = rect(element),
      readingStyle = getComputedStyle(reading);
    const visible = (node) =>
      node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
    const controls = [...element.querySelectorAll('input,textarea,select')]
      .filter(visible)
      .map((node) => ({
        bounds: rect(node),
        parent: rect(node.closest('.card') || element),
        label: node.getAttribute('aria-label') || node.name || node.tagName,
      }));
    const origin = element.querySelector('.learning-origins > ul');
    const group = element.querySelector('.group-material');
    const notes = element.querySelector('.question-viewer-notes');
    return {
      width: innerWidth,
      bounds,
      reading: rect(reading),
      main: rect(main),
      aside: rect(aside),
      columns: getComputedStyle(layout).gridTemplateColumns,
      leftPadding: parseFloat(readingStyle.paddingLeft),
      rightPadding: parseFloat(readingStyle.paddingRight),
      documentOverflow: document.documentElement.scrollWidth - innerWidth,
      controls,
      notes: notes ? rect(notes) : null,
      originDisplay: origin ? getComputedStyle(origin).display : null,
      groupPadding: group ? parseFloat(getComputedStyle(group).paddingLeft) : null,
    };
  });
  sample.name = name;
  const issues = [];
  if (sample.leftPadding < 16 || sample.rightPadding < 16)
    issues.push('question card lacks horizontal padding');
  if (sample.documentOverflow > 1) issues.push('document horizontally overflows');
  if (sample.width <= 1000) {
    if (
      Math.abs(sample.main.x - sample.aside.x) > 1 ||
      Math.abs(sample.main.width - sample.aside.width) > 2
    )
      issues.push('narrow page does not stack content and learning card');
    if (sample.aside.y < sample.main.bottom - 1) issues.push('learning card overlaps main content');
  } else if (sample.width === 1440 && sample.aside.x < sample.main.right + 8)
    issues.push('desktop page lost its separated learning column');
  for (const control of sample.controls)
    if (control.bounds.x < control.parent.x - 1 || control.bounds.right > control.parent.right + 1)
      issues.push('form control exceeds card: ' + control.label);
  if (sample.originDisplay && sample.originDisplay !== 'grid')
    issues.push('origin list styles missing on cold load');
  if (sample.groupPadding !== null && sample.groupPadding < 12)
    issues.push('group material lacks its own padding');
  if (sample.notes && sample.notes.y < sample.reading.bottom + 12)
    issues.push('notes touch or overlap the reading card');
  samples.push(sample);
  findings.push(...issues.map((issue) => ({ name, issue })));
  if (!baseline) assert.deepEqual(issues, [], name);
  return sample;
};
const capture = async (name) => {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.activeElement instanceof HTMLElement && document.activeElement.blur();
  });
  await page.screenshot({
    path: resolve(folder, name + '.png'),
    fullPage: true,
    animations: 'disabled',
  });
};
const globalHref = (kind, item, pageNumber = 1) =>
  '#/learning-reader?' +
  new URLSearchParams({ scope: 'global', kind, item, page: String(pageNumber), pageSize: '20' });

try {
  const routes = [];
  for (const kind of ['wrong', 'favorite', 'due']) {
    await go('learning/' + kind);
    const link = page.getByRole('link', { name: '查看汇总题目：布局回归题 01', exact: true });
    await link.waitFor();
    const href = await link.getAttribute('href');
    await link.click();
    await ready();
    await checkGeometry('list-entry-' + kind);
    routes.push([kind, href]);
    await reader().getByRole('link', { name: /^返回/ }).click();
    assert.match(page.url(), new RegExp('#/learning/' + kind));
  }
  checks.push('全部错题、全部收藏及固定日期待复习均通过真实列表入口进入专页并返回原列表');

  for (const width of [1440, 1024, 800, 390, 320]) {
    await page.setViewportSize({ width, height: width < 800 ? 844 : 1000 });
    for (const [kind, href] of routes) {
      await go(href);
      await ready();
      if (width < 800)
        await page.evaluate(() => {
          document.documentElement.dataset.theme = 'dark';
          document.documentElement.style.colorScheme = 'dark';
        });
      await reader().getByRole('button', { name: '展开答案与解析', exact: true }).click();
      await reader().locator('.answer-content').waitFor();
      const sources = reader().locator('.learning-origins');
      if (await sources.count()) await sources.locator('summary').click();
      await checkGeometry(`cold-${kind}-${width}`);
      if ([1440, 390].includes(width)) await capture(`cold-${kind}-${width}`);
      await page.reload();
      await ready();
      await checkGeometry(`reload-${kind}-${width}`);
    }
  }
  checks.push(
    '三类汇总阅读页在1440/1024/800/390/320宽度冷开与刷新，解析、笔记及来源独立布局，手机暗色无溢出',
  );

  await page.setViewportSize({ width: 1440, height: 1000 });
  const firstPage = await api('/api/learning/global/questions?kind=wrong&page=1&pageSize=20');
  assert.ok(firstPage.total > 20);
  await go(globalHref('wrong', firstPage.items[19].key));
  await ready();
  await reader().getByRole('button', { name: '下一题', exact: true }).click();
  await ready();
  await reader()
    .getByRole('status')
    .filter({ hasText: `第 21 / ${firstPage.total} 题` })
    .waitFor();
  await checkGeometry('next-across-page');
  await reader().getByRole('button', { name: '上一题', exact: true }).click();
  await ready();
  await reader()
    .getByRole('status')
    .filter({ hasText: `第 20 / ${firstPage.total} 题` })
    .waitFor();
  await reader().getByRole('button', { name: '下一题', exact: true }).click();
  await ready();
  await reader().getByRole('link', { name: /^返回/ }).click();
  assert.match(page.url(), /learningPage=2/);
  checks.push('特殊题集跨页上一题/下一题及返回列表第二页正常，布局不随导航变化');

  const wrong = await api('/api/learning/global/questions?kind=wrong&page=1&pageSize=100');
  const group = wrong.items.find((item) => item.question.partId === 'first');
  assert.ok(group, 'group leaves should be in wrong answers');
  for (const width of [1440, 800, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    // Locate the original page rather than assuming the group sorts last.
    const index = wrong.items.findIndex((item) => item.key === group.key);
    await go(globalHref('wrong', group.key, Math.floor(index / 20) + 1));
    await ready();
    await reader()
      .getByText('公共程序材料：const values = [1, 2, 3]；后续两题共用这段程序。', { exact: true })
      .waitFor();
    await checkGeometry('group-' + width);
    if (width === 390) await capture('group-390');
  }
  checks.push('组合小题冷开保留整组程序材料，材料卡、题干与独立学习情况在窄屏分开排布');

  let settings = await api('/api/settings');
  await api('/api/settings', 'PUT', {
    settings: { ...settings, reviewScheduling: { ...settings.reviewScheduling, strategy: 'fsrs' } },
  });
  await api('/api/review-scheduler/card', 'PATCH', {
    questionId: 'RL-01',
    dueAt: '2000-01-01T00:00:00.000Z',
  });
  await api('/api/review-scheduler/card', 'PATCH', {
    questionId: 'RL-WORD',
    direction: 'meaning_to_word',
    dueAt: '2000-01-01T00:00:00.000Z',
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await go('learning/due');
  await page.getByRole('link', { name: '复习任务：布局回归题 01', exact: true }).click();
  await ready();
  const queueHref = new URL(page.url()).hash;
  await checkGeometry('queue-entry');
  await reader().getByRole('link', { name: /^返回/ }).click();
  await page.getByLabel('任务方向', { exact: true }).selectOption('meaning_to_word');
  await page.getByRole('link', { name: '复习任务：看释义想词', exact: true }).click();
  await ready();
  const reverseHref = new URL(page.url()).hash;
  for (const width of [1440, 1024, 800, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const [name, href] of [
      ['queue', queueHref],
      ['reverse', reverseHref],
    ]) {
      await go(href);
      await ready();
      if (width < 800)
        await page.evaluate(() => {
          document.documentElement.dataset.theme = 'dark';
        });
      if (name === 'reverse') assert.doesNotMatch(await reader().innerText(), /secretwordcanary/);
      await checkGeometry(`${name}-${width}`);
      await reader().getByRole('button', { name: '展开答案与解析', exact: true }).click();
      await reader().locator('.answer-content').waitFor();
      if (name === 'reverse') assert.match(await reader().innerText(), /secretwordcanary/);
      await checkGeometry(`${name}-expanded-${width}`);
      if (width === 390) await capture(name + '-390');
    }
  }
  checks.push('FSRS普通与逆向任务在五种宽度保持布局；逆向先不泄露词头，展开解析后可核对并记录复习');
  qa.assertClean();
  const report = {
    passed: !findings.length,
    checks,
    samples,
    findings,
    isolated: true,
    database: ':memory:',
    baseline,
    staticRoot: process.env.QA_WEB_ROOT || 'dist/web',
    browserErrors: qa.errors,
    externalRequests: qa.external,
  };
  await writeFile(resolve(folder, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await Promise.all(
    ['failure.json', 'failure.png'].map((name) => rm(resolve(folder, name), { force: true })),
  );
  console.log(
    JSON.stringify({
      passed: report.passed,
      checks: checks.length,
      samples: samples.length,
      findings: findings.length,
      output: folder,
    }),
  );
} catch (error) {
  await qa.captureFailure(error, { checks, samples, findings, baseline });
  throw error;
} finally {
  await qa.close();
}
