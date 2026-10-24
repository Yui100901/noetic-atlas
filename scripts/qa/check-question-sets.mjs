/** Verify the unified question-set workflow on a disposable in-memory database. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const code=`import {buildApp} from './server/index.ts';
const app=await buildApp({databasePath:':memory:',seedPath:'no-question-set-qa',staticRoot:'dist/web'});
const questions=Array.from({length:25},(_,i)=>({id:'BROWSE-'+i,title:'顺序题目'+i,type:'short_answer',stemMarkdown:'保存的题干 '+i,answerMarkdown:'保存的答案 '+i,explanationMarkdown:'保存的解析 '+i,status:'published'}));
const response=await app.inject({method:'POST',url:'/api/import',payload:{mode:'merge',data:{schemaVersion:1,domains:[],categories:[],tags:[],questions,documents:[],papers:[],questionBanks:[{id:'old-reference-set',name:'迁移后的学习题集',description:'浏览、练习和考试',questionIds:questions.map(q=>q.id)}]}}});
if(response.statusCode!==200)throw Error(response.body);
await app.listen({host:'127.0.0.1',port:0});
console.log('QUESTION_SETS_READY '+JSON.stringify({origin:'http://127.0.0.1:'+app.server.address().port}));`;
const server=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='',browser,page;server.stdout.on('data',value=>stdout+=value);server.stderr.on('data',value=>stderr+=value);
const output='test-results/question-sets-ui';await mkdir(output,{recursive:true});
const checks=[],errors=[],bankRequests=[];
try {
  let origin;
  for(let i=0;i<200;i++){if(server.exitCode!==null)throw Error(stderr);const line=stdout.split(/\r?\n/).find(value=>value.startsWith('QUESTION_SETS_READY '));if(line){origin=JSON.parse(line.slice('QUESTION_SETS_READY '.length)).origin;break;}await new Promise(done=>setTimeout(done,100));}
  assert.ok(origin,stderr);
  browser=await chromium.launch({channel:'msedge',headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(20000);
  page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.url().includes('/api/question-banks'))bankRequests.push(request.url());});page.on('dialog',dialog=>void dialog.accept());
  const api=async(path,method='GET',data)=>{const response=await page.request.fetch(origin+path,{method,...(data===undefined?{}:{data})});assert.ok(response.ok(),await response.text());return response.json();};
  await page.goto(origin+'/#/papers');await page.getByRole('heading',{name:'我的题集',exact:false}).waitFor();assert.equal(await page.locator('.sidebar a[href="#/banks"]').count(),0);
  await page.getByRole('heading',{name:'迁移后的学习题集',exact:true}).click();await page.getByRole('heading',{name:'题集内容',exact:false}).waitFor();const location=page.url();
  assert.equal(await page.locator('.question-set-question-row').count(),20);await page.getByRole('button',{name:'查看题目：顺序题目19',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'题集内看题',exact:true});await dialog.getByRole('heading',{name:'顺序题目19',exact:true}).waitFor();
  await dialog.getByRole('button',{name:'下一题',exact:true}).click();await dialog.getByRole('heading',{name:'顺序题目20',exact:true}).waitFor();assert.equal(page.url(),location);
  await dialog.getByRole('button',{name:'展开答案与解析',exact:true}).click();await dialog.getByText('保存的答案 20',{exact:true}).waitFor();
  const original=await api('/api/questions/BROWSE-20');await api('/api/questions/BROWSE-20','PUT',{...original,answerMarkdown:'修改后的原题答案'});
  await dialog.getByLabel('我的学习笔记',{exact:true}).fill('题集内保存的笔记');await dialog.getByRole('button',{name:'保存笔记',exact:true}).click();await page.getByRole('status').filter({hasText:'学习记录已保存'}).waitFor();
  assert.equal((await api('/api/questions/BROWSE-20')).study.notes,'题集内保存的笔记');
  await dialog.getByRole('button',{name:'上一题',exact:true}).click();await dialog.getByRole('heading',{name:'顺序题目19',exact:true}).waitFor();await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  assert.equal(page.url(),location);assert.equal(await page.locator('.question-set-question-row').count(),20);checks.push('题集内看题、跨页前后切换、答案及笔记原地保存，无路由跳转');
  await page.getByRole('navigation',{name:'题集题目分页',exact:true}).getByRole('button',{name:/下一页/}).click();await page.getByRole('button',{name:'查看题目：顺序题目20',exact:true}).click();await dialog.getByRole('button',{name:'展开答案与解析',exact:true}).click();await dialog.getByText('保存的答案 20',{exact:true}).waitFor();assert.equal(await dialog.getByText('修改后的原题答案',{exact:true}).count(),0);
  await dialog.getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('navigation',{name:'题集题目分页',exact:true}).getByText(/第 2 \/ 2 页/).waitFor();checks.push('关闭看题保留列表页码，原题修改不替换题集快照');
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'查看题目：顺序题目20',exact:true}).click();await dialog.getByRole('heading',{name:'顺序题目20',exact:true}).waitFor();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.ok(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth+1));await page.screenshot({path:output+'/question-viewer-mobile.png'});await dialog.getByRole('button',{name:'关闭',exact:true}).click();checks.push('390px移动端题集与看题弹窗无横向溢出');
  await page.setViewportSize({width:1440,height:1000});await page.getByRole('button',{name:'开始练习',exact:true}).click();await page.waitForURL(/#\/attempts\//);const attemptId=decodeURIComponent(page.url().split('/').pop());await api('/api/attempts/'+encodeURIComponent(attemptId)+'/submit','POST',{answers:{}});
  await page.goto(origin+'/#/papers/old-reference-set');await page.getByRole('button',{name:'选择练习模式',exact:true}).click();await page.getByRole('menuitem',{name:/^考试模式/}).click();await page.getByRole('dialog',{name:'开始限时考试',exact:true}).getByRole('button',{name:'开始考试',exact:true}).click();await page.waitForURL(/#\/attempts\//);const examId=decodeURIComponent(page.url().split('/').pop());await api('/api/attempts/'+encodeURIComponent(examId)+'/submit','POST',{answers:{}});
  const markdown=await page.request.get(origin+'/api/papers/old-reference-set/export?answers=true');assert.equal(markdown.status(),200);assert.match(await markdown.text(),/保存的答案 20/);checks.push('迁移题集可练习、考试并导出含答案Markdown');
  const metadataResponses=[],editorQuestionRequests=[];
  page.on('response',response=>{if(response.url().endsWith('/api/questions/metadata')&&response.request().method()==='POST'&&response.status()===200)metadataResponses.push(response);});
  page.on('request',request=>{if(/\/api\/questions\/BROWSE-\d+$/.test(request.url())&&request.method()==='GET')editorQuestionRequests.push(request.url());});
  // The exam above was submitted through the test API, so reload the document
  // before exercising editing to discard the UI's cached active-exam state.
  await page.goto(origin+'/?question-set-editor-qa=1#/papers/old-reference-set/edit');await page.getByRole('button',{name:'保存题集',exact:true}).waitFor();
  await page.waitForFunction(()=>!document.querySelector('button[form="paper-editor-form"]').disabled);
  assert.equal(await page.locator('.selected-questions > li').count(),20);assert.equal(metadataResponses.length,1);assert.equal(editorQuestionRequests.length,0);
  const basketPage=page.getByRole('navigation',{name:'已选题目分页',exact:true});
  await basketPage.getByRole('button',{name:/下一页/}).click();assert.equal(await page.locator('.selected-questions > li').count(),5);
  assert.equal(await page.locator('.selected-questions > li').first().locator('code').textContent(),'BROWSE-20');
  await page.locator('.selected-questions > li').first().getByRole('button',{name:'上移',exact:true}).click();
  assert.equal(await page.locator('.selected-questions > li').first().locator('code').textContent(),'BROWSE-19');assert.equal(metadataResponses.length,1);
  await page.getByRole('button',{name:'保存组题草稿',exact:true}).click();
  await page.waitForFunction(async()=>{const response=await fetch('/api/paper-drafts?context=old-reference-set');const drafts=await response.json();return drafts.some(draft=>draft.state.questionIds.length===25&&draft.state.questionIds[19]==='BROWSE-20'&&draft.state.questionIds[20]==='BROWSE-19');});
  checks.push('题集编辑批量核对、已选分页与跨页排序正常，草稿保留全部题目');
  assert.deepEqual(bankRequests,[]);assert.deepEqual(errors,[]);
  const report={passed:checks.length,checks,browserErrors:errors,oldCollectionRequests:bankRequests,isolated:true};await writeFile(output+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} catch(error) {await page?.screenshot({path:output+'/failure.png'}).catch(()=>{});console.error({url:page?.url(),checks,stderr});throw error;}
finally{await browser?.close();server.kill();}
