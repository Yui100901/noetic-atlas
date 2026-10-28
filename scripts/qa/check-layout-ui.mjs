/** Shared spacing and responsive layout checks use a disposable in-memory app. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '../..');
const baseline = process.argv.includes('--baseline');
const full=process.argv.includes('--full');
const output = resolve(root, 'test-results/'+(full?'full-page-experience':'layout-ui') + (baseline ? '-baseline' : ''));
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
import {PDFDocument} from 'pdf-lib';
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
for(const value of [
 {id:'LAYOUT-CHOICE',type:'single_choice',options:[{key:'A',text:'整体提交或回滚'},{key:'B',text:'任意部分提交'}],correctAnswers:['A']},
 {id:'LAYOUT-MULTI',type:'multiple_choice',options:[{key:'A',text:'原子性'},{key:'B',text:'持久性'},{key:'C',text:'随机丢失已提交记录'}],correctAnswers:['A','B']},
 {id:'LAYOUT-FILL',type:'fill_blank',stemMarkdown:'一组操作整体提交或回滚的性质称为______。',blanks:[{id:'name',label:'性质',answers:['原子性'],caseSensitive:false,trim:true}]},
 {id:'LAYOUT-GROUP',type:'group',parts:[{id:'explain',title:'说明原子性',type:'short_answer',stemMarkdown:'说明整体提交的含义。',answerMarkdown:'全部成功或全部回滚。',weight:1},{id:'decide',title:'判断整体结果',type:'true_false',stemMarkdown:'事务允许任意部分提交。',correctAnswers:['false'],weight:1}]},
 {id:'LAYOUT-CONCEPT',type:'short_answer',concept:{term:'原子性',meaningPrompt:'一组操作整体提交或回滚的性质',acceptedAnswers:['原子性']}},
 {id:'LAYOUT-WORD',type:'short_answer',title:'transaction',vocabulary:{language:'en',headword:'transaction',meaningPrompt:'一组整体提交或回滚的操作',acceptedAnswers:['transaction'],pronunciations:[{label:'英语',ipa:'/trænˈzækʃən/',sourceLabel:'合成测试数据',sourceUrl:'https://example.invalid/fixture',license:'仅供隔离测试',method:'manual'}]}},
])staging.put('questions',value.id,questionSchema.parse({title:'交互测试 '+value.id,stemMarkdown:'阅读条件并回答事务相关问题。',answerMarkdown:'原子性要求整体提交或回滚。',explanationMarkdown:'结合失败恢复理解事务边界。',categoryIds:['layout-child'],tagIds:['layout-tag'],status:'published',createdAt:stamp,updatedAt:stamp,...value}));
const paper=buildPaper(staging,{id:'LAYOUT-PAPER',title:'基础知识练习与复习题集',description:'用于验证题集操作、卡片、筛选和分隔间距。',mode:'manual',questionIds:['LAYOUT-0','LAYOUT-1','LAYOUT-2'],scoring:{enabled:false}});
staging.put('papers',paper.id,paper);
const draft=createAttempt(staging,paper);saveAttempt(staging,draft,{});
const completed=createAttempt(staging,paper);submitAttempt(staging,completed,{'LAYOUT-0':{value:'false'},'LAYOUT-1':{value:'隔离性限制事务之间的干扰。'}});
staging.putStudy({...staging.study('LAYOUT-0'),favorite:true,notes:'注意隔离级别与数据库实现的区别。'});
const data=exportData(staging);staging.db.close();
const app=await buildApp({databasePath:':memory:',seedPath:'no-layout-seed',staticRoot:'dist/web',dailyPushScheduler:false,logger:false});
const imported=await app.inject({url:'/api/import',method:'POST',payload:{mode:'merge',data}});assert.equal(imported.statusCode,200,imported.body);
const doc=await app.inject({url:'/api/documents',method:'POST',payload:{title:'事务与并发基础阅读资料',kind:'书籍',format:'markdown',bodyMarkdown:'# 事务基础\\n\\n先理解概念，再用场景检验。\\n\\n## 关键概念\\n\\n- 原子性\\n- 一致性\\n- 隔离性\\n- 持久性',collection:'general',domainIds:['layout-domain'],categoryIds:['layout-child'],tagIds:['layout-tag'],author:'样式验收',description:'合成资料，仅用于布局检查。'}});assert.equal(doc.statusCode,201,doc.body);
const feedback=await app.inject({url:'/api/question-feedback',method:'POST',payload:{questionId:'LAYOUT-0',kind:'answer',description:'请核对当前答案适用的隔离级别。'}});assert.equal(feedback.statusCode,201,feedback.body);
const pdf=await PDFDocument.create();pdf.addPage([400,600]);const bytes=Buffer.from(await pdf.save());
const asset=await app.inject({url:'/api/assets',method:'POST',payload:{filename:'Layout.pdf',mimeType:'application/pdf',dataBase64:bytes.toString('base64')}});assert.equal(asset.statusCode,201,asset.body);
const pdfDoc=await app.inject({url:'/api/documents',method:'POST',payload:{title:'PDF排版检查',kind:'书籍',format:'pdf',assetId:asset.json().id,domainIds:['layout-domain']}});assert.equal(pdfDoc.statusCode,201,pdfDoc.body);
await app.inject({url:'/api/ai/settings',method:'PUT',payload:{enabled:true,baseUrl:'http://127.0.0.1:9',model:'layout-local',supportsImages:false,sendImages:false,maxTokens:16384,timeoutSeconds:30}});
const empty=await buildApp({databasePath:':memory:',seedPath:'no-empty-layout-seed',staticRoot:'dist/web',dailyPushScheduler:false,logger:false});
const emptyOrigin=await empty.listen({host:'127.0.0.1',port:0});
const wrong=(await app.inject('/api/learning/global/questions?kind=wrong&page=1&pageSize=20')).json();
const readerKey=wrong.items[0].key;
const origin=await app.listen({host:'127.0.0.1',port:0});
console.log('LAYOUT_READY '+JSON.stringify({origin,emptyOrigin,readerKey,pdfDocumentId:pdfDoc.json().id,issueId:feedback.json().qualityIssueId,paperId:paper.id,documentId:doc.json().id,draftId:draft.id,submittedId:completed.id}));`;
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
  await page.route('**/*', route => { const url = new URL(route.request().url()); if ([origin,state.emptyOrigin].includes(url.origin) || ['blob:', 'data:'].includes(url.protocol)) return route.continue(); externalRequests.push(url.origin); return route.abort(); });
  const api = async (path, method = 'GET', data, status = 200) => {
    const response = await context.request.fetch(origin + path, { method, ...(data === undefined ? {} : { data }) });
    assert.equal(response.status(), status, path + ': ' + await response.text()); return response.json();
  };
  let navigation = 0;
  const go = async (path,site=origin) => {
    await page.goto(site + '/?layout-ui=' + ++navigation + '#/' + path);
    await page.waitForLoadState('networkidle');
    await page.locator('main').waitFor();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const geometry = async label => {
    const result = await page.evaluate(() => {
      const visible = element => { const rect = element.getBoundingClientRect(), css = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && css.display !== 'none' && css.visibility !== 'hidden'; };
      const name = element => (element.getAttribute('aria-label') || element.className || element.tagName).toString().slice(0, 110);
      const issues = [];
      for(const alert of [...document.querySelectorAll('main [role="alert"],main .fatal-error')].filter(visible))issues.push({kind:'unexpected-page-error',message:alert.textContent.trim().slice(0,250)});
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
      for(const heading of [...document.querySelectorAll('main .quality-item-heading')].filter(visible)){const labels=[...heading.children].filter(visible).map(child=>child.textContent.trim()).filter(Boolean);if(new Set(labels).size!==labels.length)issues.push({kind:'duplicate-quality-label',labels});}
      const headers=[...document.querySelectorAll('main .page-header')].filter(visible).map(header=>({title:header.querySelector('h1')?.textContent?.trim(),actions:[...header.querySelectorAll('.header-actions button,.header-actions a')].filter(visible).map(control=>({label:control.getAttribute('aria-label')||control.textContent.trim(),href:control.getAttribute('href')}))}));
      for(const header of headers){const seen=new Set();for(const action of header.actions){const key=action.label+'|'+(action.href||'');if(seen.has(key))issues.push({kind:'duplicate-header-action',title:header.title,action:action.label});seen.add(key);}}
      return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, cards: cards.length, headers,issues };
    });
    samples.push({ label, ...result });
    for (const issue of result.issues) findings.push({ label, ...issue });
  };
  const capture = async name => {
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0); });
    await page.screenshot({ path: resolve(output, name + '.png'), fullPage: !name.startsWith('handbook-') });
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
  if(full)routes.push(
    ['question-new','questions/new'],['question-study','questions/LAYOUT-1?answer=1'],
    ['quality','content-quality'],['quality-editor','questions/LAYOUT-0/edit?returnTo='+encodeURIComponent('#/content-quality')+'&issueId='+state.issueId],
    ['feedback-redirect','question-feedback?questionId=LAYOUT-0'],
    ['paper-manual','papers/new/manual'],['paper-reading','papers/'+state.paperId+'/questions/LAYOUT-0'],
    ...['history','drafts','wrong','favorite','review'].map(tab=>['paper-'+tab,'papers/'+state.paperId+'?tab='+tab]),
    ...['wrong','favorite'].map(kind=>['global-'+kind,'learning/'+kind]),
    ['learning-reader','learning-reader?scope=global&kind=wrong&item='+encodeURIComponent(state.readerKey)+'&page=1&pageSize=20'],
    ['quick-history','quick?tab=history'],['quick-drafts','quick?tab=drafts'],
    ['document-new','documents/new'],['document-pdf','documents/'+state.pdfDocumentId],
    ['ai-import','ai?tab=import'],['ai-documents','ai?tab=documents'],['ai-history','ai?tab=history'],
    ['analytics-day','analytics?mode=day'],['analytics-month','analytics?mode=month'],['analytics-custom','analytics?mode=custom'],['analytics-year','analytics?mode=year'],['handbook','help']
  );
  if(full)for(const id of ['CHOICE','MULTI','FILL','GROUP','CONCEPT','WORD'])routes.push(['question-'+id.toLowerCase(),'questions/LAYOUT-'+id],['editor-'+id.toLowerCase(),'questions/LAYOUT-'+id+'/edit']);
  for (const width of [1440, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const [name, route] of routes) {
      await go(route);
      if (width <= 390) await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.style.colorScheme = 'dark'; });
      await geometry(name + '-' + width);
      if ((width === 1440 || width === 390) && (full?['overview','settings','settings-backup','paper-detail','papers','paper-editor','question-detail','question-editor','document-editor','documents','taxonomy','quality','handbook','ai-import','sharing']:['settings','settings-backup','paper-detail','paper-editor','question-detail','document-editor','taxonomy']).includes(name)) await capture(name + '-' + width);
    }
  }
  checks.push(routes.length+'个页面/状态在1440、1024、390、320宽度检查横向溢出、卡片/操作间距与重复头部动作');
  if(full){for(const width of [1440,390]){await page.setViewportSize({width,height:1000});for(const route of ['','questions','questions/review','content-quality','papers','documents','taxonomy','sharing','ai','ai?tab=import','ai?tab=documents','ai?tab=history','analytics','settings','help']){await go(route,state.emptyOrigin);await geometry('empty-'+(route||'overview')+'-'+width);}}checks.push('15个空库页面在桌面和手机验证首次使用布局及唯一操作入口');}
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
  const report = { passed: checks.length, checks, samples: samples.length, findings, errors, externalRequests, baseline, full, routes:routes.length, isolated: true, databasePath: ':memory:' };
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (!baseline) assert.deepEqual(findings, [], 'layout spacing or overflow findings');
} catch (error) {
  if (page) await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(resolve(output, 'failure.json'), JSON.stringify({ message: error.message, checks, samples, findings, errors, externalRequests, stderr }, null, 2));
  throw error;
} finally { await browser?.close(); server.kill(); }
