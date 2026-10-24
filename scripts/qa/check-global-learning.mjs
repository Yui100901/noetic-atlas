/** Fixed aggregate sets and card shortcuts, isolated from all working data. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const code=`import {buildApp} from './server/index.ts';
const app=await buildApp({databasePath:':memory:',seedPath:'no-global-learning-qa',staticRoot:'dist/web'});
const call=async(method,url,payload)=>{const response=await app.inject({method,url,...(payload===undefined?{}:{payload})});if(response.statusCode>=400)throw Error(response.body);return response.json();};
const extra=Array.from({length:25},(_,index)=>({id:'G-PAGE-'+index,title:'分页错误'+index,type:'true_false',stemMarkdown:'分页材料 '+index,correctAnswers:['true'],status:'published'}));
await call('POST','/api/import',{mode:'merge',data:{schemaVersion:1,domains:[],categories:[],tags:[],documents:[],papers:[],questions:[{id:'G-SHARED',title:'共享题的原始快照',type:'true_false',stemMarkdown:'题集保存的旧题干',correctAnswers:['true'],answerMarkdown:'题集保存的旧答案',status:'published'},{id:'G-LIB',title:'仅在知识题库收藏的题目',type:'short_answer',stemMarkdown:'从未加入题集的题目',answerMarkdown:'知识题库原始答案',status:'published'},...extra]}});
const makeSet=(title,questionIds)=>call('POST','/api/papers',{title,mode:'manual',questionIds,scoring:{enabled:false}});
const a=await makeSet('快捷入口甲',['G-SHARED',...extra.map(question=>question.id)]),b=await makeSet('快捷入口乙',['G-SHARED']),c=await makeSet('已经删除的来源',['G-SHARED']),d=await makeSet('已经答对的来源',['G-SHARED']);
const submit=async(paper,answers)=>{const attempt=await call('POST','/api/papers/'+paper.id+'/attempts');return call('POST','/api/attempts/'+attempt.id+'/submit',{answers});};
const wrongA=await submit(a,Object.fromEntries(a.questionIds.map(id=>[id,{value:'false'}]))),wrongB=await submit(b,{'G-SHARED':{value:'false'}}),wrongC=await submit(c,{'G-SHARED':{value:'false'}});await submit(d,{'G-SHARED':{value:'true'}});await call('DELETE','/api/papers/'+c.id+'?permanent=true');
const draftA=await call('POST','/api/papers/'+a.id+'/attempts');
const quick=await call('POST','/api/quick-practice',{questionId:'G-SHARED'});await call('POST','/api/attempts/'+quick.id+'/submit',{answers:{'G-SHARED':{value:'false'}}});
for(const id of ['G-SHARED','G-LIB'])await call('PUT','/api/study/'+id,{favorite:true,nextReviewAt:'2000-01-01T00:00:00.000Z',notes:'已有笔记'});
const original=await call('GET','/api/questions/G-SHARED');await call('PUT','/api/questions/G-SHARED',{...original,title:'当前共享原题',stemMarkdown:'当前原题的新题干',answerMarkdown:'当前原题的新答案'});
await app.listen({host:'127.0.0.1',port:0});console.log('GLOBAL_LEARNING_READY '+JSON.stringify({origin:'http://127.0.0.1:'+app.server.address().port,a:a.id,b:b.id,c:c.id,d:d.id,wrongA:wrongA.id,wrongB:wrongB.id,wrongC:wrongC.id,draftA:draftA.id,quick:quick.id}));`;
const server=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='',browser,page;server.stdout.on('data',value=>stdout+=value);server.stderr.on('data',value=>stderr+=value);
const output='test-results/global-learning-ui';await mkdir(output,{recursive:true});
const checks=[],errors=[],cardRequests=[],individualSummaryRequests=[];
try{
  let state;
  for(let i=0;i<300;i++){if(server.exitCode!==null)throw Error(stderr);const line=stdout.split(/\r?\n/).find(value=>value.startsWith('GLOBAL_LEARNING_READY '));if(line){state=JSON.parse(line.slice('GLOBAL_LEARNING_READY '.length));break;}await new Promise(done=>setTimeout(done,100));}
  assert.ok(state,stderr);const {origin}=state;
  browser=await chromium.launch({channel:'msedge',headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(20000);
  page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>void dialog.accept());page.on('request',request=>{const url=new URL(request.url());if(url.pathname==='/api/learning/card-summaries')cardRequests.push(request.postDataJSON());if(url.pathname==='/api/learning/summary')individualSummaryRequests.push(request.url());});
  const api=async(path,method='GET',data)=>{const response=await page.request.fetch(origin+path,{method,...(data===undefined?{}:{data})});assert.ok(response.ok(),await response.text());return response.json();};
  const checkShortcutRow=async(card)=>{
    const links=card.locator('.paper-card-shortcuts > a');assert.equal(await links.count(),5);
    const boxes=await links.evaluateAll(items=>items.map(item=>{const {top,left,right,width,height}=item.getBoundingClientRect();return {top,left,right,width,height};}));
    assert.ok(boxes.every(box=>box.width>0&&box.height>0),'all five shortcuts must remain visible');
    assert.ok(Math.max(...boxes.map(box=>box.top))-Math.min(...boxes.map(box=>box.top))<=1,'all five shortcuts must share one row');
    const bounds=await card.boundingBox();assert.ok(bounds);assert.ok(boxes.every(box=>box.left>=bounds.x-1&&box.right<=bounds.x+bounds.width+1),'shortcuts must stay within the card');
    assert.equal(await card.locator('a a').count(),0);
  };
  await page.goto(origin+'/#/papers');await page.locator('article.paper-card').filter({hasText:'快捷入口甲'}).waitFor();
  const aCard=page.locator('article.paper-card').filter({hasText:'快捷入口甲'});
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('article.paper-card a')).some(link=>link.getAttribute('aria-label')?.startsWith('本集错题：')&&link.textContent.includes('26')));
  assert.equal(await page.locator('a a').count(),0);assert.equal(individualSummaryRequests.length,0);assert.equal(cardRequests.length,1);assert.equal(cardRequests[0].paperIds.length,3);
  assert.match(await aCard.getByRole('link',{name:'本集错题：快捷入口甲',exact:true}).textContent(),/26/);
  const shortcuts=[['错题','wrong'],['收藏','favorite'],['复习','review'],['草稿','drafts'],['历史','history']];
  for(const [label,tab]of shortcuts)assert.equal(await aCard.getByRole('link',{name:`本集${label}：快捷入口甲`,exact:true}).getAttribute('href'),`#/papers/${encodeURIComponent(state.a)}?tab=${tab}`);
  assert.match(await aCard.getByRole('link',{name:'本集草稿：快捷入口甲',exact:true}).textContent(),/草稿\s*1/);assert.match(await aCard.getByRole('link',{name:'本集历史：快捷入口甲',exact:true}).textContent(),/历史答题\s*1/);await checkShortcutRow(aCard);
  await aCard.getByRole('link',{name:'本集草稿：快捷入口甲',exact:true}).click();await page.getByRole('heading',{name:'作答草稿',exact:true}).waitFor();assert.equal(await page.getByRole('tab',{name:'作答草稿',exact:true}).getAttribute('aria-selected'),'true');await page.getByRole('link',{name:`继续作答：${state.draftA}`,exact:true}).waitFor();assert.equal(await page.locator('.context-attempt-list > a').count(),1);
  await page.goto(origin+'/#/papers');await aCard.getByRole('link',{name:'本集历史：快捷入口甲',exact:true}).click();await page.getByRole('heading',{name:'历史答题',exact:true}).waitFor();assert.equal(await page.getByRole('tab',{name:'历史答题',exact:true}).getAttribute('aria-selected'),'true');await page.getByRole('link',{name:`查看作答：${state.wrongA}`,exact:true}).waitFor();assert.equal(await page.locator('.context-attempt-list > a').count(),1);checks.push('题集五个快捷入口同一行，草稿与历史数量正确且分别打开本来源记录');
  await page.goto(origin+'/#/papers');await aCard.getByRole('link',{name:'本集收藏：快捷入口甲',exact:true}).waitFor();
  await aCard.getByRole('link',{name:'本集收藏：快捷入口甲',exact:true}).click();await page.getByRole('heading',{name:'收藏集',exact:true}).waitFor();await page.getByRole('button',{name:'查看学习题目：共享题的原始快照',exact:true}).waitFor();checks.push('普通题集卡片批量读取计数，无嵌套链接且可直接打开本集收藏');
  await page.goto(origin+'/#/papers');await page.getByPlaceholder('查找题集',{exact:true}).fill('没有这样的题集');await page.getByRole('heading',{name:'没有符合条件的题集',exact:true}).waitFor();
  for(const name of ['打开全部错题','打开全部收藏','打开待复习'])assert.equal(await page.getByRole('link',{name,exact:true}).count(),1);
  checks.push('三个固定特殊题集不受普通搜索筛选和分页影响');
  await page.getByRole('link',{name:'打开全部错题',exact:true}).click();await page.getByRole('button',{name:'查看汇总题目：共享题的原始快照',exact:true}).waitFor();
  const wrong=await api('/api/learning/global/questions?kind=wrong&page=1&pageSize=100');assert.equal(wrong.total,26);const shared=wrong.items.find(item=>item.question.sourceQuestionId==='G-SHARED'||item.question.id==='G-SHARED');assert.ok(shared);assert.equal(shared.origins.length,4);assert.deepEqual(new Set(shared.origins.map(item=>item.attemptId)),new Set([state.wrongA,state.wrongB,state.wrongC,state.quick]));
  const sharedRow=page.locator('.global-learning-question').filter({hasText:'共享题的原始快照'});await sharedRow.locator('.learning-origins > summary').click();await sharedRow.getByRole('link').filter({hasText:/作答|答题|复盘/}).first().waitFor();
  assert.ok((await sharedRow.textContent()).includes('快捷入口甲'));assert.ok((await sharedRow.textContent()).includes('已经删除的来源'));checks.push('全部错题按原题与小题去重，完整保留题集、已删除来源和随机作答溯源');
  const address=page.url();await sharedRow.getByRole('button',{name:'查看汇总题目：共享题的原始快照',exact:true}).click();const dialog=page.getByRole('dialog',{name:'汇总题集看题',exact:true});await dialog.getByRole('heading',{name:'共享题的原始快照',exact:true}).waitFor();await dialog.getByRole('button',{name:'展开答案与解析',exact:true}).click();await dialog.getByText('题集保存的旧答案',{exact:true}).waitFor();assert.equal(await dialog.getByText('当前原题的新答案',{exact:true}).count(),0);assert.equal(page.url(),address);await dialog.getByRole('button',{name:'关闭',exact:true}).click();checks.push('汇总错题原地查看错误快照，可定位不同来源的具体作答');
  await page.locator('.global-learning-question').nth(19).getByRole('button',{name:/查看汇总题目：/}).click();await dialog.getByRole('button',{name:'下一题',exact:true}).click();await dialog.getByRole('status').filter({hasText:/第 21 \/ 26/}).waitFor();await dialog.getByRole('button',{name:'关闭',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.global-learning-question').length===6);checks.push('汇总题集分页及跨页前后题切换正常');
  await page.goto(origin+'/#/learning/favorite');await page.getByRole('button',{name:'查看汇总题目：仅在知识题库收藏的题目',exact:true}).waitFor();assert.equal(await page.locator('.global-learning-question').count(),2);const libraryRow=page.locator('.global-learning-question').filter({hasText:'仅在知识题库收藏的题目'});assert.match(await libraryRow.textContent(),/知识题库/);
  await page.getByRole('button',{name:'查看汇总题目：当前共享原题',exact:true}).click();await dialog.getByRole('button',{name:'展开答案与解析',exact:true}).click();await dialog.getByText('当前原题的新答案',{exact:true}).waitFor();await dialog.getByRole('button',{name:'关闭',exact:true}).click();checks.push('全部收藏包括知识题库直接收藏，使用当前原题并显示关联来源');
  await libraryRow.getByRole('button',{name:'查看汇总题目：仅在知识题库收藏的题目',exact:true}).click();await dialog.getByRole('button',{name:'已收藏',exact:true}).click();await page.getByRole('status').filter({hasText:'学习记录已保存'}).waitFor();await dialog.getByRole('button',{name:'关闭',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.global-learning-question').length===1);checks.push('全集中取消收藏后统计和列表同步刷新');
  await page.goto(origin+'/#/learning/due');await page.getByRole('button',{name:'查看汇总题目：仅在知识题库收藏的题目',exact:true}).waitFor();assert.equal((await api('/api/learning/global/questions?kind=due&page=1&pageSize=100')).total,27);assert.equal(await page.locator('.global-learning-question').count(),20);await page.setViewportSize({width:390,height:844});await page.waitForFunction(()=>document.querySelector('.sidebar').getBoundingClientRect().right<=0.5);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:output+'/global-due-mobile.png',animations:'disabled'});await page.goto(origin+'/#/papers');await page.getByRole('link',{name:'打开全部错题',exact:true}).waitFor();await page.waitForFunction(()=>Array.from(document.querySelectorAll('article.paper-card a')).some(link=>link.getAttribute('aria-label')==='本集错题：快捷入口甲'&&link.textContent.includes('26')));await checkShortcutRow(aCard);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:output+'/cards-mobile.png',animations:'disabled'});await page.locator('article.paper-card').filter({hasText:'快捷入口甲'}).screenshot({path:output+'/ordinary-card-mobile.png',animations:'disabled'});checks.push('待复习包含库内未入集题目，390px卡片五入口仍同一行且无横向溢出');
  assert.deepEqual(errors,[]);const report={passed:checks.length,checks,browserErrors:errors,initialCardBatchCount:1,individualCardSummaryRequests:0,isolated:true};await writeFile(output+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){await page?.screenshot({path:output+'/failure.png'}).catch(()=>{});console.error({url:page?.url(),checks,stderr});throw error;}
finally{await browser?.close();server.kill();}
