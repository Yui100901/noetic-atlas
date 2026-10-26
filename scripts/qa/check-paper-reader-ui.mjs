/** Independent set reading uses real APIs against a disposable in-memory app. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '../..'), output = resolve(root, 'test-results/paper-reader-ui');
await mkdir(output, { recursive: true });
await Promise.all(['failure.json', 'failure.png'].map(name => rm(resolve(output, name), { force: true })));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const fixture = `import assert from 'node:assert/strict';
import {buildApp} from './server/index.ts';
import {Store} from './server/core/store.ts';
import {DEFAULT_SETTINGS} from './shared/models/settings.ts';
import {questionSchema} from './server/core/validation.ts';
import {buildPaper} from './server/modules/practice/service.ts';
import {importData,exportData} from './server/modules/transfer/migration.ts';
const staging=new Store(':memory:'),stamp=new Date().toISOString();
staging.put('domains','reader-domain',{id:'reader-domain',name:'题集阅读隔离领域',description:'合成验收内容',sortOrder:0});
staging.put('categories','reader-category',{id:'reader-category',domainId:'reader-domain',parentId:null,name:'基础',description:'',sortOrder:0});
staging.put('settings','system',{...structuredClone(DEFAULT_SETTINGS),updatedAt:stamp});
for(let index=0;index<26;index++){
 const id='READER-'+String(index).padStart(2,'0');
 staging.put('questions',id,questionSchema.parse({id,title:'阅读题 '+String(index).padStart(2,'0')+' · '+(index%2?'网络':'事务'),type:'true_false',stemMarkdown:'快照题干 '+id+'：事务提交后应保持持久性。',answerMarkdown:'快照答案 '+id+'：正确。',explanationMarkdown:'快照解析 '+id+'：区分事务提交与持久化边界。',correctAnswers:['true'],status:'published',categoryIds:['reader-category'],tagIds:[],createdAt:stamp,updatedAt:stamp}));
}
staging.put('questions','READER-GROUP',questionSchema.parse({id:'READER-GROUP',title:'程序阅读组合',type:'group',stemMarkdown:'公共材料：const numbers = [1, 2, 3]。',parts:[{id:'sum',title:'求和小题',type:'fill_blank',stemMarkdown:'数组之和为？',blanks:[{id:'total',label:'总和',answers:['6'],trim:true,caseSensitive:false}],answerMarkdown:'数组之和为6。'},{id:'const',title:'常量小题',type:'true_false',stemMarkdown:'const 数组元素不可修改。',correctAnswers:['false'],answerMarkdown:'const约束绑定，不限制数组元素。'}],status:'published',categoryIds:['reader-category'],tagIds:[],createdAt:stamp,updatedAt:stamp}));
staging.put('questions','READER-OUTSIDE',questionSchema.parse({id:'READER-OUTSIDE',title:'其他题集专用题',type:'true_false',stemMarkdown:'OUTSIDE_SET_CANARY',correctAnswers:['false'],status:'published',categoryIds:['reader-category'],tagIds:[]}));
const paper=buildPaper(staging,{id:'READER-PAPER',title:'连续阅读与返回上下文题集',description:'独立看题页面验收。',mode:'manual',questionIds:[...Array.from({length:26},(_,index)=>'READER-'+String(index).padStart(2,'0')),'READER-GROUP'],scoring:{enabled:false}});
staging.put('papers',paper.id,paper);
const other=buildPaper(staging,{id:'READER-OTHER',title:'其他题集',description:'不应出现在上一下一题中。',mode:'manual',questionIds:['READER-OUTSIDE'],scoring:{enabled:false}});staging.put('papers',other.id,other);
const data=exportData(staging);staging.db.close();
const app=await buildApp({databasePath:':memory:',seedPath:'no-reader-seed',staticRoot:'dist/web',dailyPushScheduler:false,logger:false});
const imported=await app.inject({url:'/api/import',method:'POST',payload:{mode:'merge',data}});assert.equal(imported.statusCode,200,imported.body);
const origin=await app.listen({host:'127.0.0.1',port:0});console.log('READER_READY '+JSON.stringify({origin,paperId:paper.id}));`;
const server = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', fixture], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', browser, page;
server.stdout.on('data', value => stdout += value); server.stderr.on('data', value => stderr = (stderr + value).slice(-16000));
const checks = [], errors = [], externalRequests = [], dialogs = [];
let dialogChoice = 'dismiss';
try {
  let state;
  for (let index = 0; index < 300; index++) {
    if (server.exitCode !== null) throw new Error(stderr);
    const line = stdout.split(/\r?\n/).find(value => value.startsWith('READER_READY '));
    if (line) { state = JSON.parse(line.slice('READER_READY '.length)); break; } await delay(100);
  }
  assert.ok(state, stderr); const { origin, paperId } = state;
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { dialogs.push({ type: dialog.type(), message: dialog.message(), choice: dialogChoice }); void dialog[dialogChoice](); });
  await page.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue(); externalRequests.push(url.origin); return route.abort(); });
  const api = async (path, method = 'GET', data, expected = 200) => { const response = await context.request.fetch(origin + path, { method, ...(data === undefined ? {} : { data }) }); assert.equal(response.status(), expected, path + ': ' + await response.text()); return response.json(); };
  let navigation = 0;
  const readerHref = (id, query = '') => '#/papers/' + paperId + '/questions/' + encodeURIComponent(id) + query;
  const go = async path => { await page.goto(origin + '/?paper-reader-ui=' + ++navigation + (path.startsWith('#') ? path : '#/' + path)); await page.waitForLoadState('networkidle'); };
  const waitReader = async id => { await page.locator('.paper-question-page .question-viewer-reading').waitFor(); assert.equal(decodeURIComponent(new URL(page.url()).hash.split('?')[0]), decodeURIComponent(readerHref(id))); assert.equal(await page.getByRole('dialog').count(), 0); };
  const nav = () => page.getByRole('navigation', { name: '题集阅读导航', exact: true }).first();
  const previous = () => nav().locator('a,button').filter({ hasText: /^上一题/ });
  const next = () => nav().locator('a,button').filter({ hasText: /下一题/ });
  const back = () => page.getByRole('link', { name: /^返回题集(?:\s*·|$)/ }).first();
  const capture = async name => { await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0); }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal overflow ' + name); await page.screenshot({ path: resolve(output, name + '.png'), fullPage: true }); };
  const waitFor = async predicate => { for (let index = 0; index < 100; index++) { if (await predicate()) return; await delay(100); } throw new Error('condition timed out'); };

  await go('papers/' + paperId);
  const search = page.getByRole('searchbox', { name: '在本题集中查找标题或题号', exact: true });
  await search.fill('事务');
  await page.getByLabel('题集题目每页数量', { exact: true }).selectOption('10');
  await page.getByRole('navigation', { name: '题集题目分页', exact: true }).getByRole('button', { name: /下一页/ }).click();
  await page.getByRole('link', { name: '查看题目：阅读题 20 · 事务', exact: true }).click();
  await waitReader('READER-20');
  let params = new URLSearchParams(page.url().split('#')[1].split('?')[1]);
  assert.equal(params.get('contentsSearch'), '事务'); assert.equal(params.get('contentsPage'), '2'); assert.equal(params.get('contentsPageSize'), '10');
  assert.match(await page.locator('.paper-question-page').innerText(), /快照题干 READER-20/);
  await capture('reader-desktop');
  await previous().click(); await waitReader('READER-19');
  await next().click(); await waitReader('READER-20');
  await page.reload(); await page.waitForLoadState('networkidle'); await waitReader('READER-20');
  await back().click(); await search.waitFor(); assert.equal(await search.inputValue(), '事务'); assert.equal(await page.getByLabel('题集题目每页数量', { exact: true }).inputValue(), '10');
  assert.match(await page.getByRole('navigation', { name: '题集题目分页', exact: true }).innerText(), /第\s*2\s*\//);
  await page.getByRole('link', { name: '查看题目：阅读题 20 · 事务', exact: true }).click(); await waitReader('READER-20');
  await page.goBack(); await search.waitFor(); assert.equal(await search.inputValue(), '事务');
  checks.push('列表进入独立URL且无弹窗；返回与浏览器返回恢复搜索、页码、每页数量，上一下一跨分页按题集完整顺序，刷新不丢阅读位置');

  await go(readerHref('READER-00'));
  await waitReader('READER-00'); assert.equal(await previous().getAttribute('aria-disabled'), 'true');
  const firstHref = page.url(); await previous().click({ force: true }); assert.equal(page.url(), firstHref);
  await go(readerHref('READER-GROUP::const')); await waitReader('READER-GROUP::const');
  assert.equal(await next().getAttribute('aria-disabled'), 'true');
  assert.match(await page.locator('.paper-question-page').innerText(), /公共材料：const numbers/);
  await previous().click(); await waitReader('READER-GROUP::sum');
  await page.getByRole('button', { name: /展开答案与解析/ }).click(); assert.match(await page.locator('.answer-content').innerText(), /数组之和为6/);
  assert.doesNotMatch(await page.locator('main').innerText(), /OUTSIDE_SET_CANARY/);
  checks.push('首尾导航不可越界，组合小题分别浏览并保留公共材料和答案，导航不混入其他题集或全题库');

  await go(readerHref('READER-04')); await waitReader('READER-04');
  const current = await api('/api/questions/READER-04');
  await api('/api/questions/READER-04', 'PUT', { ...current, stemMarkdown: 'LIVE_CHANGED_CANARY 这不是题集快照', answerMarkdown: 'LIVE_CHANGED_ANSWER_CANARY' });
  await page.reload(); await page.waitForLoadState('networkidle'); await waitReader('READER-04');
  assert.match(await page.locator('.question-viewer-reading').innerText(), /快照题干 READER-04/); assert.doesNotMatch(await page.locator('.question-viewer-reading').innerText(), /LIVE_CHANGED_CANARY/);
  await page.getByRole('button', { name: /展开答案与解析/ }).click(); assert.match(await page.locator('.answer-content').innerText(), /快照答案 READER-04/); assert.doesNotMatch(await page.locator('.answer-content').innerText(), /LIVE_CHANGED_ANSWER_CANARY/);
  const sourceRoute = origin + '/api/questions/READER-06';
  await page.route(sourceRoute, route => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'NOT_FOUND', message: '原题不存在' } }) }));
  await go(readerHref('READER-06')); await waitReader('READER-06');
  await page.getByText(/当前无法保存原题学习记录/).waitFor(); assert.match(await page.locator('.question-viewer-reading').innerText(), /快照题干 READER-06/); assert.equal(await page.getByLabel('我的学习笔记', { exact: true }).count(), 0);
  await page.unroute(sourceRoute);
  checks.push('原题更新后继续读取题集快照；模拟源题404仍可阅读快照并明确暂停学习记录编辑');

  await go(readerHref('READER-05')); await waitReader('READER-05');
  const notes = page.getByLabel('我的学习笔记', { exact: true }); await notes.fill('隔离验收保存笔记'); await page.getByRole('button', { name: '保存笔记', exact: true }).click();
  await waitFor(async () => (await api('/api/questions/READER-05')).study.notes === '隔离验收保存笔记');
  await notes.fill('未保存的导航笔记');
  let count = dialogs.length; dialogChoice = 'dismiss'; await next().click(); await delay(200); assert.equal(dialogs.length, count + 1); await waitReader('READER-05'); assert.equal(await notes.inputValue(), '未保存的导航笔记');
  count = dialogs.length; await back().click(); await delay(200); assert.equal(dialogs.length, count + 1); await waitReader('READER-05');
  count = dialogs.length; dialogChoice = 'accept'; await next().click(); await waitReader('READER-06'); assert.equal(dialogs.length, count + 1);
  assert.equal((await api('/api/questions/READER-05')).study.notes, '隔离验收保存笔记');
  checks.push('笔记保存同步原题，未保存时返回和切题均确认一次，取消保留输入，确认离开不偷偷保存或重复弹框');

  await go('papers/' + paperId); await page.getByRole('link', { name: '查看题目：阅读题 00 · 事务', exact: true }).click(); await waitReader('READER-00');
  await page.getByLabel('我的学习笔记', { exact: true }).fill('浏览器后退未保存笔记');
  await page.getByText('有未保存的笔记', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('我的学习笔记', { exact: true }).inputValue(), '浏览器后退未保存笔记');
  count = dialogs.length; dialogChoice = 'dismiss'; await page.goBack(); await delay(250); assert.equal(dialogs.length, count + 1); await waitReader('READER-00');
  count = dialogs.length; dialogChoice = 'accept'; await page.goBack(); await page.locator('.question-set-question-list').waitFor(); assert.equal(dialogs.length, count + 1);
  await page.getByRole('link', { name: '查看题目：阅读题 00 · 事务', exact: true }).click(); await waitReader('READER-00');
  await page.getByLabel('我的学习笔记', { exact: true }).fill('刷新未保存笔记');
  await page.getByText('有未保存的笔记', { exact: true }).waitFor();
  count = dialogs.length; dialogChoice = 'accept'; await page.reload(); await page.waitForLoadState('networkidle'); await waitReader('READER-00'); assert.ok(dialogs.slice(count).some(dialog => dialog.type === 'beforeunload')); assert.equal(await page.getByLabel('我的学习笔记', { exact: true }).inputValue(), '');
  checks.push('浏览器后退取消后留在原题，确认可返回题集；刷新使用原生未保存提示且不产生学习记录');

  // Keep a real forward branch. Cancelling traversal must restore its history
  // entry rather than replacing the target entry with the current URL.
  await go('papers/' + paperId);
  await page.getByRole('link', { name: '查看题目：阅读题 00 · 事务', exact: true }).click(); await waitReader('READER-00');
  await next().click(); await waitReader('READER-01'); await next().click(); await waitReader('READER-02');
  await page.getByLabel('我的学习笔记', { exact: true }).fill('多步后退保留的笔记'); await page.getByText('有未保存的笔记', { exact: true }).waitFor();
  const beforeBackState = await page.evaluate(() => history.state);
  count = dialogs.length; dialogChoice = 'dismiss'; await page.evaluate(() => history.go(-2));
  await waitFor(() => dialogs.length === count + 1); await page.waitForURL(url => url.hash.split('?')[0] === readerHref('READER-02'));
  await waitReader('READER-02'); assert.equal(await page.getByLabel('我的学习笔记', { exact: true }).inputValue(), '多步后退保留的笔记'); assert.deepEqual(await page.evaluate(() => history.state), beforeBackState);
  count = dialogs.length; dialogChoice = 'accept'; await page.goBack(); await waitReader('READER-01'); assert.equal(dialogs.length, count + 1);
  await page.getByLabel('我的学习笔记', { exact: true }).fill('前进取消保留的笔记'); await page.getByText('有未保存的笔记', { exact: true }).waitFor();
  const beforeForwardState = await page.evaluate(() => history.state);
  count = dialogs.length; dialogChoice = 'dismiss'; await page.goForward();
  await waitFor(() => dialogs.length === count + 1); await page.waitForURL(url => url.hash.split('?')[0] === readerHref('READER-01'));
  await waitReader('READER-01'); assert.equal(await page.getByLabel('我的学习笔记', { exact: true }).inputValue(), '前进取消保留的笔记'); assert.deepEqual(await page.evaluate(() => history.state), beforeForwardState);
  count = dialogs.length; dialogChoice = 'accept'; await page.goForward(); await waitReader('READER-02'); assert.equal(dialogs.length, count + 1);
  await page.goBack(); await waitReader('READER-01'); await page.goBack(); await waitReader('READER-00');
  assert.equal((await api('/api/questions/READER-01')).study.notes, '');
  checks.push('多步history.go(-2)与Forward取消均恢复原题、笔记和原历史项；再次确认可前后遍历，既有历史分支未被覆盖');

  await go(readerHref('READER-OUTSIDE')); await page.getByText(/不属于|不在|不存在|无法读取|未找到/).first().waitFor(); assert.equal(await page.locator('.question-viewer-reading').count(), 0); await back().click(); await page.locator('.question-set-question-list').waitFor();
  await go('#/papers/MISSING-SET/questions/READER-00'); await page.getByRole('alert').waitFor(); assert.equal(await page.locator('.question-viewer-reading').count(), 0);
  await go('#/papers/' + paperId + '/questions/%E0%A4%A'); await page.getByText(/链接格式不正确|题目链接无效/).waitFor();
  checks.push('非本集题号、缺失题集与非法编码链接均显示明确状态，不回退为全题库题目');

  const settings = await api('/api/settings'); await api('/api/settings', 'PUT', { settings: { ...settings, theme: 'dark' } });
  for (const width of [390, 320]) { await page.setViewportSize({ width, height: 1000 }); await go(readerHref('READER-02')); await waitReader('READER-02'); await capture('reader-dark-' + width); await next().click(); await waitReader('READER-03'); await back().click(); await page.locator('.question-set-question-list').waitFor(); }
  checks.push('390和320暗色独立阅读页、导航和返回正常，无整页横向溢出');

  const exam = await api('/api/papers/' + paperId + '/attempts', 'POST', { mode: 'exam', durationMinutes: 120 }, 201);
  await api('/api/papers/' + paperId + '/questions/READER-00', 'GET', undefined, 409);
  await go(readerHref('READER-00')); await page.waitForURL('**#/attempts/' + exam.id); await page.locator('.exam-lock-banner').waitFor(); assert.equal(await page.locator('.paper-question-page').count(), 0);
  await api('/api/attempts/' + exam.id + '/submit', 'POST', { answers: {} });
  checks.push('活动考试阻止题集快照API和独立阅读页面，无法绕过考试锁查看答案');

  assert.deepEqual(errors, [], 'browser errors'); assert.deepEqual(externalRequests, [], 'unexpected external requests');
  const report = { passed: checks.length, checks, errors, externalRequests, dialogs, isolated: true, databasePath: ':memory:' };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  if (page) await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(resolve(output, 'failure.json'), JSON.stringify({ message: error.message, url: page?.url(), checks, errors, externalRequests, dialogs, stderr }, null, 2)); throw error;
} finally { await browser?.close(); server.kill(); }
