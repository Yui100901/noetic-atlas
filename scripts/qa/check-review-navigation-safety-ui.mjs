/** Selection, local tab URLs and dirty modal closure; disposable production app. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const root=resolve(import.meta.dirname,'../..'),output=resolve(root,'test-results/review-navigation-safety-ui');
await mkdir(output,{recursive:true});
const fixture=`import assert from 'node:assert/strict';import {buildApp} from './server/index.ts';
const app=await buildApp({databasePath:':memory:',seedPath:'missing-review-navigation-seed',staticRoot:'dist/web',dailyPushScheduler:false,logger:false});
const api=async(url,method='GET',payload)=>{const response=await app.inject({url,method,...(payload===undefined?{}:{payload})});assert.ok(response.statusCode<400,url+': '+response.body);return response.json();};
const questions=Array.from({length:105},(_,index)=>({id:'SAFE-Q'+String(index).padStart(3,'0'),title:'审核与页签 '+String(index).padStart(3,'0'),type:'true_false',stemMarkdown:'事务整体提交或回滚。',correctAnswers:['true'],status:index<75?'pending':'published',categoryIds:['safe-category'+(1+index%2)],tagIds:[]}));
await api('/api/import','POST',{mode:'merge',data:{schemaVersion:1,domains:[1,2].map(index=>({id:'safe-domain'+index,name:'领域'+index,description:'',sortOrder:index})),categories:[1,2].map(index=>({id:'safe-category'+index,name:'分类'+index,domainId:'safe-domain'+index,parentId:null,description:'',sortOrder:index})),tags:[],questions,documents:[],papers:[]}});
const paper=await api('/api/papers','POST',{title:'页签上下文验证',mode:'manual',questionIds:questions.slice(75).map(question=>question.id),scoring:{enabled:false}});
console.log('REVIEW_SAFETY_READY '+JSON.stringify({origin:await app.listen({host:'127.0.0.1',port:0}),paperId:paper.id}));`;
const server=spawn(process.execPath,['--import','tsx','--input-type=module','-e',fixture],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='',browser,page;server.stdout.on('data',data=>stdout+=data);server.stderr.on('data',data=>stderr=(stderr+data).slice(-16000));
const checks=[],errors=[],external=[],requests=[],dialogs=[];
let confirmAction='accept';
try{
  let state;for(let tick=0;tick<600;tick++){if(server.exitCode!==null)throw Error(stderr);const line=stdout.split(/\r?\n/).find(value=>value.startsWith('REVIEW_SAFETY_READY '));if(line){state=JSON.parse(line.slice('REVIEW_SAFETY_READY '.length));break;}await delay(100);}assert.ok(state,stderr);const {origin,paperId}=state;
  const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');
  browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true});
  page=await browser.newPage({viewport:{width:1440,height:1000},locale:'zh-CN',reducedMotion:'reduce'});page.setDefaultTimeout(18000);
  page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>{dialogs.push(dialog.message());void (confirmAction==='dismiss'?dialog.dismiss():dialog.accept());});
  page.on('request',request=>{const url=new URL(request.url());if(url.pathname.startsWith('/api/'))requests.push({path:url.pathname,params:Object.fromEntries(url.searchParams),method:request.method()});});
  await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||['data:','blob:'].includes(url.protocol))return route.continue();external.push(url.href);return route.abort();});
  const wait=async(predicate,label)=>{for(let tick=0;tick<250;tick++){if(await predicate())return;await delay(40);}assert.fail('Timed out: '+label);};
  const go=async hash=>{await page.goto(origin+'/'+hash);};
  const reviewReady=async total=>{await page.getByText(total+' 道待审核题目',{exact:true}).waitFor();await wait(async()=>await page.locator('.review-item').count()===Math.min(total,20),'review page rows');};
  const all=()=>page.getByRole('button',{name:'全选本页',exact:true}),approve=()=>page.getByRole('button',{name:'确认批量通过',exact:true});
  const scope=()=>page.getByLabel('审核选择范围',{exact:true});
  const pendingCalls=()=>requests.filter(request=>request.path==='/api/questions'&&request.params.status==='pending');

  await go('#/questions/review');await reviewReady(75);await all().click();await page.getByText('已选择 20 题',{exact:true}).waitFor();
  let releaseDomain,domainSeen=false;const domainGate=new Promise(done=>releaseDomain=done);
  const slowDomain=async route=>{if(new URL(route.request().url()).searchParams.get('domainId')!=='safe-domain2')return route.continue();domainSeen=true;await domainGate;return route.continue().catch(()=>{});};
  await page.route('**/api/questions?**',slowDomain);await page.getByLabel('审核题目领域',{exact:true}).selectOption('safe-domain2');await wait(()=>domainSeen,'domain request');
  assert.equal(await all().isDisabled(),true);assert.equal(await approve().isDisabled(),true);assert.equal(await page.locator('.review-item').count(),0);await page.getByText('已选择 0 题',{exact:true}).waitFor();
  releaseDomain();await reviewReady(37);await page.unroute('**/api/questions?**',slowDomain);await all().click();
  let posted;const interceptReview=async route=>{posted=route.request().postDataJSON();return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:{code:'QA_NO_PUBLISH',message:'验收拦截，不实际发布'}})});};
  await page.route('**/api/questions/review',interceptReview);await approve().click();await page.getByText('验收拦截，不实际发布',{exact:true}).waitFor();
  assert.equal(posted.ids.length,20);assert.ok(posted.ids.every(id=>Number(id.replace('SAFE-Q',''))%2===1));assert.match(dialogs.at(-1),/领域：领域2/);await page.unroute('**/api/questions/review',interceptReview);
  checks.push('切换领域的加载期间清空旧行、禁选和禁批量；完成后审核请求只含当前领域，确认包含范围');

  await page.getByRole('navigation',{name:'列表分页',exact:true}).getByRole('button',{name:/下一页/}).click();
  await wait(async()=>await page.locator('.review-item').count()===17,'second domain page');await all().click();await page.getByText('已选择 37 题',{exact:true}).waitFor();assert.match(await scope().innerText(),/本页已选 17 题，其他页已选 20 题/);
  await page.getByText('查看已选题目（37题）',{exact:true}).click();assert.equal(await page.locator('.review-batch details li').count(),37);
  checks.push('同一筛选跨页选择保留，并可核对本页/其他页数量和完整题号清单');

  requests.length=0;await page.getByPlaceholder('搜索待审核题目',{exact:true}).fill('审核与页签 001');await delay(100);assert.equal(pendingCalls().length,0);assert.equal(await all().isDisabled(),true);await reviewReady(1);assert.equal(pendingCalls().length,1);assert.equal(pendingCalls()[0].params.page,'1');await page.getByText('已选择 0 题',{exact:true}).waitFor();
  checks.push('修改关键词立即清选择，防抖期间不查旧关键词第一页，仅发一次目标请求');

  let releaseSearch,searchSeen=false;const searchGate=new Promise(done=>releaseSearch=done);
  const slowSearch=async route=>{if(new URL(route.request().url()).searchParams.get('search')!=='慢请求')return route.continue();searchSeen=true;await searchGate;return route.continue().catch(()=>{});};
  await page.route('**/api/questions?**',slowSearch);await page.getByPlaceholder('搜索待审核题目',{exact:true}).fill('慢请求');await wait(()=>searchSeen,'slow search');await page.getByPlaceholder('搜索待审核题目',{exact:true}).fill('审核与页签 003');await reviewReady(1);releaseSearch();await delay(200);assert.match(await page.locator('.review-item h2').innerText(),/003/);await page.unroute('**/api/questions?**',slowSearch);
  checks.push('迟到的旧审核搜索响应不会替换当前题目或选择目标');

  const failed=async route=>{if(new URL(route.request().url()).searchParams.get('search')!=='失败查询')return route.continue();return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:{code:'QA_FAILED',message:'模拟查询失败'}})});};
  await page.route('**/api/questions?**',failed);await page.getByPlaceholder('搜索待审核题目',{exact:true}).fill('失败查询');await page.getByText('模拟查询失败',{exact:true}).waitFor();assert.equal(await all().isDisabled(),true);assert.equal(await approve().isDisabled(),true);assert.equal(await page.locator('.review-item').count(),0);await page.unroute('**/api/questions?**',failed);
  await go('#/questions/review?page=999');await page.getByRole('navigation',{name:'列表分页',exact:true}).getByText('共 75 条 · 第 4 / 4 页',{exact:true}).waitFor();assert.match(page.url(),/page=4/);
  checks.push('查询失败没有残留可选旧行，审核越界分页恢复到有效末页');

  await go('#/papers/'+paperId+'?tab=content&contentsSearch='+encodeURIComponent('审核')+'&contentsPage=2&contentsPageSize=10');
  await page.getByRole('navigation',{name:'题集题目分页',exact:true}).getByText('共 30 条 · 第 2 / 3 页',{exact:true}).waitFor();const before=await page.locator('.question-set-question-title').allTextContents();
  const tabs=page.getByRole('tablist',{name:'题集学习内容',exact:true});await tabs.getByRole('tab',{name:'历史答题',exact:true}).click();await page.getByRole('heading',{name:'历史答题',exact:true}).waitFor();assert.match(page.url(),/tab=history/);
  await tabs.getByRole('tab',{name:'题集内容',exact:true}).click();assert.match(page.url(),/tab=content/);assert.match(page.url(),/contentsPage=2/);assert.equal(await page.getByPlaceholder('在本题集中查找标题或题号',{exact:true}).inputValue(),'审核');assert.deepEqual(await page.locator('.question-set-question-title').allTextContents(),before);
  await page.reload();await page.getByRole('tab',{name:'题集内容',exact:true}).waitFor();assert.equal(await page.getByRole('tab',{name:'题集内容',exact:true}).getAttribute('aria-selected'),'true');await page.getByRole('navigation',{name:'题集题目分页',exact:true}).getByText('共 30 条 · 第 2 / 3 页',{exact:true}).waitFor();
  checks.push('历史切回题集内容同步URL，搜索与第二页不重置；刷新仍是同一内容页');
  await page.getByLabel(/^查看题目：/).first().click();await page.getByRole('link',{name:/^返回题集(?:\s|$)/}).click();await page.getByRole('navigation',{name:'题集题目分页',exact:true}).getByText('共 30 条 · 第 2 / 3 页',{exact:true}).waitFor();
  checks.push('页签切回后进入独立看题，再返回仍恢复原内容分页和关键词');

  await go('#/taxonomy');const create=()=>page.getByRole('button',{name:'新增领域',exact:true});await create().click();let dialog=page.getByRole('dialog',{name:'新增领域',exact:true});let count=dialogs.length;await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),0);assert.equal(dialogs.length,count);
  await create().click();dialog=page.getByRole('dialog',{name:'新增领域',exact:true});await dialog.getByLabel('名称 *',{exact:true}).fill('保留未保存名称');confirmAction='dismiss';
  for(const action of [()=>page.keyboard.press('Escape'),()=>page.mouse.click(4,4),()=>dialog.getByRole('button',{name:'取消',exact:true}).click(),()=>dialog.getByRole('button',{name:'关闭',exact:true}).click()]){count=dialogs.length;await action();assert.equal(dialogs.length,count+1);assert.equal(await dialog.isVisible(),true);assert.equal(await dialog.getByLabel('名称 *',{exact:true}).inputValue(),'保留未保存名称');}
  confirmAction='accept';await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),0);
  checks.push('未修改弹窗直接关闭；已修改后Esc、遮罩、取消、关闭均可拒绝丢弃并保留内容');

  await create().click();dialog=page.getByRole('dialog',{name:'新增领域',exact:true});await dialog.getByLabel('名称 *',{exact:true}).fill('导航前未保存');confirmAction='dismiss';
  const oldUrl=page.url();await page.evaluate(()=>{location.hash='#/papers';});await delay(100);assert.equal(page.url(),oldUrl);assert.equal(await dialog.getByLabel('名称 *',{exact:true}).inputValue(),'导航前未保存');
  confirmAction='accept';await dialog.getByRole('button',{name:'取消',exact:true}).click();
  checks.push('编辑弹窗发生程序导航时也可拒绝离开，地址与输入保持不变');

  await create().click();dialog=page.getByRole('dialog',{name:'新增领域',exact:true});await dialog.getByLabel('名称 *',{exact:true}).fill('保存失败也保留');
  const failSave=async route=>route.request().method()==='POST'?route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:{code:'QA_SAVE_FAIL',message:'模拟保存失败'}})}):route.continue();
  await page.route('**/api/domains',failSave);await dialog.getByRole('button',{name:'保存',exact:true}).click();await dialog.getByText('模拟保存失败',{exact:true}).waitFor();confirmAction='dismiss';await page.keyboard.press('Escape');assert.equal(await dialog.getByLabel('名称 *',{exact:true}).inputValue(),'保存失败也保留');await page.unroute('**/api/domains',failSave);
  checks.push('领域保存失败保留输入和dirty状态，关闭仍询问而不丢失');

  let releaseSave,saveSeen=false;const saveGate=new Promise(done=>releaseSave=done);
  const slowSave=async route=>{if(route.request().method()!=='POST')return route.continue();saveSeen=true;await saveGate;return route.continue();};
  await page.route('**/api/domains',slowSave);confirmAction='accept';await dialog.getByRole('button',{name:'保存',exact:true}).click();await wait(()=>saveSeen,'domain saving');assert.equal(await dialog.getByLabel('名称 *',{exact:true}).isDisabled(),true);count=dialogs.length;await page.keyboard.press('Escape');await dialog.getByRole('button',{name:'关闭',exact:true}).click();assert.equal(await dialog.isVisible(),true);assert.equal(dialogs.length,count);releaseSave();await wait(async()=>await page.getByRole('dialog').count()===0,'domain saved');await page.unroute('**/api/domains',slowSave);
  checks.push('保存期间禁止修改或误关，成功关闭不触发丢弃提示');

  await page.getByRole('button',{name:'新增一级分类',exact:true}).click();dialog=page.getByRole('dialog',{name:'新增分类',exact:true});await dialog.getByLabel('名称 *',{exact:true}).fill('未保存分类');await dialog.getByLabel('所属领域',{exact:true}).selectOption('safe-domain2');confirmAction='dismiss';await page.keyboard.press('Escape');assert.equal(await dialog.getByLabel('名称 *',{exact:true}).inputValue(),'未保存分类');assert.equal(await dialog.getByLabel('所属领域',{exact:true}).inputValue(),'safe-domain2');confirmAction='accept';await dialog.getByRole('button',{name:'取消',exact:true}).click();
  await page.getByRole('button',{name:/领域与通用标签/}).click();await page.getByRole('button',{name:'新增标签',exact:true}).click();dialog=page.getByRole('dialog',{name:'新增标签',exact:true});await dialog.getByLabel('名称 *',{exact:true}).fill('临时标签');await dialog.getByLabel('说明',{exact:true}).fill('临时说明');confirmAction='dismiss';await page.keyboard.press('Escape');assert.equal(await dialog.isVisible(),true);await dialog.getByLabel('名称 *',{exact:true}).fill('');await dialog.getByLabel('说明',{exact:true}).fill('');count=dialogs.length;await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),0);assert.equal(dialogs.length,count);confirmAction='accept';
  checks.push('分类归属变更与标签输入同样受保护，恢复为原内容后不再多问');

  await page.setViewportSize({width:390,height:844});await go('#/questions/review?domainId=safe-domain2');await reviewReady(37);await all().click();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:resolve(output,'review-selection-mobile.png'),fullPage:false});
  checks.push('390px审核范围与操作区无横向溢出');
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);checks.push('零浏览器异常或外部请求，所有数据为隔离内存样例');
  const report={passed:checks.length,checks,errors,external,isolated:true,database:':memory:'};await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2)+'\n');await rm(resolve(output,'failure.json'),{force:true});console.log(JSON.stringify(report));
}catch(error){await page?.screenshot({path:resolve(output,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(resolve(output,'failure.json'),JSON.stringify({error:String(error.stack||error),checks,errors,external,stderr,url:page?.url()},null,2));throw error;}
finally{await browser?.close();server.kill('SIGTERM');if(server.exitCode===null)await Promise.race([new Promise(done=>server.once('exit',done)),delay(3000)]);if(server.exitCode===null)server.kill('SIGKILL');}
