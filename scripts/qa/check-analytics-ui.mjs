/** Learning analytics and weekly reports use only an isolated in-memory fixture. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '../..'), output = resolve(root, 'test-results/analytics-ui');
await mkdir(output, { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const fixture = `import assert from 'node:assert/strict';
import {buildApp} from './server/index.ts';
import {Store} from './server/core/store.ts';
import {DEFAULT_SETTINGS} from './shared/models/settings.ts';
import {questionSchema} from './server/core/validation.ts';
import {buildPaper,createAttempt,createQuickAttempt,submitAttempt,reviewAttempt,saveAttempt} from './server/modules/practice/service.ts';
import {preserveLearningResults} from './server/modules/practice/learning-results.ts';
import {importData,exportData} from './server/modules/transfer/migration.ts';
const staging=new Store(':memory:');
const shift=(day,offset)=>new Date(Date.parse(day+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const weekday=new Date(today+'T00:00:00Z').getUTCDay();
const weekStart=shift(today,-((weekday+6)%7)-7),weekEnd=shift(weekStart,6),previousWeek=shift(weekStart,-7),emptyWeek=shift(weekStart,-21);
const iso=(offset)=>shift(weekStart,offset)+'T02:00:00Z';
for(const [id,name] of [['analytics-computer','计算机基础'],['analytics-language','语言基础']]){
 staging.put('domains',id,{id,name,description:'隔离统计验收',sortOrder:0});
 staging.put('categories',id+'-category',{id:id+'-category',domainId:id,name:'基础知识',parentId:null,description:'',sortOrder:0});
}
staging.put('settings','system',{...structuredClone(DEFAULT_SETTINGS),maxHistoryPerPaper:20,updatedAt:today+'T00:00:00Z',dailyPush:{...DEFAULT_SETTINGS.dailyPush,enabled:false}});
for(const [id,type] of [['A1','true_false'],['A2','true_false'],['A3','short_answer'],['A4','short_answer'],['A5','true_false'],['LANG','single_choice'],['GROUP','group']]){
 const common={id,title:'统计验收 '+id,type,stemMarkdown:'PRIVATE_QUESTION_CANARY',answerMarkdown:'REFERENCE_ANSWER_CANARY',explanationMarkdown:'PRIVATE_EXPLANATION_CANARY',categoryIds:[id==='LANG'?'analytics-language-category':'analytics-computer-category'],tagIds:[],status:'published'};
 const specifics=type==='group'?{parts:[{id:'first',title:'独立判断',type:'true_false',stemMarkdown:'PRIVATE_GROUP_CANARY',correctAnswers:['true'],weight:1},{id:'second',title:'独立填空',type:'fill_blank',stemMarkdown:'PRIVATE_GROUP_CANARY',blanks:[{id:'blank',label:'结论',answers:['right'],caseSensitive:false,trim:true}],weight:1}]}:type==='true_false'?{correctAnswers:['true']}:type==='single_choice'?{options:[{key:'A',text:'第一项'},{key:'B',text:'第二项'}],correctAnswers:['A']}:{};
 staging.put('questions',id,questionSchema.parse({...common,...specifics}));
}
const paper=(id,ids)=>{
 const value=buildPaper(staging,{id,title:'隔离统计题集 '+id,description:'',mode:'manual',questionIds:ids,scoring:{enabled:true,totalPoints:ids.length*10,questionPoints:Object.fromEntries(ids.map(key=>[key,10]))}});
 staging.put('papers',id,value);return value;
};
const main=paper('analytics-main',['A1','A2','A3','A4','A5','GROUP']),repeat=paper('analytics-repeat',['A1','A2']),previous=paper('analytics-previous',['A1']);
const redate=(attempt,submittedAt,seconds)=>{
 attempt.submittedAt=submittedAt;attempt.startedAt=new Date(Date.parse(submittedAt)-seconds*1000).toISOString();attempt.updatedAt=submittedAt;attempt.elapsedSeconds=seconds;attempt.practiceTiming={elapsedMilliseconds:seconds*1000,sessionId:null,sessionElapsedMilliseconds:0,sessionStartedAt:null,running:false};
 staging.put('attempts',attempt.id,attempt);preserveLearningResults(staging,attempt);return attempt;
};
const old=submitAttempt(staging,createAttempt(staging,previous),{A1:{value:['true']}});redate(old,previousWeek+'T02:00:00Z',60);
const full=submitAttempt(staging,createAttempt(staging,main),{A1:{value:['true']},A2:{value:['false']},A3:{value:'PRIVATE_STUDENT_CANARY'},A4:{value:'PRIVATE_UNGRADED_CANARY'},'GROUP::first':{value:['true']},'GROUP::second':{value:['wrong']}});
reviewAttempt(staging,full,{A3:5});redate(full,iso(0),1800);
for(const review of staging.all('reviews'))staging.put('reviews',review.id,{...review,reviewedAt:iso(0)});
const retry=submitAttempt(staging,createAttempt(staging,repeat),{A1:{value:['true']},A2:{value:['true']}});redate(retry,iso(1),600);
const quick=submitAttempt(staging,createQuickAttempt(staging,{questionId:'LANG'}),{LANG:{value:['B']}});redate(quick,iso(2),120);
staging.put('reviews','analytics-manual-review',{id:'analytics-manual-review',questionId:'A2',mastery:2,reviewedAt:iso(2),source:'manual'});
saveAttempt(staging,createAttempt(staging,repeat),{A1:{value:['true']}});
const data=exportData(staging);staging.db.close();
const app=await buildApp({databasePath:':memory:',seedPath:'no-analytics-ui-seed',staticRoot:'dist/web',dailyPushScheduler:false,logger:false});
const imported=await app.inject({url:'/api/import',method:'POST',payload:{mode:'merge',data}});assert.equal(imported.statusCode,200,imported.body);
const origin=await app.listen({host:'127.0.0.1',port:0});console.log('ANALYTICS_READY '+JSON.stringify({origin,weekStart,weekEnd,previousWeek,emptyWeek,mainPaperId:main.id}));`;
const server = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', fixture], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', browser, page;
server.stdout.on('data', value => stdout += value); server.stderr.on('data', value => stderr = (stderr + value).slice(-16000));
const checks = [], errors = [], externalRequests = [];
try {
  let state;
  for (let index = 0; index < 600; index++) {
    if (server.exitCode !== null) throw new Error(stderr);
    const line = stdout.split(/\r?\n/).find(value => value.startsWith('ANALYTICS_READY '));
    if (line) { state = JSON.parse(line.slice('ANALYTICS_READY '.length)); break; }
    await delay(100);
  }
  assert.ok(state, stderr); const { origin, weekStart, weekEnd, previousWeek, emptyWeek, mainPaperId } = state;
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', acceptDownloads: true });
  page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => void dialog.accept());
  await page.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue(); externalRequests.push(url.origin); return route.abort(); });
  const api = async (path, method = 'GET', data, expected = 200) => {
    const response = await context.request.fetch(origin + path, { method, ...(data === undefined ? {} : { data }) });
    const text = await response.text(); assert.equal(response.status(), expected, path + ': ' + text); return text ? JSON.parse(text) : null;
  };
  let navigation = 0;
  const go = async path => { await page.goto(origin + '/?analytics-ui=' + ++navigation + '#/' + path); await page.waitForLoadState('networkidle'); };
  const section = name => page.getByRole('region', { name, exact: true });
  const capture = async name => {
    await page.evaluate(async () => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      window.scrollTo(0, 0);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal overflow');
    await page.screenshot({ path: resolve(output, name + '.png'), fullPage: true });
  };
  const rangeUrl = '/api/analytics?from=' + weekStart + '&to=' + weekEnd + '&timeZone=Asia%2FShanghai';
  const report = await api(rangeUrl);
  assert.equal(report.summary.sessions, 3); assert.equal(report.summary.answers, 9); assert.equal(report.summary.uniqueItems, 7); assert.equal(report.summary.uniqueQuestions, 6);
  assert.equal(report.summary.correct, 4); assert.equal(report.summary.partial, 1); assert.equal(report.summary.incorrect, 3); assert.equal(report.summary.ungraded, 1); assert.equal(report.summary.omitted, 1);
  assert.equal(report.summary.graded, 8); assert.equal(report.summary.accuracy, 50); assert.equal(report.summary.elapsedSeconds, 2520); assert.equal(report.summary.activeDays, 3);
  assert.equal(report.summary.paperSessions, 2); assert.equal(report.summary.quickSessions, 1); assert.equal(report.daily.length, 7);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_QUESTION_CANARY|PRIVATE_GROUP_CANARY|REFERENCE_ANSWER_CANARY|PRIVATE_STUDENT_CANARY|PRIVATE_UNGRADED_CANARY|PRIVATE_EXPLANATION_CANARY/);
  checks.push('真实提交次数与去重题数分开，漏答及草稿不计已答，正确/部分/错误/未判和可靠作答时长分别统计且无正文泄露');

  await go('');
  const dashboardHeader=page.locator('.page-header');
  assert.equal(await dashboardHeader.locator('a[href^="#/analytics"]').count(),0);
  const weeklyCard=section('本周学习统计');await weeklyCard.waitFor();const currentReport=await api('/api/analytics/weekly?timeZone=Asia%2FShanghai');
  await weeklyCard.locator('[data-week-metric="answers"]').waitFor();assert.equal(await weeklyCard.locator('[data-week-metric="answers"]').innerText(),currentReport.current.summary.answers+'次');
  await weeklyCard.getByRole('link',{name:'查看学习统计',exact:true}).click();await section('学习概览指标').waitFor();
  assert.equal(await page.getByRole('group',{name:'统计周期'}).getByRole('button',{name:'周',exact:true}).getAttribute('aria-pressed'),'true');
  assert.equal(await page.getByRole('tab',{name:'学习周报',exact:true}).count(),0);
  checks.push('总览顶部重复入口移除，下方本周统计与周报接口一致，进入统一统计默认本周');
  await page.getByRole('group',{name:'统计周期'}).getByRole('button',{name:'自定义',exact:true}).click();
  await page.getByLabel('开始日期', { exact: true }).fill(weekStart);
  await page.getByLabel('结束日期', { exact: true }).fill(weekEnd);
  await page.getByRole('button', { name: '应用日期范围', exact: true }).click();
  await page.getByRole('heading', { name: weekStart + ' — ' + weekEnd, exact: true }).waitFor();
  const metric = label => section('学习概览指标').locator('article').filter({ has: page.getByText(label, { exact: true }) });
  const metricValue = async label => (await metric(label).locator(':scope > strong').innerText()).replace(/\s/g, '');
  assert.equal(await metricValue('实际作答'), '9次'); assert.equal(await metricValue('去重作答项'), '7项'); assert.equal(await metricValue('严格正确率'), '50%');
  assert.equal(await metricValue('已知作答计时'), '42分0秒');
  const distribution = section('作答判定分布');
  assert.match(await distribution.innerText(), /漏答\s*1\s*项/); assert.match(await distribution.innerText(), /随机／单题\s*1\s*次/);
  assert.match(await section('领域分布').innerText(), /计算机基础/); assert.match(await section('领域分布').innerText(), /语言基础/);
  assert.match(await section('题型分布').innerText(), /判断/); assert.match(await section('题型分布').innerText(), /填空/);
  await section('每日学习趋势').getByText('查看每日数据明细', { exact: true }).click();
  const dailyTable = page.getByRole('table', { name: '每日学习数据', exact: true });
  const firstDay = dailyTable.getByRole('row').filter({ has: page.getByRole('cell', { name: weekStart, exact: true }) });
  assert.equal(await firstDay.getByRole('cell').nth(1).innerText(), '6'); assert.equal(await firstDay.getByRole('cell').nth(2).innerText(), '6'); assert.equal(await firstDay.getByRole('cell').nth(3).innerText(), '40%');
  await capture('analytics-desktop');
  checks.push('自定义完整周真实刷新图表与指标，9次作答/7个独立项/50%正确率/42分钟，按日明细与领域题型分布一致');

  await page.getByRole('button', { name: '查看本周周报', exact: true }).click();
  await page.getByLabel('周报所在日期', { exact: true }).fill(weekStart);
  await page.getByRole('heading', { name: weekStart + ' — ' + weekEnd + ' 学习周报', exact: true }).waitFor();
  const weekly = await api('/api/analytics/weekly?week=' + weekStart + '&timeZone=Asia%2FShanghai');
  assert.equal(weekly.weekStart, weekStart); assert.equal(weekly.comparison.mode, 'full_week'); assert.equal(weekly.comparison.summary.answers, 1); assert.equal(weekly.comparison.summary.elapsedSeconds, 60);
  assert.equal(weekly.comparison.deltas.answers, 8); assert.equal(weekly.comparison.deltas.accuracyPoints, -50);
  assert.equal(await metricValue('实际作答'), '9次'); assert.match(await section('学习概览指标').innerText(), /9/);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出周报 Markdown', exact: true }).click();
  const download = await downloaded, filename = download.suggestedFilename(); assert.ok(filename.endsWith('.md')); assert.ok(filename.includes(weekStart));
  const savedPath = resolve(output, filename); await download.saveAs(savedPath);
  const markdown = await readFile(savedPath, 'utf8');
  assert.ok(markdown.includes(weekStart) && markdown.includes(weekEnd)); assert.match(markdown, /实际作答次数\s*\|\s*9/); assert.match(markdown, /严格正确率\s*\|\s*50%/); assert.match(markdown, /统计口径/);
  assert.doesNotMatch(markdown, /PRIVATE_QUESTION_CANARY|PRIVATE_GROUP_CANARY|REFERENCE_ANSWER_CANARY|PRIVATE_STUDENT_CANARY|PRIVATE_UNGRADED_CANARY|PRIVATE_EXPLANATION_CANARY/);
  await capture('weekly-desktop');
  checks.push('自然周周报对比完整上周并显示绝对变化，Markdown真实下载匹配选周，含统计口径且无答案和作答正文');

  await page.getByRole('button', { name: '上一周', exact: true }).click();
  await page.getByRole('heading', { name: previousWeek + ' — ' + new Date(Date.parse(previousWeek + 'T00:00:00Z') + 6 * 86400000).toISOString().slice(0, 10) + ' 学习周报', exact: true }).waitFor();
  assert.equal(await metricValue('实际作答'), '1次');
  await page.getByRole('button', { name: '下一周', exact: true }).click();
  await page.getByRole('heading', { name: weekStart + ' — ' + weekEnd + ' 学习周报', exact: true }).waitFor();
  await page.getByRole('button', { name: '本周', exact: true }).click();
  await page.locator('.analytics-range-label').getByText(/本周进行中/).waitFor();
  const ongoing = await api('/api/analytics/weekly?timeZone=Asia%2FShanghai'); assert.equal(ongoing.comparison.mode, 'matched_elapsed');
  assert.equal(await page.getByRole('button', { name: '下一周', exact: true }).isDisabled(), true);
  checks.push('周报支持上周/下周/本周，进行中的本周使用上周相同已过时段，禁止继续到未来周');

  await page.getByLabel('周报所在日期', { exact: true }).fill(emptyWeek);
  const emptyWeekEnd = new Date(Date.parse(emptyWeek + 'T00:00:00Z') + 6 * 86400000).toISOString().slice(0, 10);
  await page.getByRole('heading', { name: emptyWeek + ' — ' + emptyWeekEnd + ' 学习周报', exact: true }).waitFor();
  assert.equal(await metricValue('实际作答'),'0次');
  assert.equal(await metricValue('严格正确率'), '—');
  await page.getByRole('heading', { name: '这段时间还没有学习记录', exact: true }).waitFor();
  const emptyDownload = page.waitForEvent('download'); await page.getByRole('button', { name: '导出周报 Markdown', exact: true }).click();
  const emptyFile = await emptyDownload; assert.ok(emptyFile.suggestedFilename().includes(emptyWeek));
  const emptyPath = resolve(output, emptyFile.suggestedFilename()); await emptyFile.saveAs(emptyPath); assert.match(await readFile(emptyPath, 'utf8'), /严格正确率\s*\|\s*—/);
  checks.push('空白周正常显示零活动和无已判正确率，仍可导出所选周报，不伪造0%或学习结论');

  const period=page.getByRole('group',{name:'统计周期'});
  await period.getByRole('button',{name:'日',exact:true}).click();await page.getByLabel('统计日期',{exact:true}).fill(weekStart);
  await page.getByRole('heading',{name:weekStart+' — '+weekStart,exact:true}).waitFor();assert.equal(await metricValue('实际作答'),'6次');
  await page.getByRole('button',{name:'上一日',exact:true}).click();await page.getByRole('heading',{name:new Date(Date.parse(weekStart+'T00:00:00Z')-86400000).toISOString().slice(0,10)+' — '+new Date(Date.parse(weekStart+'T00:00:00Z')-86400000).toISOString().slice(0,10),exact:true}).waitFor();assert.equal(await metricValue('实际作答'),'0次');
  await page.getByRole('button',{name:'下一日',exact:true}).click();await page.getByRole('heading',{name:weekStart+' — '+weekStart,exact:true}).waitFor();assert.equal(await metricValue('实际作答'),'6次');
  await page.reload();await page.getByLabel('统计日期',{exact:true}).waitFor();assert.equal(await page.getByLabel('统计日期',{exact:true}).inputValue(),weekStart);await section('学习概览指标').waitFor();assert.equal(await metricValue('实际作答'),'6次');
  await page.getByRole('button',{name:'今天',exact:true}).click();assert.equal(await page.getByRole('button',{name:'下一日',exact:true}).isDisabled(),true);
  checks.push('日历逐日翻页真实刷新计数，选择日期保存在网址且刷新恢复，今天禁止进入未来');

  await period.getByRole('button',{name:'月',exact:true}).click();await page.getByLabel('统计月份',{exact:true}).fill('2026-01');await page.getByRole('heading',{name:'2026-01-01 — 2026-01-31',exact:true}).waitFor();
  await page.getByRole('button',{name:'上一月',exact:true}).click();await page.getByRole('heading',{name:'2025-12-01 — 2025-12-31',exact:true}).waitFor();
  await page.getByRole('button',{name:'下一月',exact:true}).click();await page.getByRole('heading',{name:'2026-01-01 — 2026-01-31',exact:true}).waitFor();
  await page.getByRole('button',{name:'本月',exact:true}).click();assert.equal(await page.getByRole('button',{name:'下一月',exact:true}).isDisabled(),true);
  await period.getByRole('button',{name:'近一年',exact:true}).click();await section('学习概览指标').waitFor();assert.ok(page.url().includes('mode=year'));await page.getByRole('button',{name:'查看本周周报',exact:true}).click();await page.getByLabel('周报所在日期',{exact:true}).waitFor();
  checks.push('月份控件、跨年上月下月、本月未来保护、近一年与查看本周快捷入口有效');

  const failedEndpoint = url => url.origin === origin && url.pathname === '/api/analytics';
  const failStatistics = route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'ANALYTICS_QA_RETRY', message: '隔离统计请求暂不可用' } }) });
  await page.route(failedEndpoint, failStatistics);
  await go('analytics?mode=day'); await page.getByRole('alert').filter({ hasText: '隔离统计请求暂不可用' }).waitFor();
  await page.unroute(failedEndpoint, failStatistics); await page.getByRole('button', { name: '重新加载', exact: true }).click(); await section('学习概览指标').waitFor();
  checks.push('统计读取失败有明确提示，重新加载后恢复有效数据');

  const settings = await api('/api/settings'); await api('/api/settings', 'PUT', { settings: { ...settings, theme: 'dark' } });
  await page.setViewportSize({ width: 390, height: 844 }); await go('analytics?tab=weekly');
  await page.getByLabel('周报所在日期', { exact: true }).fill(weekStart);
  await page.getByRole('heading', { name: weekStart + ' — ' + weekEnd + ' 学习周报', exact: true }).waitFor();
  await section('每日学习趋势').getByText('查看每日数据明细', { exact: true }).click();
  await capture('weekly-dark-mobile');
  await page.getByRole('group',{name:'统计周期'}).getByRole('button',{name:'月',exact:true}).click(); await page.getByLabel('统计月份',{exact:true}).waitFor(); await section('学习概览指标').waitFor(); await capture('analytics-dark-mobile');
  checks.push('390px暗色统计和周报布局无横向溢出，日期控件、指标、导出及每日明细可用');

  const exam = await api('/api/papers/' + mainPaperId + '/attempts', 'POST', { mode: 'exam', durationMinutes: 120 }, 201);
  const locked = await api(rangeUrl, 'GET', undefined, 409); assert.equal(locked.error.code, 'EXAM_ACTIVE');
  await go('analytics'); await page.getByLabel('考试倒计时', { exact: true }).waitFor(); assert.ok(page.url().includes('#/attempts/' + exam.id));
  assert.equal(await section('学习概览指标').count(), 0);
  await api('/api/attempts/' + exam.id + '/submit', 'POST');
  checks.push('考试期间统计接口与页面均受统一锁定，不能通过学习分析绕过考试导航保护');

  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
  const result = { passed: checks.length, checks, errors, externalRequests, isolated: true, databasePath: ':memory:', weekStart, weekEnd };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} catch (error) {
  await page?.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error({ url: page?.url(), checks, stderr }); throw error;
} finally {
  await browser?.close(); server.kill(); await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(3000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
}
