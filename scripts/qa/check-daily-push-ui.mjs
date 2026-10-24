/** Daily notifications and configuration use a disposable in-memory service. */
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
  await go('settings?tab=practice');await page.getByRole('heading',{name:'每题型默认分值',exact:true}).waitFor();
  assert.equal(await page.getByLabel('多选默认分值',{exact:true}).inputValue(),'4');
  let overview=await api('/api/daily-push');assert.equal(overview.config.enabled,false);assert.equal(overview.today,null);
  await api('/api/daily-push/check','POST');assert.equal((await api('/api/daily-push')).today,null);
  checks.push('多选默认4分，未开启每日推题时不生成今天题集');

  await go('settings?tab=daily');await page.getByRole('heading',{name:'每日推题',exact:true}).waitFor();
  assert.equal(await page.getByLabel('复习题目标分值',{exact:true}).inputValue(),'30');assert.equal(await page.getByLabel('新题目标分值',{exact:true}).inputValue(),'20');
  await page.getByLabel('开启每日推题',{exact:true}).check();await page.getByRole('button',{name:'保存推题配置',exact:true}).click();
  assert.equal((await api('/api/settings')).dailyPush.enabled,false,'missing scope must not save');
  await page.getByLabel('推题领域',{exact:true}).selectOption('daily-domain');await page.getByRole('checkbox',{name:'每日测试分类',exact:true}).check();
  await page.getByRole('button',{name:'保存推题配置',exact:true}).click();await page.getByText('每日推题配置已保存',{exact:true}).waitFor();
  await page.getByRole('status',{name:'每日推题提醒',exact:true}).getByText('今日推题已就绪',{exact:true}).waitFor();
  overview=await api('/api/daily-push');const today=overview.today;assert.equal(today.reviewPoints,10);assert.equal(today.newPoints,42);assert.equal(today.totalPoints,52);assert.equal(today.transferredPoints,20);assert.equal(today.shortfall,0);assert.equal(today.questionIds.length,24);assert.ok(today.questionIds.every(id=>id!=='SHORTAGE-ONLY'));
  checks.push('配置必须选择领域分类，父分类覆盖下级；复习10分不足部分补新题42分，总分52允许超额');
  await capture('configured-desktop');

  await go('');const banner=page.getByRole('status',{name:'每日推题提醒',exact:true});await banner.getByRole('link',{name:'打开今日题集',exact:true}).waitFor();
  assert.ok(await page.getByRole('link',{name:/每日推题通知/}).count());
  await banner.getByRole('link',{name:'打开今日题集',exact:true}).click();await page.waitForURL(new RegExp(today.paperId));
  for(let i=0;i<30;i++){if((await api('/api/daily-push')).today.readAt)break;await delay(100);}
  assert.ok((await api('/api/daily-push')).today.readAt);const paper=await api('/api/papers/'+today.paperId);assert.equal(paper.scoring.totalPoints,52);assert.equal(paper.scoring.enabled,true);
  const duplicate=await api('/api/daily-push/check','POST');assert.equal(duplicate.generated,false);assert.equal(duplicate.record.paperId,today.paperId);
  checks.push('总览醒目通知和顶部铃铛可见，打开今日题集即标已读，同日重复检查不重复生成');

  await go('daily-push');await page.getByRole('heading',{name:'最近30次推送',exact:true}).waitFor();
  const shortage=page.locator('.daily-push-record').filter({hasText:'2026-10-24'});await shortage.getByText(/还差 49 分/).waitFor();assert.equal(await shortage.getByRole('link',{name:'打开题集',exact:true}).count(),0);await shortage.getByText('原题集已归档或删除，推送摘要继续保留。',{exact:true}).waitFor();
  await page.getByLabel('每日推题记录每页数量',{exact:true}).selectOption('10');assert.equal(await page.locator('.daily-push-record').count(),2);
  await capture('history-desktop');checks.push('最近推送分页可调整数量，题量不足和归档来源清晰展示且没有失效作答入口');

  await page.setViewportSize({width:390,height:844});await go('settings?tab=daily');await capture('configuration-mobile');
  await page.getByLabel('开启每日推题',{exact:true}).uncheck();await page.getByRole('button',{name:'保存推题配置',exact:true}).click();await page.getByText('每日推题配置已保存',{exact:true}).waitFor();
  overview=await api('/api/daily-push');assert.equal(overview.config.enabled,false);assert.equal(overview.today.paperId,today.paperId);
  await go('daily-push');await page.getByText('每日推题未开启',{exact:true}).waitFor();await capture('history-mobile');
  await page.getByRole('link',{name:/每日推题通知/}).waitFor();assert.equal((await api('/api/papers/'+today.paperId)).scoring.totalPoints,52);
  checks.push('390px配置和记录无溢出，关闭后已有每日题集/分值和通知记录继续保留');

  await api('/api/exams/sync','POST');await go('papers/'+today.paperId);await page.getByRole('button',{name:'选择练习模式',exact:true}).click();await page.getByRole('menuitem',{name:/考试模式/}).click();const exam=page.getByRole('dialog',{name:'开始限时考试',exact:true});await exam.getByRole('button',{name:'开始考试',exact:true}).click();await page.waitForURL(/#\/attempts\//);
  await page.getByLabel('考试倒计时').waitFor();assert.equal(await page.getByRole('status',{name:'每日推题提醒',exact:true}).isVisible(),false);assert.equal(await page.getByRole('link',{name:/每日推题通知/}).isVisible(),false);
  await page.getByRole('button',{name:'交卷并查看解析',exact:true}).first().click();await page.getByLabel('本次作答时间').waitFor();
  await page.getByRole('link',{name:/每日推题通知/}).waitFor();checks.push('考试期间隐藏推题通知和铃铛，交卷后恢复正常入口');
  assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[]);
  const report={passed:checks.length,checks,errors,externalRequests,isolated:true,databasePath:':memory:',actualDailyScore:52};await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){await page?.screenshot({path:resolve(output,'failure.png'),fullPage:true}).catch(()=>{});console.error({url:page?.url(),checks,stderr});throw error;}
finally{await browser?.close();server.kill();}
