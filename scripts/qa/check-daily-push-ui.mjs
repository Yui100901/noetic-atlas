/** Daily recommendation cards and configuration use a disposable service. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root=resolve(import.meta.dirname,'../..'),output=resolve(root,'test-results/daily-push-ui');
await mkdir(output,{recursive:true});
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');
const fixture=`import assert from 'node:assert/strict';
import {buildApp} from './server/index.ts';
import {Store} from './server/core/store.ts';
import {DEFAULT_SETTINGS} from './shared/models/settings.ts';
import {questionSchema} from './server/core/validation.ts';
import {importData,exportData} from './server/modules/transfer/migration.ts';
import {checkDailyPush} from './server/modules/daily-push/service.ts';
const staging=new Store(':memory:'), now=new Date('2026-10-25T04:00:00Z');
const domains=[{id:'daily-domain',name:'每日测试领域',description:'',sortOrder:0},{id:'other-domain',name:'其他领域',description:'',sortOrder:1}];
const categories=[{id:'daily-root',domainId:'daily-domain',name:'每日测试分类',parentId:null,description:'',sortOrder:0},{id:'daily-child',domainId:'daily-domain',name:'子类练习',parentId:'daily-root',description:'',sortOrder:1},{id:'shortage',domainId:'other-domain',name:'不足题量分类',parentId:null,description:'',sortOrder:0}];
const question=(id,type,category)=>questionSchema.parse({id,title:'每日题目 '+id,type,stemMarkdown:'解释或判断基础概念 '+id,answerMarkdown:type==='true_false'?'正确':'概念解释',explanationMarkdown:'本题用于隔离验收。',correctAnswers:type==='true_false'?['true']:[],categoryIds:[category],tagIds:[],status:'published'});
const questions=[...Array.from({length:10},(_,i)=>question('REVIEW-'+i,'true_false','daily-child')),...Array.from({length:15},(_,i)=>question('NEW-'+i,'short_answer','daily-child')),question('SHORTAGE-ONLY','true_false','shortage')];
const study=questions.filter(q=>q.id.startsWith('REVIEW')).map(q=>({questionId:q.id,favorite:false,mastery:1,notes:'私人学习笔记',nextReviewAt:'2026-10-24T00:00:00Z',lastReviewedAt:'2026-10-23T00:00:00Z',wrongCount:0}));
importData(staging,{schemaVersion:1,domains,categories,tags:[],questions,documents:[],papers:[],study});
staging.put('settings','system',{...structuredClone(DEFAULT_SETTINGS),updatedAt:'2026-10-24T00:00:00Z',dailyPush:{...DEFAULT_SETTINGS.dailyPush,enabled:true,domainId:'other-domain',categoryIds:['shortage']}});
const old=checkDailyPush(staging,new Date('2026-10-24T04:00:00Z')).record;assert.ok(old&&old.shortfall===49);
const archived=staging.require('papers',old.paperId);staging.put('papers',archived.id,{...archived,archived:true});
staging.put('settings','system',{...structuredClone(DEFAULT_SETTINGS),updatedAt:'2026-10-24T01:00:00Z'});
const data=exportData(staging);staging.db.close();
const app=await buildApp({databasePath:':memory:',seedPath:'no-daily-qa-seed',staticRoot:'dist/web',dailyPushScheduler:false,dailyPushNow:()=>now,logger:false});
const response=await app.inject({url:'/api/import',method:'POST',payload:{mode:'merge',data}});assert.equal(response.statusCode,200,response.body);
const origin=await app.listen({host:'127.0.0.1',port:0});console.log('DAILY_PUSH_READY '+JSON.stringify({origin,oldId:old.id}));`;
const server=spawn(process.execPath,['--import','tsx','--input-type=module','-e',fixture],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='',browser,page;
server.stdout.on('data',v=>stdout+=v);server.stderr.on('data',v=>stderr=(stderr+v).slice(-10000));
const checks=[],errors=[],externalRequests=[];
try{
  let state;
  for(let i=0;i<300;i++){if(server.exitCode!==null)throw Error(stderr);const line=stdout.split(/\r?\n/).find(v=>v.startsWith('DAILY_PUSH_READY '));if(line){state=JSON.parse(line.slice(17));break;}await delay(100);}
  assert.ok(state,stderr);const{origin}=state;
  browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true});
  page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(15000);
  page.on('pageerror',e=>errors.push(e.message));
  page.on('dialog',dialog=>void dialog.accept());
  await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||['data:','blob:'].includes(url.protocol))return route.continue();externalRequests.push(url.origin);return route.abort();});
  const api=async(path,method='GET',data,status=200)=>{const response=await page.request.fetch(origin+path,{method,...(data===undefined?{}:{data})});assert.equal(response.status(),status,path+': '+await response.text());return response.json();};
  let navigation=0;const go=async path=>{await page.goto(origin+'/?daily-ui='+ ++navigation+'#/'+path);await page.waitForLoadState('networkidle');};
  const noOverflow=async()=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'horizontal overflow');
  const capture=async name=>{await noOverflow();await page.screenshot({path:resolve(output,name+'.png'),fullPage:true});};
  await go('settings?tab=practice');await page.getByRole('heading',{name:'每题型默认分值',exact:true}).waitFor();await page.locator('.settings-points-disclosure > summary').click();
  assert.equal(await page.getByLabel('多选默认分值',{exact:true}).inputValue(),'4');
  let overview=await api('/api/daily-push');assert.equal(overview.config.enabled,false);assert.equal(overview.today,null);
  await api('/api/daily-push/check','POST');assert.equal((await api('/api/daily-push')).today,null);
  checks.push('多选默认4分，未开启每日推题时不生成今天题集');

  const recommendation=()=>page.getByRole('status',{name:'每日推荐',exact:true});
  const noStandaloneEntry=async()=>{
    assert.equal(await page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('link',{name:'每日推题',exact:true}).count(),0);
    assert.equal(await page.locator('.daily-push-topbar-link,.daily-push-banner').count(),0);
  };
  await go('papers');await recommendation().getByRole('link',{name:'开启每日推荐',exact:true}).waitFor();
  await noStandaloneEntry();assert.equal(await page.locator('.paper-card').count(),0);
  await capture('disabled-card-desktop');checks.push('每日推荐仅在题集页展示紧凑卡片，关闭时提供配置入口，主导航和顶部没有独立栏目或提醒');

  const dashboardDaily=()=>page.locator('.learning-next .daily-push-quick-link');
  await go('');await dashboardDaily().getByText('开启每日推荐',{exact:true}).waitFor();
  assert.equal(await dashboardDaily().getAttribute('href'),'#/settings?tab=daily');
  await dashboardDaily().click();await page.waitForURL(/#\/settings\?tab=daily/);
  checks.push('知识总览今日学习建议在未开启时提供每日推荐配置入口');

  await go('settings?tab=daily');await page.getByRole('heading',{name:'每日推题',exact:true}).waitFor();
  assert.equal(await page.getByLabel('复习题目标分值',{exact:true}).inputValue(),'30');assert.equal(await page.getByLabel('新题目标分值',{exact:true}).inputValue(),'20');
  await page.getByLabel('开启每日推题',{exact:true}).check();await page.getByRole('button',{name:'保存推题配置',exact:true}).click();
  assert.equal((await api('/api/settings')).dailyPush.enabled,false,'missing scope must not save');
  await page.getByLabel('推题领域',{exact:true}).selectOption('daily-domain');await page.getByRole('checkbox',{name:'每日测试分类',exact:true}).check();
  // Save a future schedule so the set can be generated while the papers page
  // is already mounted, exercising its list invalidation after generation.
  await page.getByText('推题时间与时区',{exact:true}).click();await page.getByLabel('每日推题时间',{exact:true}).fill('23:59');
  await page.getByRole('button',{name:'保存推题配置',exact:true}).click();await page.getByText('每日推题配置已保存',{exact:true}).waitFor();
  assert.equal((await api('/api/daily-push')).today,null);assert.equal(await recommendation().count(),0);await noStandaloneEntry();
  await go('');await dashboardDaily().getByText('查看每日推荐',{exact:true}).waitFor();
  assert.equal(await dashboardDaily().getAttribute('href'),'#/papers');
  await go('papers');await recommendation().getByRole('button',{name:'检查今日推荐',exact:true}).waitFor();
  assert.equal(await page.locator('.paper-card').count(),0);
  const scheduled=await api('/api/settings');await api('/api/settings','PUT',{settings:{...scheduled,dailyPush:{...scheduled.dailyPush,scheduleTime:'00:00'}}});
  await recommendation().getByRole('button',{name:'检查今日推荐',exact:true}).click();
  await recommendation().getByRole('link',{name:'打开今日题集',exact:true}).waitFor();
  overview=await api('/api/daily-push');const today=overview.today;assert.equal(today.reviewPoints,10);assert.equal(today.newPoints,42);assert.equal(today.totalPoints,52);assert.equal(today.transferredPoints,20);assert.equal(today.shortfall,0);assert.equal(today.questionIds.length,24);assert.ok(today.questionIds.every(id=>id!=='SHORTAGE-ONLY'));
  assert.equal(today.title,'2026-10-25 每日推荐');
  await page.getByRole('article',{name:'题集：2026-10-25 每日推荐',exact:true}).waitFor();
  assert.ok(page.url().endsWith('#/papers'),'generating a recommendation must stay on the mounted set list');
  assert.match(await recommendation().innerText(),/复习\s+10\s*分/);assert.match(await recommendation().innerText(),/新题\s+42\s*分/);assert.match(await recommendation().innerText(),/合计\s+52\s*分/);
  await recommendation().getByText('新推送',{exact:true}).waitFor();assert.equal(await recommendation().locator('.daily-push-card-date').innerText(),'2026-10-25');
  const bounds=await recommendation().boundingBox();assert.ok(bounds&&bounds.height<230,'desktop daily card should stay compact');
  checks.push('配置必须选择领域分类，父分类覆盖下级；复习10分不足部分补新题42分，总分52允许超额');
  await capture('generated-card-desktop');checks.push('已挂载题集列表立即显示按日期命名的每日推荐，不离页或刷新；题集正常保存在题集库中');

  await go('');await dashboardDaily().getByText('开始今日推荐',{exact:true}).waitFor();
  assert.equal(await dashboardDaily().getAttribute('href'),'#/papers/'+today.paperId);
  assert.equal((await api('/api/daily-push')).today.readAt,null);
  await capture('dashboard-daily-desktop');await dashboardDaily().click();await page.waitForURL(new RegExp(today.paperId));
  for(let i=0;i<30;i++){if((await api('/api/daily-push')).today.readAt)break;await delay(100);}
  assert.ok((await api('/api/daily-push')).today.readAt);
  checks.push('总览待生成时进入题集页，生成后直接打开今日推荐并标记已读');
  await go('papers');await recommendation().getByRole('link',{name:'打开今日题集',exact:true}).waitFor();

  await recommendation().getByRole('link',{name:'打开今日题集',exact:true}).click();await page.waitForURL(new RegExp(today.paperId));
  for(let i=0;i<30;i++){if((await api('/api/daily-push')).today.readAt)break;await delay(100);}
  assert.ok((await api('/api/daily-push')).today.readAt);const paper=await api('/api/papers/'+today.paperId);assert.equal(paper.scoring.totalPoints,52);assert.equal(paper.scoring.enabled,true);
  assert.equal(paper.title,'2026-10-25 每日推荐');assert.equal(await recommendation().count(),0);
  const duplicate=await api('/api/daily-push/check','POST');assert.equal(duplicate.generated,false);assert.equal(duplicate.record.paperId,today.paperId);
  checks.push('小卡片打开今日题集并标已读，同日不重复生成，题集详情继续使用普通练习考试导出功能');

  await go('');assert.equal(await recommendation().count(),0);await noStandaloneEntry();
  await go('papers');await recommendation().waitFor();await page.getByLabel('显示已归档',{exact:true}).check();
  await page.getByRole('article',{name:'题集：2026-10-24 每日推荐',exact:true}).waitFor();
  checks.push('其他页面不展示推荐卡片，历史推荐通过题集库管理，归档推荐随显示已归档选项查看');

  const compactMobileCard=async()=>{
    const card=await recommendation().boundingBox(),copy=await recommendation().locator('.daily-push-card-copy').boundingBox();
    assert.ok(card&&card.height<=230,'mobile daily card must stay compact instead of stacking each character');
    assert.ok(copy&&copy.width>=200,'mobile daily recommendation text must have a readable line width');
  };
  await page.setViewportSize({width:390,height:844});await go('');await dashboardDaily().getByText('开始今日推荐',{exact:true}).waitFor();
  const quickBounds=await dashboardDaily().boundingBox();assert.ok(quickBounds&&quickBounds.width>=120&&quickBounds.height>=40);
  await capture('dashboard-daily-mobile');checks.push('390px总览快捷入口正常换行，按钮尺寸可点击且页面无溢出');
  await go('papers');await recommendation().waitFor();await compactMobileCard();await capture('recommendation-card-mobile');
  await go('settings?tab=daily');await capture('configuration-mobile');
  await page.getByLabel('开启每日推题',{exact:true}).uncheck();await page.getByRole('button',{name:'保存推题配置',exact:true}).click();await page.getByText('每日推题配置已保存',{exact:true}).waitFor();
  overview=await api('/api/daily-push');assert.equal(overview.config.enabled,false);assert.equal(overview.today.paperId,today.paperId);
  await go('papers');await recommendation().getByRole('link',{name:'打开今日题集',exact:true}).waitFor();await compactMobileCard();await capture('disabled-existing-mobile');
  await page.getByRole('article',{name:'题集：2026-10-25 每日推荐',exact:true}).waitFor();assert.equal((await api('/api/papers/'+today.paperId)).scoring.totalPoints,52);
  checks.push('390px卡片和配置无溢出，关闭自动推题后已生成的题集及分值继续保留');

  await api('/api/exams/sync','POST');await go('papers/'+today.paperId);await page.getByRole('button',{name:'选择练习模式',exact:true}).click();await page.getByRole('menuitem',{name:/考试模式/}).click();const exam=page.getByRole('dialog',{name:'开始限时考试',exact:true});await exam.getByRole('button',{name:'开始考试',exact:true}).click();await page.waitForURL(/#\/attempts\//);
  await page.getByLabel('考试倒计时').waitFor();assert.equal(await recommendation().count(),0);await noStandaloneEntry();
  await page.getByRole('button',{name:'交卷并查看解析',exact:true}).first().click();await page.getByLabel('本次作答时间').waitFor();
  await go('papers');await recommendation().getByRole('link',{name:'打开今日题集',exact:true}).waitFor();checks.push('推荐题集可正常进入考试并交卷，考试作答页没有推荐卡片或全局提醒');
  await api('/api/papers/'+today.paperId,'DELETE');
  const archivedSettings=await api('/api/settings');await api('/api/settings','PUT',{settings:{...archivedSettings,dailyPush:{...archivedSettings.dailyPush,enabled:true}}});await go('');
  const archivedProgress=(await api('/api/daily-push')).today.progress;
  assert.ok(archivedProgress.resultAttemptId,'归档源题集仍可查看保留的提交卷面');
  await dashboardDaily().getByText('查看今日结果',{exact:true}).waitFor();assert.equal(await dashboardDaily().getAttribute('href'),'#/attempts/'+archivedProgress.resultAttemptId);
  await dashboardDaily().click();await page.waitForURL(new RegExp('#/attempts/'+archivedProgress.resultAttemptId+'$'));await page.getByLabel('本次作答时间').waitFor();
  await go('papers');await recommendation().getByText('今日题集已归档或删除，往期推荐可在题集库查找。',{exact:true}).waitFor();assert.equal(await recommendation().locator('a[href="#/papers/'+today.paperId+'"]').count(),0);
  checks.push('今日推荐归档后总览入口可查看保留结果，题集卡片不出现失效的源题集链接');
  assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[]);
  const report={passed:checks.length,checks,errors,externalRequests,isolated:true,databasePath:':memory:',actualDailyScore:52};await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){await page?.screenshot({path:resolve(output,'failure.png'),fullPage:true}).catch(()=>{});console.error({url:page?.url(),checks,stderr});throw error;}
finally{await browser?.close();server.kill();}
