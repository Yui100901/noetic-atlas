/** Contextual records acceptance, always on an isolated in-memory database. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const code=`import {buildApp} from './server/index.ts';
const app=await buildApp({databasePath:':memory:',seedPath:'no-context-learning-qa',staticRoot:'dist/web'});
const call=async(method,url,payload)=>{const response=await app.inject({method,url,...(payload===undefined?{}:{payload})});if(response.statusCode>=400)throw Error(response.body);return response.json();};
await call('POST','/api/import',{mode:'merge',data:{schemaVersion:1,domains:[],categories:[],tags:[],documents:[],papers:[],questions:[{id:'CTX-BOOL',title:'共享判断题的原快照',type:'true_false',stemMarkdown:'缓存失效是否需要明确规则？',correctAnswers:['true'],answerMarkdown:'需要明确的失效规则。',explanationMarkdown:'保持原始解析。',status:'published'},{id:'CTX-SHORT',title:'尚未判定的主观题',type:'short_answer',stemMarkdown:'解释缓存一致性。',answerMarkdown:'说明更新和失效边界。',status:'published'}]}});
const makeSet=(title,questionIds)=>call('POST','/api/papers',{title,mode:'manual',questionIds,scoring:{enabled:false}});
const a=await makeSet('来源甲题集',['CTX-BOOL','CTX-SHORT']),b=await makeSet('来源乙题集',['CTX-BOOL']),c=await makeSet('已删除的来源题集',['CTX-BOOL']);
const submit=async(paper,answers)=>{const attempt=await call('POST','/api/papers/'+paper.id+'/attempts');return call('POST','/api/attempts/'+attempt.id+'/submit',{answers});};
const wrong=await submit(a,{'CTX-BOOL':{value:'false'},'CTX-SHORT':{value:'待判断的主观作答'}});
const correct=await submit(b,{'CTX-BOOL':{value:'true'}});
const pageQuestions=Array.from({length:25},(_,index)=>({id:'CTX-PAGE-'+index,title:'分页错题'+index,type:'true_false',stemMarkdown:'分页练习题 '+index,correctAnswers:['true'],status:'published'}));
await call('POST','/api/import',{mode:'merge',data:{schemaVersion:1,domains:[],categories:[],tags:[],documents:[],papers:[],questions:pageQuestions}});
const large=await makeSet('分页错题测试题集',pageQuestions.map(question=>question.id));await submit(large,Object.fromEntries(pageQuestions.map(question=>[question.id,{value:'false'}])));
const draft=await call('POST','/api/papers/'+a.id+'/attempts');
await call('PUT','/api/attempts/'+draft.id,{answers:{'CTX-SHORT':{value:'草稿中的回答'}}});
const orphan=await submit(c,{'CTX-BOOL':{value:'false'}});
const orphanDraft=await call('POST','/api/papers/'+c.id+'/attempts');
await call('DELETE','/api/papers/'+c.id+'?permanent=true');
const quick=await call('POST','/api/quick-practice',{questionId:'CTX-BOOL'});
await call('POST','/api/attempts/'+quick.id+'/submit',{answers:{'CTX-BOOL':{value:'false'}}});
await call('POST','/api/quick-practice',{questionId:'CTX-BOOL'});
await call('PUT','/api/study/CTX-BOOL',{favorite:true,nextReviewAt:'2020-01-01T00:00:00.000Z',notes:'保留的共享笔记'});
const source=await call('GET','/api/questions/CTX-BOOL');await call('PUT','/api/questions/CTX-BOOL',{...source,title:'更新后的原题名称',answerMarkdown:'新的原题答案'});
await app.listen({host:'127.0.0.1',port:0});console.log('CONTEXT_LEARNING_READY '+JSON.stringify({origin:'http://127.0.0.1:'+app.server.address().port,a:a.id,b:b.id,c:c.id,large:large.id,wrong:wrong.id,correct:correct.id,draft:draft.id,orphan:orphan.id,orphanDraft:orphanDraft.id,quick:quick.id}));`;
const server=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='',browser,page;server.stdout.on('data',value=>stdout+=value);server.stderr.on('data',value=>stderr+=value);
const output='test-results/context-learning-ui';await mkdir(output,{recursive:true});
const checks=[],errors=[],globalAttemptRequests=[];
try{
  let state;
  for(let i=0;i<200;i++){if(server.exitCode!==null)throw Error(stderr);const line=stdout.split(/\r?\n/).find(value=>value.startsWith('CONTEXT_LEARNING_READY '));if(line){state=JSON.parse(line.slice('CONTEXT_LEARNING_READY '.length));break;}await new Promise(done=>setTimeout(done,100));}
  assert.ok(state,stderr);const {origin}=state;
  browser=await chromium.launch({channel:'msedge',headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(20000);
  page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>void dialog.accept());page.on('request',request=>{if(new URL(request.url()).pathname==='/api/attempts')globalAttemptRequests.push(request.url());});
  const api=async(path,method='GET',data)=>{const response=await page.request.fetch(origin+path,{method,...(data===undefined?{}:{data})});assert.ok(response.ok(),await response.text());return response.json();};
  const openSet=async(id,tab='content')=>{await page.goto(origin+'/#/papers/'+id+'?tab='+tab);await page.getByRole('tab',{name:'题集内容',exact:true}).waitFor();};
  await openSet(state.a);assert.equal(await page.locator('.sidebar a[href="#/study"]').count(),0);
  await page.getByRole('tab',{name:'错题集',exact:true}).click();await page.getByRole('button',{name:'查看学习题目：共享判断题的原快照',exact:true}).waitFor();assert.equal(await page.locator('.context-learning-question').count(),1);
  const address=page.url();await page.getByRole('button',{name:'查看学习题目：共享判断题的原快照',exact:true}).click();const dialog=page.getByRole('dialog',{name:'题集学习看题',exact:true});await dialog.getByRole('heading',{name:'共享判断题的原快照',exact:true}).waitFor();await dialog.getByRole('button',{name:'展开答案与解析',exact:true}).click();await dialog.getByText('需要明确的失效规则。',{exact:true}).waitFor();assert.equal(await dialog.getByText('新的原题答案',{exact:true}).count(),0);assert.equal(page.url(),address);
  await dialog.getByLabel('我的学习笔记',{exact:true}).fill('题集内复习保存的笔记');await dialog.getByRole('button',{name:'保存笔记',exact:true}).click();await page.getByRole('status').filter({hasText:'学习记录已保存'}).waitFor();await dialog.getByRole('button',{name:'关闭',exact:true}).click();assert.equal((await api('/api/questions/CTX-BOOL')).study.notes,'题集内复习保存的笔记');
  checks.push('移除学习记录导航，源题集错题保留当次快照并支持原地复习和笔记');
  await openSet(state.b,'wrong');await page.getByRole('heading',{name:'当前没有错题',exact:true}).waitFor();assert.equal(await page.locator('.context-learning-question').count(),0);checks.push('同一道题跨题集及随机自测的错误互不污染');
  await openSet(state.a,'history');await page.getByRole('link',{name:'查看作答：'+state.wrong,exact:true}).click();await page.getByRole('link',{name:'返回题集记录',exact:true}).click();await page.getByRole('tab',{name:'历史答题',exact:true}).waitFor();assert.equal(await page.getByRole('tab',{name:'历史答题',exact:true}).getAttribute('aria-selected'),'true');
  await page.getByRole('tab',{name:'作答草稿',exact:true}).click();await page.getByRole('link',{name:'继续作答：'+state.draft,exact:true}).click();await page.waitForURL(/#\/attempts\//);assert.ok(page.url().endsWith(state.draft));await page.getByRole('link',{name:'返回题集记录',exact:true}).click();checks.push('历史复盘和草稿续答按来源题集组织，回退能定位历史页');
  await page.getByRole('tab',{name:'复习建议',exact:true}).click();await page.getByRole('heading',{name:'下一步学习建议',exact:true}).waitFor();await page.getByRole('button',{name:'查看学习题目：共享判断题的原快照',exact:true}).waitFor();await page.getByRole('button',{name:/我的收藏/}).click();await page.getByRole('button',{name:'查看学习题目：共享判断题的原快照',exact:true}).waitFor();checks.push('到期复习与收藏按题集筛选，共享源题进度');
  await page.goto(origin+'/#/papers');await page.getByText('已删除题集的历史',{exact:true}).click();await page.getByRole('link').filter({has:page.getByText('已删除的来源题集',{exact:true})}).click();await page.getByRole('link',{name:'查看作答：'+state.orphan,exact:true}).waitFor();await page.getByRole('tab',{name:/作答草稿/}).click();await page.getByRole('link',{name:'继续作答：'+state.orphanDraft,exact:true}).waitFor();checks.push('删除源题集后，历史、错题和作答草稿仍有入口');
  await page.goto(origin+'/#/quick?tab=history');await page.getByRole('link',{name:'查看作答：'+state.quick,exact:true}).waitFor();await page.getByRole('tab',{name:/错题集/}).click();await page.getByRole('button',{name:'查看学习题目：共享判断题的原快照',exact:true}).waitFor();checks.push('随机与单题自测保留独立来源内的草稿历史和错题');
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.getByRole('button',{name:'查看学习题目：共享判断题的原快照',exact:true}).click();assert.ok(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth+1));await page.screenshot({path:output+'/context-learning-mobile.png'});await dialog.getByRole('button',{name:'关闭',exact:true}).click();checks.push('390px移动端记录列表与阅读弹窗无横向溢出');
  await openSet(state.large,'wrong');await page.getByRole('button',{name:'查看学习题目：分页错题19',exact:true}).click();await dialog.getByRole('heading',{name:'分页错题19',exact:true}).waitFor();const pagedAddress=page.url();await dialog.getByRole('button',{name:'下一题',exact:true}).click();await dialog.getByRole('heading',{name:'分页错题20',exact:true}).waitFor();assert.equal(page.url(),pagedAddress);await dialog.getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('navigation',{name:'上下文错题集分页',exact:true}).getByText(/第 2 \/ 2 页/).waitFor();assert.equal(await page.locator('.context-learning-question').count(),5);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));checks.push('错题查看可跨页切换，关闭后保留页码，题集页签适配窄屏');
  await page.goto(origin+'/#/study?tab=favorite');await page.waitForURL(/#\/questions\?favorite=true$/);await page.locator('.question-list .question-row').first().waitFor();checks.push('旧学习记录链接重定向到对应现有入口');
  assert.deepEqual(errors,[]);assert.deepEqual(globalAttemptRequests,[]);
  const report={passed:checks.length,checks,browserErrors:errors,unscopedAttemptRequests:globalAttemptRequests,isolated:true};await writeFile(output+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){await page?.screenshot({path:output+'/failure.png'}).catch(()=>{});console.error({url:page?.url(),checks,stderr});throw error;}
finally{await browser?.close();server.kill();}
