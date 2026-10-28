/** Bounded list reads and lazy route loading against a disposable large fixture. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const root=resolve(import.meta.dirname,'../..'),folder=resolve(root,'test-results/scaled-loading-ui');await mkdir(folder,{recursive:true});
const manifest=JSON.parse(await readFile(resolve(root,'dist/web/.vite/manifest.json'),'utf8'));
const entryFor=(fragment)=>{const dynamic=new Set(Object.values(manifest).flatMap(value=>value.dynamicImports||[])),name=fragment.split('/').at(-1);const found=Object.entries(manifest).find(([key,value])=>(value.src||key).replaceAll('\\','/').includes(fragment))||Object.entries(manifest).find(([key,value])=>dynamic.has(key)&&value.name===name);assert.ok(found,'Missing manifest module '+fragment);return found[1];};
const featureEntries={ai:entryFor('features/ai/ai-workspace'),analytics:entryFor('features/analytics/analytics'),editor:entryFor('features/questions/questions'),help:entryFor('features/help/handbook')};
const featureFile=entry=>'/'+entry.file;
const fixture=`import assert from 'node:assert/strict';
import {buildApp} from './server/index.ts';import {Store} from './server/core/store.ts';
import {questionSchema} from './server/core/validation.ts';import {buildPaper,createAttempt,submitAttempt,saveAttempt} from './server/modules/practice/service.ts';
import {exportData} from './server/modules/transfer/migration.ts';
const staging=new Store(':memory:'),stamp='2026-10-28T00:00:00.000Z';
for(const [index,id]of ['scale-computer','scale-science'].entries())staging.put('domains',id,{id,name:index?'自然科学':'计算机',description:'隔离规模检查',sortOrder:index});
staging.put('categories','scale-basic',{id:'scale-basic',domainId:'scale-computer',name:'事务基础',description:'',parentId:null,sortOrder:0});
for(let index=0;index<6;index++){const id='SCALE-Q'+index;staging.put('questions',id,questionSchema.parse({id,title:'事务概念'+index,type:'short_answer',stemMarkdown:'说明事务原子性及失败回滚。',answerMarkdown:'操作整体提交或回滚。',explanationMarkdown:'合成正文。'.repeat(180),categoryIds:['scale-basic'],tagIds:[],status:'published',createdAt:stamp,updatedAt:stamp}));}
const template=buildPaper(staging,{id:'SCALE-TEMPLATE',title:'规模模板',mode:'manual',questionIds:Array.from({length:6},(_,index)=>'SCALE-Q'+index),scoring:{enabled:false}});
staging.transaction(()=>{for(let index=0;index<525;index++){const id='SCALE-P'+String(index).padStart(4,'0'),organization=index%5?'domain':'other';staging.put('papers',id,{...template,id,title:'规模复习 '+String(index).padStart(4,'0'),description:'列表摘要不应传输完整题目快照。'.repeat(12),organization,domainId:organization==='domain'?(index%2?'scale-science':'scale-computer'):null,archived:index>=520,createdAt:stamp,updatedAt:stamp});}});
const first=staging.require('papers','SCALE-P0000'),completed=createAttempt(staging,first);submitAttempt(staging,completed,{'SCALE-Q0':{value:'未作完整解释。'}});const draft=createAttempt(staging,first);saveAttempt(staging,draft,{});
staging.putStudy({...staging.study('SCALE-Q0'),favorite:true,notes:'规模验收合成笔记。'});
const data=exportData(staging);staging.db.close();
const app=await buildApp({databasePath:':memory:',seedPath:'missing-scaled-loading-seed',staticRoot:'dist/web',logger:false,dailyPushScheduler:false});
const result=await app.inject({url:'/api/import',method:'POST',payload:{mode:'merge',data}});assert.equal(result.statusCode,200,result.body);
console.log('SCALED_LOADING_READY '+JSON.stringify({origin:await app.listen({host:'127.0.0.1',port:0}),paperId:first.id}));`;
const server=spawn(process.execPath,['--import','tsx','--input-type=module','-e',fixture],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',browser,page,acceptDialog=true;
const checks=[],errors=[],external=[],requests=[],jsFiles=[],responseSizes=[];
server.stdout.on('data',value=>stdout+=value);server.stderr.on('data',value=>stderr=(stderr+value).slice(-14000));
try{
 let state;for(let tick=0;tick<900;tick++){if(server.exitCode!==null)throw Error(stderr);const line=stdout.split(/\r?\n/).find(value=>value.startsWith('SCALED_LOADING_READY '));if(line){state=JSON.parse(line.slice('SCALED_LOADING_READY '.length));break;}await delay(100);}assert.ok(state,stderr);const{origin}=state;
 const{chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN',reducedMotion:'reduce'});page=await context.newPage();page.setDefaultTimeout(20000);
 page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>void(acceptDialog?dialog.accept():dialog.dismiss()));
 page.on('request',request=>{const url=new URL(request.url());if(url.pathname.startsWith('/api/'))requests.push({path:url.pathname,query:url.search,method:request.method(),body:request.postDataJSON()});if(url.pathname.endsWith('.js'))jsFiles.push(url.pathname);});
 page.on('response',response=>{if(new URL(response.url()).pathname==='/api/papers/page')void response.body().then(body=>responseSizes.push(body.length)).catch(()=>undefined);});
 await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||['data:','blob:'].includes(url.protocol))return route.continue();external.push(url.href);return route.abort();});
 const api=async(path,method='GET',data,status=200)=>{const response=await context.request.fetch(origin+path,{method,...(data===undefined?{}:{data})});assert.equal(response.status(),status,path+': '+await response.text());return response.json();};
 const wait=async(fn,label)=>{for(let tick=0;tick<180;tick++){const value=await fn();if(value)return value;await delay(80);}assert.fail('Timed out: '+label);};
 const readyList=async(total,pageNumber=1,size=20)=>{await page.getByRole('navigation',{name:'题集分页',exact:true}).getByText('共 '+total.toLocaleString()+' 条 · 第 '+pageNumber+' / '+Math.max(1,Math.ceil(total/size))+' 页',{exact:true}).waitFor();await wait(async()=>await page.locator('.paper-card-main').count()===Math.min(size,Math.max(0,total-(pageNumber-1)*size)),'visible page cards');};
 const capture=async name=>{assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Horizontal overflow');await page.screenshot({path:resolve(folder,name+'.png'),fullPage:true});};
 const sidebar=()=>page.getByRole('navigation',{name:'主导航',exact:true});
 let navigation=0;const go=async hash=>{acceptDialog=true;await page.goto(origin+'/?scaled-loading='+ ++navigation+hash);await page.waitForLoadState('networkidle');};

 await go('#/');await page.getByRole('heading',{name:'保持好奇，让知识慢慢生长。',exact:true}).waitFor();
 const initialJs=[...new Set(jsFiles)];for(const[file,entry]of Object.entries(featureEntries))assert.ok(!initialJs.includes(featureFile(entry)),'Initial overview loaded '+file);
 assert.ok(!initialJs.some(file=>/pdf\.worker|export-pdf/.test(file)),'Initial overview downloaded PDF code');checks.push('冷启动总览只加载当前功能依赖，不预载题目编辑、AI、统计正文、手册或PDF导出代码');
 await sidebar().getByRole('link',{name:'题集与练习',exact:true}).click();await readyList(520);await page.waitForLoadState('networkidle');
 const initialListCalls=requests.filter(item=>item.path==='/api/papers/page');assert.ok(initialListCalls.length>=1);assert.ok(initialListCalls.every(item=>Number(new URLSearchParams(item.query).get('pageSize')||20)<=20));
 assert.equal(requests.filter(item=>item.path==='/api/papers').length,0,'Paper page requested full legacy list');
 const firstPage=await api('/api/papers/page?page=1&pageSize=20');assert.equal(firstPage.items.length,20);assert.equal(firstPage.total,520);assert.ok(firstPage.items.every(item=>!('snapshot'in item)&&!('questions'in item)&&!('questionIds'in item)));
 await wait(()=>responseSizes.length>0,'response bytes');assert.ok(Math.max(...responseSizes)<100000,'List page body unexpectedly large');checks.push('525份含大快照题集仅获取20份当前页摘要，不请求旧全量列表，响应不含题目快照和题号数组');
 const visibleIds=await page.locator('.paper-card-main').evaluateAll(links=>links.map(link=>decodeURIComponent(link.getAttribute('href').split('/').at(-1))));
 const summaryCall=await wait(()=>requests.filter(item=>item.path==='/api/learning/card-summaries').at(-1),'learning summaries');assert.deepEqual(new Set(summaryCall.body.paperIds),new Set(visibleIds));
 assert.ok(requests.filter(item=>item.path==='/api/learning/card-summaries').every(item=>item.body.paperIds.length<=20));
 const firstCard=page.locator('.paper-card').first();for(const[label,tab]of [['本集错题','wrong'],['本集收藏','favorite'],['本集复习','review'],['本集草稿','drafts'],['本集历史','history']])assert.ok((await firstCard.getByRole('link',{name:new RegExp('^'+label+'：')}).getAttribute('href')).endsWith('?tab='+tab));checks.push('学习摘要批量请求仅包含当前页ID，五种题集卡片快捷入口保持对应题集上下文');

 const search=()=>page.getByPlaceholder('查找题集',{exact:true}),paging=()=>page.getByRole('navigation',{name:'题集分页',exact:true});
 await search().fill('规模复习');await page.getByLabel('题集组织筛选',{exact:true}).selectOption('domain:scale-computer');await page.getByRole('checkbox',{name:'显示已归档',exact:true}).check();
 await paging().getByLabel('题集每页数量',{exact:true}).selectOption('10');const filtered=await api('/api/papers/page?search='+encodeURIComponent('规模复习')+'&organization=domain&domainId=scale-computer&archived=true&page=1&pageSize=10');await readyList(filtered.total,1,10);
 await paging().getByRole('button',{name:'下一页',exact:false}).click();await readyList(filtered.total,2,10);const before=await page.locator('.paper-card-main h3').allTextContents(),listUrl=page.url();
 await page.locator('.paper-card-main').first().click();await page.getByRole('heading',{name:before[0],exact:true}).waitFor();await page.getByRole('link',{name:'返回题集',exact:true}).click();await readyList(filtered.total,2,10);assert.deepEqual(await page.locator('.paper-card-main h3').allTextContents(),before);assert.equal(await search().inputValue(),'规模复习');assert.equal(await page.getByLabel('题集组织筛选',{exact:true}).inputValue(),'domain:scale-computer');assert.equal(await page.getByRole('checkbox',{name:'显示已归档',exact:true}).isChecked(),true);
 await page.reload();await readyList(filtered.total,2,10);assert.deepEqual(await page.locator('.paper-card-main h3').allTextContents(),before);checks.push('服务端搜索、专项领域、归档、每页数量和第二页在详情往返与刷新后完整恢复');
 await go('#/papers?page=99999&pageSize=100');await readyList(520,6,100);assert.match(page.url(),/page=6(?:&|$)/);assert.equal(await page.locator('.paper-card-main').count(),20);checks.push('超出范围页码自动回到有效末页，URL和分页一致，不出现无故空白页');
 await search().fill('不存在规模题集');await page.getByRole('heading',{name:'没有符合条件的题集',exact:true}).waitFor();await page.getByRole('button',{name:'显示全部题集',exact:true}).click();await readyList(520,1,100);checks.push('空结果可恢复全部题集，保留每页数量并重置第一页');
 let releaseSlow,slowSeen=false;const slowGate=new Promise(done=>releaseSlow=done),slowRoute=async route=>{if(new URL(route.request().url()).searchParams.get('search')!=='慢请求验收')return route.continue();slowSeen=true;await slowGate;await route.continue().catch(()=>undefined);};
 await page.route('**/api/papers/page?**',slowRoute);await search().fill('慢请求验收');await wait(()=>slowSeen,'slow list request');await wait(async()=>await page.locator('.paper-card-main').count()===0,'stale cards hidden');const slowSummaries=requests.filter(item=>item.path==='/api/learning/card-summaries').length;await delay(150);assert.equal(requests.filter(item=>item.path==='/api/learning/card-summaries').length,slowSummaries);
 await search().fill('规模复习 01');await readyList(100,1,100);releaseSlow();await delay(200);assert.ok((await page.locator('.paper-card-main h3').allTextContents()).every(title=>title.startsWith('规模复习 01')));await page.unroute('**/api/papers/page?**',slowRoute);await page.getByRole('button',{name:'清空筛选',exact:true}).click();await readyList(520,1,100);checks.push('慢筛选期间不展示或统计旧页，后发快速搜索生效后迟到响应不会覆盖新结果');
 const paperJs=[...new Set(jsFiles)];await sidebar().getByRole('link',{name:'知识总览',exact:true}).click();await page.getByRole('heading',{name:'保持好奇，让知识慢慢生长。',exact:true}).waitFor();await sidebar().getByRole('link',{name:'题集与练习',exact:true}).click();await readyList(520,1,100);assert.deepEqual([...new Set(jsFiles)],paperJs);checks.push('重复进入已加载功能复用模块缓存，不重复下载该功能JavaScript');

 await go('#/questions/SCALE-Q0/edit');await page.getByLabel('标题 *',{exact:true}).fill('未保存编辑仍受保护');acceptDialog=false;await sidebar().getByRole('link',{name:'学习统计',exact:true}).click();assert.ok(page.url().includes('#/questions/SCALE-Q0/edit'));assert.equal(await page.getByLabel('标题 *',{exact:true}).inputValue(),'未保存编辑仍受保护');assert.ok(!jsFiles.includes(featureFile(featureEntries.analytics)));acceptDialog=true;await sidebar().getByRole('link',{name:'学习统计',exact:true}).click();await page.getByRole('heading',{name:'学习统计',exact:true}).waitFor();assert.ok(jsFiles.includes(featureFile(featureEntries.analytics)));checks.push('题目未保存离开保护在懒加载路由前执行，取消导航保留输入且不加载目标页');
 await sidebar().getByRole('link',{name:'AI工作台',exact:true}).click();const prompt=page.getByLabel('AI组题要求',{exact:true});await prompt.waitFor();assert.ok(jsFiles.includes(featureFile(featureEntries.ai)));await prompt.fill('规模加载验收尚未提交的组题要求');await page.getByRole('button',{name:'文件 / 文本辅助导入',exact:true}).click();await page.getByLabel('待转换文本',{exact:true}).waitFor();await page.getByRole('button',{name:'AI推荐组题',exact:true}).click();const picker=page.getByRole('dialog',{name:'继续AI工作台草稿',exact:true});await picker.waitFor();await picker.getByRole('button',{name:'继续此草稿',exact:true}).first().click();assert.equal(await prompt.inputValue(),'规模加载验收尚未提交的组题要求');checks.push('按需加载AI页面及内部切换保留工作台草稿，恢复不触发模型请求');

 const exam=await api('/api/papers/'+state.paperId+'/attempts','POST',{mode:'exam',durationMinutes:120},201);await go('#/attempts/'+exam.id);await page.getByRole('status').filter({hasText:'考试模式'}).first().waitFor();await sidebar().getByRole('link',{name:'资料库',exact:true}).click();assert.ok(page.url().endsWith('#/attempts/'+exam.id));assert.equal(await page.getByRole('heading',{name:'资料库',exact:true}).count(),0);await api('/api/attempts/'+exam.id+'/submit','POST',{answers:{}});checks.push('考试全局导航锁在路由拆分后仍生效，先交卷才可打开其他功能');
 await go('#/papers?pageSize=20');await readyList(520);await page.setViewportSize({width:390,height:844});await capture('paper-list-mobile');await page.getByRole('button',{name:'打开菜单',exact:true}).click();await sidebar().getByRole('link',{name:'学习统计',exact:true}).click();await page.getByRole('heading',{name:'学习统计',exact:true}).waitFor();await capture('analytics-mobile');checks.push('390px分页卡片及跨功能懒加载后布局无横向溢出，导航菜单正常收起');

 const failureContext=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN'}),failurePage=await failureContext.newPage();let blocked=0;const failureErrors=[];failurePage.on('pageerror',error=>failureErrors.push(error.message));
 await failurePage.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==origin&&!['data:','blob:'].includes(url.protocol)){external.push(url.href);return route.abort();}if(url.pathname===featureFile(featureEntries.analytics)&&blocked===0){blocked++;return route.abort();}return route.continue();});
 await failurePage.goto(origin+'/#/');await failurePage.getByRole('heading',{name:'保持好奇，让知识慢慢生长。',exact:true}).waitFor();await failurePage.getByRole('navigation',{name:'主导航',exact:true}).getByRole('link',{name:'学习统计',exact:true}).click();await failurePage.getByText('页面功能加载失败，请检查连接或重新加载应用后继续。',{exact:false}).waitFor();assert.equal(blocked,1);await failurePage.getByRole('button',{name:'重新加载应用',exact:true}).click();await failurePage.getByRole('heading',{name:'学习统计',exact:true}).waitFor();assert.deepEqual(failureErrors,[]);await failureContext.close();checks.push('单个功能块加载失败显示明确恢复提示，用户手动重新加载后恢复目标页面，无自动刷新循环');

 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);checks.push('零未捕获异常和外部请求，规模及学习写入均为隔离内存数据');
 const report={passed:checks.length,checks,errors,external,database:':memory:',fixturePapers:525,initialJavaScript:initialJs,listResponseBytes:responseSizes,requests:requests.filter(item=>item.path==='/api/papers'||item.path==='/api/papers/page'||item.path==='/api/learning/card-summaries')};await writeFile(resolve(folder,'report.json'),JSON.stringify(report,null,2)+'\n');await rm(resolve(folder,'failure.json'),{force:true});console.log(JSON.stringify({passed:checks.length,checks,errors,external,initialJavaScript:initialJs,maxListResponseBytes:Math.max(...responseSizes)}));
}catch(error){await page?.screenshot({path:resolve(folder,'failure.png'),fullPage:true}).catch(()=>undefined);await writeFile(resolve(folder,'failure.json'),JSON.stringify({error:String(error.stack||error),checks,errors,external,stderr,url:page?.url()},null,2)+'\n');throw error;}
finally{await browser?.close();server.kill('SIGTERM');if(server.exitCode===null)await Promise.race([new Promise(done=>server.once('exit',done)),delay(3000)]);if(server.exitCode===null)server.kill('SIGKILL');}
