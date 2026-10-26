/** Daily recommendation progress is exercised only in an isolated memory DB. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '../..'), output = resolve(root, 'test-results/daily-progress-ui');
await mkdir(output, { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const fixture = `import assert from 'node:assert/strict';
import {buildApp} from './server/index.ts';
import {Store} from './server/core/store.ts';
import {DEFAULT_SETTINGS} from './shared/models/settings.ts';
import {questionSchema} from './server/core/validation.ts';
import {importData,exportData} from './server/modules/transfer/migration.ts';
import {checkDailyPush} from './server/modules/daily-push/service.ts';
const staging=new Store(':memory:'), at=new Date('2026-10-25T04:00:00Z');
staging.put('domains','progress-domain',{id:'progress-domain',name:'每日进度隔离领域',description:'',sortOrder:0});
staging.put('categories','progress-category',{id:'progress-category',domainId:'progress-domain',name:'隔离基础',parentId:null,description:'',sortOrder:0});
for(let index=0;index<7;index++){
 const id='PROGRESS-'+index,type=index===6?'short_answer':'true_false';
 staging.put('questions',id,questionSchema.parse({id,title:index===6?'解释每日进度':'进度判断 '+index,type,stemMarkdown:index===6?'请说明一个概念。':'判断这个独立命题。',answerMarkdown:index===6?'说明概念及其边界。':'正确',explanationMarkdown:'隔离进度验收',correctAnswers:type==='true_false'?['true']:[],categoryIds:['progress-category'],tagIds:[],status:'published'}));
 if(index<6)staging.putStudy({questionId:id,favorite:false,notes:'',mastery:1,lastReviewedAt:'2026-10-01T00:00:00Z',nextReviewAt:'2026-10-24T00:00:00Z',wrongCount:0});
}
staging.put('settings','system',{...structuredClone(DEFAULT_SETTINGS),updatedAt:'2026-10-25T00:00:00Z',pointsByType:{...DEFAULT_SETTINGS.pointsByType,true_false:5,short_answer:20},dailyPush:{...DEFAULT_SETTINGS.dailyPush,enabled:true,domainId:'progress-domain',categoryIds:['progress-category']}});
const record=checkDailyPush(staging,at).record;assert.ok(record&&record.totalPoints===50&&record.questionIds.length===7);
const data=exportData(staging);staging.db.close();
const app=await buildApp({databasePath:':memory:',seedPath:'no-progress-ui-seed',staticRoot:'dist/web',dailyPushScheduler:false,dailyPushNow:()=>at,logger:false});
const imported=await app.inject({url:'/api/import',method:'POST',payload:{mode:'merge',data}});assert.equal(imported.statusCode,200,imported.body);
const origin=await app.listen({host:'127.0.0.1',port:0});console.log('DAILY_PROGRESS_READY '+JSON.stringify({origin,paperId:record.paperId}));`;
const server = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', fixture], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', browser, page;
server.stdout.on('data', value => stdout += value); server.stderr.on('data', value => stderr = (stderr + value).slice(-10000));
const checks = [], errors = [], externalRequests = [];
try {
  let state;
  for (let i = 0; i < 300; i++) {
    if (server.exitCode !== null) throw new Error(stderr);
    const line = stdout.split(/\r?\n/).find(value => value.startsWith('DAILY_PROGRESS_READY '));
    if (line) { state = JSON.parse(line.slice('DAILY_PROGRESS_READY '.length)); break; }
    await delay(100);
  }
  assert.ok(state, stderr); const { origin, paperId } = state;
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => void dialog.accept());
  await page.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue(); externalRequests.push(url.origin); return route.abort(); });
  const api = async (path, method = 'GET', data, expected = 200) => {
    const response = await page.request.fetch(origin + path, { method, ...(data === undefined ? {} : { data }) });
    assert.equal(response.status(), expected, path + ': ' + await response.text()); return response.json();
  };
  let navigation = 0;
  const go = async path => { await page.goto(origin + '/?progress-ui=' + ++navigation + '#/' + path); await page.waitForLoadState('networkidle'); };
  const nav = name => page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('link', { name, exact: true });
  const card = () => page.getByRole('status', { name: '每日推荐', exact: true });
  const quick = () => page.locator('.learning-next .daily-push-quick-link');
  const current = async () => (await api('/api/daily-push')).today.progress;
  const waitFor = async run => { for (let i = 0; i < 80; i++) { const value = await run(); if (value) return value; await delay(100); } throw new Error('condition did not become true'); };
  const capture = async name => { assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal overflow'); await page.screenshot({ path: resolve(output, name + '.png'), fullPage: true }); };
  const assertCoverage = (progress, count, points) => {
    assert.equal(progress.totalQuestions, 7); assert.equal(progress.totalPoints, 50);
    assert.equal(progress.answeredQuestions, count); assert.equal(progress.answeredPoints, points);
    assert.ok(progress.percent >= 0 && progress.percent <= 100);
  };

  await go('papers'); await card().getByText(/^未开始 · 已答/).waitFor();
  let progress = await current(); assert.equal(progress.status, 'not_started'); assertCoverage(progress, 0, 0);
  assert.equal(await card().getByRole('progressbar').getAttribute('value'), '0');
  await nav('知识总览').click(); await quick().getByText('开始今日推荐', { exact: true }).waitFor();
  assert.match(await quick().innerText(), /未开始|0\s*\/\s*7/); await capture('initial-dashboard');
  checks.push('每日推荐未开始时，题集卡片及知识总览入口显示0/7题和进度状态');

  await quick().click(); await page.waitForURL(new RegExp('#/papers/' + paperId));
  const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/papers/' + paperId + '/attempts' && response.request().method() === 'POST');
  await page.getByRole('button', { name: '开始练习', exact: true }).click();
  const draft = await (await created).json(); await page.waitForURL(new RegExp('#/attempts/' + draft.id));
  const objective = draft.questions.find(question => question.type === 'true_false');
  await page.locator(`input[name="answer-${objective.id}"]`).first().check();
  const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/attempts/' + draft.id && response.request().method() === 'PUT');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click(); assert.equal((await saved).status(), 200);
  await nav('题集与练习').click(); await card().getByText(/^作答中 · 已答/).waitFor();
  progress = await current(); assertCoverage(progress, 1, 5); assert.equal(progress.resumeAttemptId, draft.id);
  assert.match(await card().innerText(), /已答\s*1\s*\/\s*7/); assert.match(await card().innerText(), /5\s*\/\s*50/);
  assert.equal(await card().getByRole('link', { name: '继续今日推荐', exact: true }).getAttribute('href'), '#/attempts/' + draft.id);
  await nav('知识总览').click(); await quick().getByText('继续今日推荐', { exact: true }).waitFor();
  assert.equal(await quick().getAttribute('href'), '#/attempts/' + draft.id); assert.match(await quick().innerText(), /1\s*\/\s*7/);
  await capture('partial-dashboard');
  checks.push('实际作答并保存草稿后返回入口立即显示1/7题、覆盖5/50分，总览和卡片均可续同一草稿');

  await quick().click(); await page.waitForURL(new RegExp('#/attempts/' + draft.id));
  assert.equal((await api('/api/attempts/' + draft.id)).status, 'in_progress');
  await page.getByRole('button', { name: '交卷并查看解析', exact: true }).first().click(); await page.getByLabel('本次作答时间').waitFor();
  await nav('题集与练习').click(); await card().getByText(/^已提交 · 已答/).waitFor();
  progress = await current(); assertCoverage(progress, 1, 5); assert.equal(progress.omittedQuestions, 6); assert.equal(progress.pendingGradingCount, 0);
  assert.match(await card().innerText(), /漏答\s*6|未答\s*6/); await capture('omitted-submission');
  checks.push('漏答交卷显示已提交及6道漏答，空白主观题不误算待判题或已完成');

  const full = await api('/api/papers/' + paperId + '/attempts', 'POST', {}, 201);
  const answers = Object.fromEntries(full.questions.map(question => [question.id, { value: question.type === 'short_answer' ? '这是我独立写出的概念及边界。' : ['true'] }]));
  await api('/api/attempts/' + full.id + '/submit', 'POST', { answers });
  await nav('知识总览').click(); await quick().getByText('查看今日结果', { exact: true }).waitFor();
  progress = await current(); assertCoverage(progress, 7, 50); assert.equal(progress.status, 'completed'); assert.equal(progress.percent, 100); assert.equal(progress.pendingGradingCount, 1);
  assert.equal(await quick().getAttribute('href'), '#/attempts/' + full.id); assert.match(await quick().innerText(), /已完成/); assert.match(await quick().innerText(), /待判\s*1|1\s*题待判/);
  await nav('题集与练习').click(); await card().getByText(/^已完成 · 已答/).waitFor();
  assert.equal(await card().getByRole('progressbar').getAttribute('value'), '100'); assert.match(await card().innerText(), /7\s*\/\s*7/);
  await capture('completed-pending');
  checks.push('全部填写并提交后入口显示已完成100%，主观待判单列，已覆盖50分不冒充实际得分');

  const repeat = await api('/api/papers/' + paperId + '/attempts', 'POST', {}, 201);
  await api('/api/attempts/' + repeat.id, 'PUT', { answers: { [objective.id]: { value: ['true'] } } });
  await card().getByRole('button', { name: '检查今日推荐', exact: true }).click();
  progress = await current(); assertCoverage(progress, 7, 50); assert.equal(progress.status, 'completed'); assert.equal(progress.percent, 100); assert.equal(progress.resultAttemptId, full.id);
  await card().getByRole('link', { name: '继续今日推荐', exact: true }).waitFor();
  assert.equal(await card().getByRole('link', { name: '查看今日结果', exact: true }).getAttribute('href'), '#/attempts/' + full.id);
  assert.equal(await card().getByRole('link', { name: '继续今日推荐', exact: true }).getAttribute('href'), '#/attempts/' + repeat.id);
  const subjective = full.questions.find(question => question.type === 'short_answer');
  const graded = await api('/api/attempts/' + full.id + '/review', 'PUT', { scores: { [subjective.id]: 0 } });
  assert.equal(graded.totalScore, 30, 'earned score remains distinct from the 50 covered points');
  await card().getByRole('button', { name: '检查今日推荐', exact: true }).click();
  await waitFor(async () => (await current()).pendingGradingCount === 0);
  await waitFor(async () => !/待判\s*1|1\s*题待判/.test(await card().innerText()));
  progress = await current(); assertCoverage(progress, 7, 50); assert.equal(progress.percent, 100);
  assert.ok(!/待判\s*1|1\s*题待判/.test(await card().innerText()));
  checks.push('重复练习不叠加超过100%且不冲掉完成状态，可同时查看结果和继续新草稿；主观判0分后仅清待判状态');

  // Response-only presentation fixture: never write the pruned-details state to the database.
  const dailyEndpoint = url => url.origin === origin && url.pathname === '/api/daily-push';
  const hideDetails = async route => {
    assert.equal(route.request().method(), 'GET');
    const response = await route.fetch(), body = await response.json();
    body.today.progress = { ...body.today.progress, status: 'submitted', detailsAvailable: false, historyAvailable: false, answeredQuestions: 0, answeredPoints: 0, percent: 0 };
    await route.fulfill({ response, json: body });
  };
  await page.route(dailyEndpoint, hideDetails);
  try {
    await go('papers'); await card().getByText('已提交 · 作答明细不可用', { exact: true }).waitFor();
    const summary = card().locator('[aria-label="每日推荐作答进度"]');
    assert.ok(!/已答\s*\d|已覆盖\s*\d|0\s*\/\s*7|0\s*\/\s*50/.test(await summary.innerText()), 'unavailable details must not imply zero coverage');
    assert.equal(await card().getByRole('progressbar').count(), 0);
    assert.equal(await card().getByRole('link', { name: '查看今日结果', exact: true }).getAttribute('href'), '#/attempts/' + full.id);
    await nav('知识总览').click(); await quick().getByText('已提交 · 作答明细不可用', { exact: true }).waitFor();
    assert.ok(!/已答\s*\d|已覆盖\s*\d|0\s*\/\s*7|0\s*\/\s*50/.test(await quick().innerText()), 'dashboard must not display fabricated zero coverage');
    assert.equal(await quick().getByRole('progressbar').count(), 0);
    assert.equal(await quick().getAttribute('href'), '#/attempts/' + full.id);
    await capture('details-unavailable-dashboard');
    progress = await current(); assert.equal(progress.detailsAvailable, true); assertCoverage(progress, 7, 50);
  } finally { await page.unroute(dailyEndpoint, hideDetails); }
  await go('papers'); await card().getByText(/^已完成 · 已答/).waitFor();
  assert.equal(await card().getByRole('progressbar').getAttribute('value'), '100');
  await nav('知识总览').click(); await quick().getByText(/^已完成 · 已答/).waitFor();
  assert.match(await quick().innerText(), /已覆盖\s*50\s*\/\s*50/);
  checks.push('只读响应模拟明细已清理时，卡片与总览显示明细不可用且隐藏伪0覆盖和进度条；取消拦截即恢复真实100%进度');

  const settings = await api('/api/settings'); await api('/api/settings', 'PUT', { settings: { ...settings, theme: 'dark' } });
  await page.setViewportSize({ width: 390, height: 844 }); await go('papers'); await card().getByText(/^已完成 · 已答/).waitFor();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  const cardBounds = await card().boundingBox(), copyBounds = await card().locator('.daily-push-card-copy').boundingBox();
  assert.ok(cardBounds && cardBounds.height <= 300, 'mobile progress card must remain compact'); assert.ok(copyBounds && copyBounds.width >= 200, 'mobile progress text remains readable');
  await capture('progress-dark-mobile'); await page.getByRole('button', { name: '打开菜单', exact: true }).click(); await nav('知识总览').click();
  await quick().getByText('查看今日结果', { exact: true }).waitFor(); await capture('dashboard-dark-mobile');
  checks.push('390px暗色卡片及总览入口进度正常换行，主动作和进度条可见且无页面溢出');

  await api('/api/papers/' + paperId, 'DELETE'); await go('papers'); await card().waitFor();
  assert.equal(await card().getByRole('link', { name: '打开今日题集', exact: true }).count(), 0);
  const links = await card().getByRole('link').evaluateAll(nodes => nodes.map(node => node.getAttribute('href')));
  assert.ok(!links.includes('#/papers/' + paperId));
  for (const link of links.filter(value => value?.startsWith('#/attempts/'))) await api('/api/attempts/' + decodeURIComponent(link.split('/').at(-1)));
  await capture('archived-source-mobile'); checks.push('原推荐题集归档后停止展示失效题集入口，保留的作答结果仍可正常读取');

  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
  const report = { passed: checks.length, checks, errors, externalRequests, isolated: true, databasePath: ':memory:', totalQuestions: 7, totalPoints: 50 };
  await rm(resolve(output, 'failure.png'), { force: true }); await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  await page?.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error({ url: page?.url(), checks, stderr }); throw error;
} finally { await browser?.close(); server.kill(); }
