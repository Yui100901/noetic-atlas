/** Query changes use one current request; all writes stay inside a disposable fixture. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const root=resolve(import.meta.dirname,'../..'),output=resolve(root,'test-results/query-experience-ui');
await mkdir(output,{recursive:true});
const fixture=`import assert from 'node:assert/strict';
import {buildApp} from './server/index.ts';import {Store} from './server/core/store.ts';
import {questionSchema,documentSchema} from './server/core/validation.ts';import {exportData} from './server/modules/transfer/migration.ts';
const staging=new Store(':memory:'),stamp='2026-10-29T00:00:00.000Z';
for(let index=1;index<=2;index++){staging.put('domains','ux-domain'+index,{id:'ux-domain'+index,name:'领域'+index,description:'隔离查询验收',sortOrder:index});staging.put('categories','ux-category'+index,{id:'ux-category'+index,domainId:'ux-domain'+index,name:'分类'+index,description:'',parentId:null,sortOrder:index});}
staging.transaction(()=>{for(let index=0;index<75;index++){const suffix=String(index).padStart(3,'0'),domain=1+index%2;const title=(index<40?'命中':'概念')+' 知识 '+suffix;
const question=questionSchema.parse({id:'UX-Q'+suffix,title,type:'true_false',stemMarkdown:'这是查询体验隔离验收题干。',correctAnswers:['true'],categoryIds:['ux-category'+domain],tagIds:[],status:'published',createdAt:stamp,updatedAt:stamp});staging.put('questions',question.id,question);
const document=documentSchema.parse({id:'UX-D'+suffix,title:(index<40?'命中':'概念')+' 资料 '+suffix,kind:'书籍',bodyMarkdown:'# 正文摘要'+String.fromCharCode(10)+'只在详情读取的正文。'.repeat(1500),domainIds:['ux-domain'+domain],categoryIds:['ux-category'+domain],tagIds:[],collection:'general',format:'markdown',author:'验收作者',updatedAt:stamp});staging.put('documents',document.id,document);
}});
const data=exportData(staging);staging.db.close();
const app=await buildApp({databasePath:':memory:',seedPath:'missing-query-ui-seed',staticRoot:'dist/web',dailyPushScheduler:false,logger:false});
const imported=await app.inject({url:'/api/import',method:'POST',payload:{mode:'merge',data}});assert.equal(imported.statusCode,200,imported.body);
console.log('QUERY_UI_READY '+JSON.stringify({origin:await app.listen({host:'127.0.0.1',port:0})}));`;
const server=spawn(process.execPath,['--import','tsx','--input-type=module','-e',fixture],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='',browser,page;server.stdout.on('data',value=>stdout+=value);server.stderr.on('data',value=>stderr=(stderr+value).slice(-16000));
const checks=[],errors=[],external=[],requests=[];
try{
 let state;for(let tick=0;tick<600;tick++){if(server.exitCode!==null)throw Error(stderr);const line=stdout.split(/\r?\n/).find(value=>value.startsWith('QUERY_UI_READY '));if(line){state=JSON.parse(line.slice('QUERY_UI_READY '.length));break;}await delay(100);}assert.ok(state,stderr);const{origin}=state;
 const{chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN',reducedMotion:'reduce'});page=await context.newPage();page.setDefaultTimeout(18000);page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>void dialog.accept());
 page.on('request',request=>{const url=new URL(request.url());if(url.pathname.startsWith('/api/'))requests.push({path:url.pathname,query:Object.fromEntries(url.searchParams),method:request.method(),...(request.method()==='POST'?{body:request.postDataJSON()}:{} )});});
 await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||['data:','blob:'].includes(url.protocol))return route.continue();external.push(url.href);return route.abort();});
 const wait=async(fn,label)=>{for(let tick=0;tick<180;tick++){if(await fn())return;await delay(70);}assert.fail('Timed out: '+label);};
 let navigation=0;const go=async hash=>{requests.length=0;await page.goto(origin+'/?query-ui='+ ++navigation+hash);await page.waitForLoadState('networkidle');};
 const calls=path=>requests.filter(item=>item.path===path);
 const search=()=>page.locator('.filters-panel input[type=search]');
 const questionReady=async(total,pageNumber=1,size=20)=>{await page.getByText('找到 '+total+' 道题目',{exact:true}).waitFor();await wait(async()=>await page.locator('.question-row').count()===Math.min(size,Math.max(0,total-(pageNumber-1)*size)),'question rows');await page.getByRole('navigation',{name:'列表分页',exact:true}).getByText('共 '+total+' 条 · 第 '+pageNumber+' / '+Math.max(1,Math.ceil(total/size))+' 页',{exact:true}).waitFor();await page.waitForLoadState('networkidle');};
 const documentReady=async(total,pageNumber=1,size=20)=>{await page.getByText('共 '+total+' 份资料',{exact:true}).waitFor();await wait(async()=>await page.locator('.document-card').count()===Math.min(size,Math.max(0,total-(pageNumber-1)*size)),'document cards');await page.getByRole('navigation',{name:'资料库分页',exact:true}).getByText('共 '+total+' 条 · 第 '+pageNumber+' / '+Math.max(1,Math.ceil(total/size))+' 页',{exact:true}).waitFor();await page.waitForLoadState('networkidle');};
 const capture=async name=>{assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'horizontal overflow');await page.screenshot({path:resolve(output,name+'.png'),fullPage:true});};

 await go('#/questions?page=2');await questionReady(75,2);assert.equal(calls('/api/daily-push').length,1);checks.push('冷启动只请求一次每日推荐总览，取消重复的初始刷新');
 requests.length=0;await search().fill('命中');await delay(100);assert.equal(calls('/api/questions').length,0);assert.equal(await page.locator('.question-row').count(),0);await questionReady(40);assert.equal(calls('/api/questions').length,1);assert.equal(calls('/api/questions')[0].query.search,'命中');assert.equal(calls('/api/questions')[0].query.page,'1');checks.push('题库第二页输入关键词只发送防抖后的第一页请求，等待时隐藏旧行及旧数量');
 await page.getByRole('navigation',{name:'列表分页',exact:true}).getByRole('button',{name:'下一页',exact:false}).click();await questionReady(40,2);requests.length=0;
 await page.getByLabel('知识领域',{exact:true}).selectOption('ux-domain2');await questionReady(20);assert.equal(calls('/api/questions').length,1);assert.equal(calls('/api/questions')[0].query.page,'1');assert.equal(calls('/api/questions')[0].query.domainId,'ux-domain2');checks.push('题库领域筛选立即生效并同批重置页码，无旧条件或旧页请求');

 let releaseSlow,slowSeen=false;const slowGate=new Promise(done=>releaseSlow=done);const slowRoute=async route=>{if(new URL(route.request().url()).searchParams.get('search')!=='慢查询')return route.continue();slowSeen=true;await slowGate;await route.continue().catch(()=>undefined);};
 await page.route('**/api/questions?**',slowRoute);await search().fill('慢查询');await wait(()=>slowSeen,'slow question request');assert.equal(await page.locator('.question-row').count(),0);const feedback=calls('/api/question-feedback/summaries').length;await delay(150);assert.equal(calls('/api/question-feedback/summaries').length,feedback);
 await search().fill('命中');await questionReady(20);releaseSlow();await delay(200);await questionReady(20);await page.unroute('**/api/questions?**',slowRoute);checks.push('慢查询不沿用旧页反馈摘要，后发结果生效后迟到响应不会覆盖');
 await go('#/questions?page=99999');await questionReady(75,4);assert.match(page.url(),/page=4(?:&|$)/);checks.push('题库越界页自动回到有效末页，分页入口持续可用');
 await search().fill('完全不存在的题目');await questionReady(0);await page.getByRole('navigation',{name:'列表分页',exact:true}).getByLabel('列表每页数量',{exact:true}).selectOption('10');await questionReady(0,1,10);checks.push('题库零结果仍可调整每页数量，空筛选可恢复');

 await go('#/documents?page=2');await documentReady(75,2);assert.equal(calls('/api/documents').length,0);assert.equal(calls('/api/documents/page').length,1);checks.push('资料库使用分页摘要接口，不读取完整资料列表和正文');
 requests.length=0;await search().fill('命中');await delay(100);assert.equal(calls('/api/documents/page').length,0);assert.equal(await page.locator('.document-card').count(),0);await documentReady(40);assert.equal(calls('/api/documents/page').length,1);assert.equal(calls('/api/documents/page')[0].query.page,'1');checks.push('资料库从第二页搜索只发送防抖后的第一页请求，旧卡片及旧计数不混入新筛选');
 await page.getByRole('navigation',{name:'资料库分页',exact:true}).getByRole('button',{name:'下一页',exact:false}).click();await documentReady(40,2);requests.length=0;await page.getByLabel('资料领域',{exact:true}).selectOption('ux-domain2');await documentReady(20);assert.equal(calls('/api/documents/page').length,1);assert.equal(calls('/api/documents/page')[0].query.page,'1');assert.equal(calls('/api/documents/page')[0].query.domainId,'ux-domain2');checks.push('资料库领域和页码一起更新，不先查新领域的旧页');
 const before=await page.locator('.document-card h3').allTextContents();await page.locator('.document-card').first().click();await page.getByRole('link',{name:'返回资料库',exact:true}).click();await documentReady(20);assert.equal(await search().inputValue(),'命中');assert.equal(await page.getByLabel('资料领域',{exact:true}).inputValue(),'ux-domain2');assert.deepEqual(await page.locator('.document-card h3').allTextContents(),before);checks.push('资料详情往返保留关键词、领域和分页上下文');
 await go('#/documents?page=99999');await documentReady(75,4);assert.match(page.url(),/page=4(?:&|$)/);await search().fill('完全不存在的资料');await documentReady(0);assert.equal(await page.getByRole('navigation',{name:'资料库分页',exact:true}).count(),1);checks.push('资料库越界页回有效末页，零结果保留分页和每页数量入口');

 await go('#/search?q='+encodeURIComponent('知识')+'&type=question&sort=updatedAt&includeUnpublished=true&page=2&pageSize=10');await page.getByRole('navigation',{name:'搜索结果分页',exact:true}).getByText('共 75 条 · 第 2 / 8 页',{exact:true}).waitFor();
 const topSearch=page.getByRole('search',{name:'全站统一搜索',exact:true});await topSearch.getByRole('searchbox',{name:'全站搜索',exact:true}).fill('命中');await topSearch.getByRole('button',{name:'执行统一搜索',exact:true}).click();await page.getByRole('navigation',{name:'搜索结果分页',exact:true}).getByText('共 40 条 · 第 1 / 4 页',{exact:true}).waitFor();
 const params=new URLSearchParams(page.url().split('#/search?')[1]);assert.equal(params.get('type'),'question');assert.equal(params.get('sort'),'updatedAt');assert.equal(params.get('includeUnpublished'),'true');assert.equal(params.get('pageSize'),'10');assert.equal(params.get('page'),null);assert.equal(await page.getByLabel('搜索关键词',{exact:true}).inputValue(),'命中');checks.push('顶部统一搜索保留当前结果类型、排序、未发布开关和每页数量，仅重置页码');
 await capture('search-desktop');await page.setViewportSize({width:390,height:844});await capture('search-mobile');await go('#/documents?pageSize=10');await documentReady(75,1,10);await capture('documents-mobile');checks.push('390px 搜索和资料分页布局无横向溢出');
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);checks.push('零未捕获异常、零外部请求，数据全为隔离内存样例');
 await writeFile(resolve(output,'report.json'),JSON.stringify({passed:checks.length,checks,errors,external,database:':memory:'},null,2)+'\n');await rm(resolve(output,'failure.json'),{force:true});console.log(JSON.stringify({passed:checks.length,checks,errors,external}));
}catch(error){await page?.screenshot({path:resolve(output,'failure.png'),fullPage:true}).catch(()=>undefined);await writeFile(resolve(output,'failure.json'),JSON.stringify({error:String(error.stack||error),checks,errors,external,stderr,url:page?.url()},null,2)+'\n');throw error;}
finally{await browser?.close();server.kill('SIGTERM');if(server.exitCode===null)await Promise.race([new Promise(done=>server.once('exit',done)),delay(3000)]);if(server.exitCode===null)server.kill('SIGKILL');}
