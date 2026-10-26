/** Shared spacing and responsive layout checks use a disposable in-memory app. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '../..');
const baseline = process.argv.includes('--baseline');
const output = resolve(root, 'test-results/layout-ui' + (baseline ? '-baseline' : ''));
await mkdir(output, { recursive: true });
await Promise.all(['failure.json', 'failure.png'].map(name => rm(resolve(output, name), { force: true })));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : 'playwright');
const fixture = `import assert from 'node:assert/strict';
import {buildApp} from './server/index.ts';
import {Store} from './server/core/store.ts';
import {DEFAULT_SETTINGS} from './shared/models/settings.ts';
import {questionSchema} from './server/core/validation.ts';
import {buildPaper,createAttempt,submitAttempt,saveAttempt} from './server/modules/practice/service.ts';
import {importData,exportData} from './server/modules/transfer/migration.ts';
const staging=new Store(':memory:'),stamp=new Date().toISOString();
staging.put('domains','layout-domain',{id:'layout-domain',name:'计算机基础与应用',description:'隔离样式验收',sortOrder:0});
staging.put('categories','layout-category',{id:'layout-category',domainId:'layout-domain',parentId:null,name:'软件与系统基础',description:'常用知识',sortOrder:0});
staging.put('categories','layout-child',{id:'layout-child',domainId:'layout-domain',parentId:'layout-category',name:'并发与事务',description:'细分类',sortOrder:1});
staging.put('tags','layout-tag',{id:'layout-tag',domainId:'layout-domain',name:'事务与一致性',kind:'topic',description:'概念与应用',color:'#39C5BB'});
staging.put('settings','system',{...structuredClone(DEFAULT_SETTINGS),updatedAt:stamp});
for(let index=0;index<14;index++){
 const id='LAYOUT-'+index,type=index===1?'short_answer':'true_false';
 staging.put('questions',id,questionSchema.parse({id,title:index===1?'解释事务隔离性的边界':'事务基础判断 '+index,type,stemMarkdown:index===1?'解释隔离性及其对并发执行的约束。':'事务提交后，已持久化的数据应在重启后保持。',answerMarkdown:type==='true_false'?'正确':'隔离性约束并发事务之间的可见性及相互影响。',explanationMarkdown:'先说明概念，再给出边界案例。',correctAnswers:type==='true_false'?['true']:[],status:'published',categoryIds:['layout-child'],tagIds:['layout-tag'],createdAt:stamp,updatedAt:stamp}));
}
staging.put('questions','LAYOUT-PENDING',questionSchema.parse({id:'LAYOUT-PENDING',title:'待审核基础题',type:'true_false',stemMarkdown:'事务是否保证原子性？',correctAnswers:['true'],status:'pending',categoryIds:['layout-child'],tagIds:['layout-tag'],createdAt:stamp,updatedAt:stamp}));
const paper=buildPaper(staging,{id:'LAYOUT-PAPER',title:'基础知识练习与复习题集',description:'用于验证题集操作、卡片、筛选和分隔间距。',mode:'manual',questionIds:['LAYOUT-0','LAYOUT-1','LAYOUT-2'],scoring:{enabled:false}});
staging.put('papers',paper.id,paper);
const draft=createAttempt(staging,paper);saveAttempt(staging,draft,{});
const completed=createAttempt(staging,paper);submitAttempt(staging,completed,{'LAYOUT-0':{value:'false'},'LAYOUT-1':{value:'隔离性限制事务之间的干扰。'}});
staging.putStudy({...staging.study('LAYOUT-0'),favorite:true,notes:'注意隔离级别与数据库实现的区别。'});
const data=exportData(staging);staging.db.close();
const app=await buildApp({databasePath:':memory:',seedPath:'no-layout-seed',staticRoot:'dist/web',dailyPushScheduler:false,logger:false});
const imported=await app.inject({url:'/api/import',method:'POST',payload:{mode:'merge',data}});assert.equal(imported.statusCode,200,imported.body);
const doc=await app.inject({url:'/api/documents',method:'POST',payload:{title:'事务与并发基础阅读资料',kind:'书籍',format:'markdown',bodyMarkdown:'# 事务基础\\n\\n先理解概念，再用场景检验。\\n\\n## 关键概念\\n\\n- 原子性\\n- 一致性\\n- 隔离性\\n- 持久性',collection:'general',domainIds:['layout-domain'],categoryIds:['layout-child'],tagIds:['layout-tag'],author:'样式验收',description:'合成资料，仅用于布局检查。'}});assert.equal(doc.statusCode,201,doc.body);
const origin=await app.listen({host:'127.0.0.1',port:0});
console.log('LAYOUT_READY '+JSON.stringify({origin,paperId:paper.id,documentId:doc.json().id,draftId:draft.id,submittedId:completed.id}));`;
const server = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', fixture], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderr = '', browser, page;
server.stdout.on('data', value => stdout += value);
server.stderr.on('data', value => stderr = (stderr + value).slice(-20000));
const checks = [], samples = [], findings = [], errors = [], externalRequests = [];
try {
  let state;
  for (let index = 0; index < 300; index++) {
    if (server.exitCode !== null) throw new Error(stderr);
    const line = stdout.split(/\r?\n/).find(value => value.startsWith('LAYOUT_READY '));
    if (line) { state = JSON.parse(line.slice('LAYOUT_READY '.length)); break; }
    await delay(100);
  }
  assert.ok(state, stderr); const { origin } = state;
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => void dialog.dismiss());
  await page.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === origin || ['blob:', 'data:'].includes(url.protocol)) return route.continue(); externalRequests.push(url.origin); return route.abort(); });
  const api = async (path, method = 'GET', data, status = 200) => {
    const response = await context.request.fetch(origin + path, { method, ...(data === undefined ? {} : { data }) });
    assert.equal(response.status(), status, path + ': ' + await response.text()); return response.json();
  };
  let navigation = 0;
  const go = async path => {
    await page.goto(origin + '/?layout-ui=' + ++navigation + '#/' + path);
    await page.waitForLoadState('networkidle');
    await page.locator('main').waitFor();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const geometry = async label => {
    const result = await page.evaluate(() => {
      const visible = element => { const rect = element.getBoundingClientRect(), css = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && css.display !== 'none' && css.visibility !== 'hidden'; };
      const name = element => (element.getAttribute('aria-label') || element.className || element.tagName).toString().slice(0, 110);
      const issues = [];
      if (document.documentElement.scrollWidth > innerWidth + 1) issues.push({ kind: 'horizontal-overflow', amount: document.documentElement.scrollWidth - innerWidth, offenders: [...document.querySelectorAll('main *')].filter(visible).filter(element => element.getBoundingClientRect().right > innerWidth + 1).slice(0, 7).map(name) });
      const cards = [...document.querySelectorAll('main .card')].filter(visible);
      for (const card of cards) {
        const next = card.nextElementSibling;
        if (!next?.matches('.card') || !visible(next)) continue;
        const first = card.getBoundingClientRect(), second = next.getBoundingClientRect();
        const overlap = Math.min(first.right, second.right) - Math.max(first.left, second.left);
        if (overlap > Math.min(first.width, second.width) * .5 && second.top >= first.bottom - 1 && second.top - first.bottom < 11) issues.push({ kind: 'stacked-cards', first: name(card), next: name(next), gap: Math.round(second.top - first.bottom) });
      }
      for (const next of [...document.querySelectorAll('main *')].filter(visible)) {
        if (next.matches('button,a,input,select,textarea,.badge,.tag')) continue;
        if (parseFloat(getComputedStyle(next).borderTopWidth) < 1) continue;
        const previous = next.previousElementSibling;
        if (!previous || !visible(previous) || !previous.matches('.button,.form-actions,.action-row,.header-actions,.ui-actions,.settings-footer')) continue;
        const controls = previous.matches('.button') ? [previous] : [...previous.querySelectorAll('button,a.button')].filter(visible);
        if (!controls.length) continue;
        const a = { bottom: Math.max(...controls.map(control => control.getBoundingClientRect().bottom)) }, b = next.getBoundingClientRect();
        if (b.top >= a.bottom - 1 && b.top - a.bottom < 11) issues.push({ kind: 'action-before-divider', first: name(previous), next: name(next), gap: Math.round(b.top - a.bottom) });
      }
      const footer = document.querySelector('main > .page-footer');
      const previous = footer?.previousElementSibling;
      if (footer && previous && visible(previous)) {
        const gap = footer.getBoundingClientRect().top - previous.getBoundingClientRect().bottom;
        if (gap < 15) issues.push({ kind: 'page-footer', gap: Math.round(gap) });
      }
      return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, cards: cards.length, issues };
    });
    samples.push({ label, ...result });
    for (const issue of result.issues) findings.push({ label, ...issue });
  };
  const capture = async name => {
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0); });
    await page.screenshot({ path: resolve(output, name + '.png'), fullPage: true });
  };
  const routes = [
    ['overview', ''], ['settings', 'settings'], ['settings-daily', 'settings?tab=daily'],
    ['settings-ai', 'settings?tab=ai'], ['settings-backup', 'settings?tab=backup'], ['settings-assets', 'settings?tab=assets'],
    ['questions', 'questions'], ['question-detail', 'questions/LAYOUT-0'], ['question-editor', 'questions/LAYOUT-1/edit'],
    ['question-import', 'questions/import'], ['question-review', 'questions/review'],
    ['papers', 'papers'], ['paper-detail', 'papers/' + state.paperId],
    ['paper-editor', 'papers/' + state.paperId + '/edit'], ['paper-random', 'papers/new/random'],
    ['attempt', 'attempts/' + state.draftId], ['attempt-review', 'attempts/' + state.submittedId],
    ['quick', 'quick'], ['review-queue', 'learning/due'],
    ['documents', 'documents'], ['document-detail', 'documents/' + state.documentId], ['document-editor', 'documents/' + state.documentId + '/edit'],
    ['taxonomy', 'taxonomy'], ['search', 'search?q=事务'], ['analytics', 'analytics'], ['weekly', 'analytics?tab=weekly'],
    ['sharing', 'sharing'], ['ai', 'ai?tab=paper'],
  ];
  for (const width of [1440, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const [name, route] of routes) {
      await go(route);
      if (width <= 390) await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.style.colorScheme = 'dark'; });
      await geometry(name + '-' + width);
      if ((width === 1440 || width === 390) && ['settings', 'settings-backup', 'paper-detail', 'paper-editor', 'question-detail', 'document-editor', 'taxonomy'].includes(name)) await capture(name + '-' + width);
    }
  }
  checks.push('28个主要页面在1440、1024、390、320宽度逐页检查横向溢出、卡片及操作分隔间距');
  for (const theme of ['green', 'dark', 'pink', 'sky', 'mint']) {
    const settings = await api('/api/settings');
    await api('/api/settings', 'PUT', { settings: { ...settings, theme } });
    await page.setViewportSize({ width: 390, height: 1000 });
    await go('settings');
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    await geometry('settings-theme-' + theme); await capture('settings-theme-' + theme);
  }
  checks.push('五个内置主题从真实配置加载，手机设置布局和表单保持可用');
  // Exercise reusable controls without creating application content.
  await page.setViewportSize({ width: 1440, height: 1000 }); await go('settings');
  const duration = page.getByLabel('考试模式默认时长（分钟）', { exact: true });
  await duration.fill('90');
  await page.getByRole('button', { name: '保存系统配置', exact: true }).click();
  for (let index = 0; index < 30 && (await api('/api/settings')).examDurationMinutes !== 90; index++) await delay(100);
  assert.equal((await api('/api/settings')).examDurationMinutes, 90);
  await page.getByRole('button', { name: '数据与备份', exact: true }).click();
  await page.getByRole('heading', { name: '完整 JSON 备份', exact: true }).waitFor();
  await geometry('settings-backup-tab-click');
  checks.push('设置保存及分区切换通过真实按钮操作，复用样式未影响表单与导航');
  await go('questions/LAYOUT-0');
  await page.getByRole('button', { name: /我想过了，展开答案/ }).click();
  await page.locator('.answer-content').waitFor();
  await geometry('question-expanded-answer');
  await go('papers/' + state.paperId);
  await page.getByLabel(/^查看题目：/).first().click();
  await page.waitForURL(/#\/papers\/[^/]+\/questions\//); assert.equal(await page.getByRole('dialog').count(), 0);
  await page.locator('.question-viewer').waitFor(); await geometry('paper-question-page'); await capture('paper-question-page');
  await page.getByRole('link', { name: /^返回题集(?:\s|$)/ }).click();
  checks.push('展开解析和题集独立看题页面可用，操作栏、分隔及滚动边界保持正常');
  assert.deepEqual(errors, [], 'browser errors'); assert.deepEqual(externalRequests, [], 'unexpected external request');
  const report = { passed: checks.length, checks, samples: samples.length, findings, errors, externalRequests, baseline, isolated: true, databasePath: ':memory:' };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (!baseline) assert.deepEqual(findings, [], 'layout spacing or overflow findings');
} catch (error) {
  if (page) await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(resolve(output, 'failure.json'), JSON.stringify({ message: error.message, checks, samples, findings, errors, externalRequests, stderr }, null, 2));
  throw error;
} finally { await browser?.close(); server.kill(); }
