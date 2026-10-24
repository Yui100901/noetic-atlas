/** End-to-end page actions against a disposable in-memory learning station. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,rm,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const root=resolve(import.meta.dirname,'../..'),folder=resolve(root,'test-results/ai-workflows');await mkdir(folder,{recursive:true});
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');
const server=spawn(process.execPath,['--import','tsx','scripts/qa/serve-ai-workflows.ts'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
let output='',stderr='',browser;server.stdout.on('data',data=>output+=data);server.stderr.on('data',data=>stderr=(stderr+data).slice(-10000));
const checks=[],pageErrors=[],unexpectedNetwork=[];
try{
  let ready;for(let i=0;i<300;i++){
    if(server.exitCode!==null)throw Error('Fixture failed: '+stderr);
    const line=output.split(/\r?\n/).find(line=>line.startsWith('AI_WORKFLOWS_READY '));if(line){ready=JSON.parse(line.slice('AI_WORKFLOWS_READY '.length));break;}await delay(100);
  }assert.ok(ready,stderr);
  const {origin}=ready;browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true});
  const page=await browser.newPage({viewport:{width:1360,height:940}});page.setDefaultTimeout(15000);page.on('pageerror',error=>pageErrors.push(error.message));
  page.on('dialog',dialog=>void dialog.accept());
  await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||['data:','blob:'].includes(url.protocol))return route.continue();unexpectedNetwork.push(url.origin);return route.abort();});
  const state=async()=>{const response=await page.request.get(origin+'/qa/ai-workflows');assert.equal(response.status(),200);return response.json();};
  const question=async id=>(await (await page.request.get(origin+'/api/questions/'+encodeURIComponent(id))).json());
  const initial=await state();assert.equal(initial.totalQuestions,5);

  await page.goto(origin+'/#/questions/S1');await page.getByLabel('我的学习笔记',{exact:true}).waitFor();
  const typedNotes=initial.originalNotes+' 新增尚未保存的思考。';await page.getByLabel('我的学习笔记',{exact:true}).fill(typedNotes);
  await page.getByRole('button',{name:'生成 AI 解析',exact:true}).click();await page.locator('.ai-result').filter({hasText:'QA解释'}).waitFor();
  assert.equal((await state()).notes,initial.originalNotes);checks.push('生成解释只预览，不自动写入笔记');
  await page.getByRole('button',{name:'追加到学习笔记',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.notes-area')?.value.includes('QA解释'));
  const once=(await state()).notes;assert.ok(once.startsWith(typedNotes));await page.getByRole('button',{name:'追加到学习笔记',exact:true}).click();
  await page.getByRole('button',{name:'追加到学习笔记',exact:true}).waitFor({state:'visible'});assert.equal((await state()).notes,once);checks.push('显式写笔记保存未保存草稿并保留原文，重复应用幂等');
  await page.getByText('写一段回答，请 AI 给建议',{exact:true}).click();await page.getByLabel('交给 AI 评价的回答',{exact:true}).fill('事务操作整体提交或回滚，转账必须一起完成。');await page.getByLabel('建议满分',{exact:true}).fill('5');
  await page.getByRole('button',{name:'评价本次回答',exact:true}).click();await page.locator('.ai-grade-card').filter({hasText:'建议 4 / 5分'}).waitFor();
  assert.equal((await state()).notes,once);await page.getByRole('button',{name:'选中评价追加到笔记',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.notes-area')?.value.includes('AI 作答评价'));
  assert.ok((await state()).notes.startsWith(once));checks.push('单题回答经页面生成建议分，显式追加评价到笔记');await page.screenshot({path:resolve(folder,'question-explanation-grade.png'),fullPage:true});

  await page.goto(origin+'/#/papers/'+initial.paperId);await page.getByRole('button',{name:'开始练习',exact:true}).click();await page.waitForURL(/#\/attempts\//);
  const attemptId=decodeURIComponent(page.url().split('#/attempts/')[1]);await page.locator('#exam-1 textarea').fill('事务内操作全部提交或全部回滚。');await page.locator('#exam-2 textarea').fill('隔离性描述并发事务之间可见性，与原子性不同。');await page.locator('#exam-3 input[type=radio]').first().check();
  await page.getByRole('button',{name:'交卷并查看解析',exact:true}).first().click();await page.locator('.ai-review-toolbar').waitFor();
  const attempt=async()=>(await (await page.request.get(origin+'/api/attempts/'+attemptId)).json());const submitted=await attempt();assert.equal(submitted.objectiveScore,2);assert.equal(submitted.subjectiveScore,0);assert.equal(submitted.answers.S1.value,'事务内操作全部提交或全部回滚。');assert.equal(submitted.answers.S2.value,'隔离性描述并发事务之间可见性，与原子性不同。');checks.push('通过页面实际作答交卷，回答完整保存，客观题自动得2分且主观题待判');
  await page.getByRole('button',{name:'AI评价主观题',exact:true}).click();const gradeDialog=page.getByRole('dialog',{name:'AI评价多道主观题',exact:true});await gradeDialog.getByRole('button',{name:'生成 2 题的建议评价',exact:true}).click();await gradeDialog.locator('.ai-grade-card').nth(1).waitFor();
  assert.equal((await attempt()).subjectiveScore,0);checks.push('整卷多题AI建议展示后，确认前不修改成绩');await gradeDialog.getByRole('button',{name:'确认应用选中建议分',exact:true}).click();
  await page.waitForFunction(async id=>{const value=await(await fetch('/api/attempts/'+id)).json();return value.gradingStatus==='complete';},attemptId);
  const graded=await attempt();assert.equal(graded.objectiveScore,2);assert.equal(graded.subjectiveScore,8);assert.equal(graded.totalScore,10);checks.push('通过页面确认应用两题评分，主观8分、客观2分、总分10分');
  await gradeDialog.getByRole('button',{name:'关闭',exact:true}).click();assert.equal(await page.locator('#exam-1 textarea').inputValue(),submitted.answers.S1.value);assert.equal(await page.locator('#exam-2 textarea').inputValue(),submitted.answers.S2.value);await page.screenshot({path:resolve(folder,'paper-ai-grading.png'),fullPage:true});

  await page.goto(origin+'/#/ai');await page.getByRole('button',{name:'文件 / 文本辅助导入',exact:true}).click();await page.getByLabel('待转换文本',{exact:true}).fill('判断：事务需要整体提交或回滚。答案：正确。解析：不保留部分操作。');await page.getByLabel('本批最多提取题量',{exact:true}).fill('1');
  await page.getByRole('button',{name:'分析并生成结构化预览',exact:true}).click();await page.getByRole('button',{name:'确认新增到待审核',exact:true}).waitFor();assert.equal((await state()).totalQuestions,5);checks.push('AI文本转换预览不直接新增题目');
  await page.getByRole('button',{name:'确认新增到待审核',exact:true}).click();await page.getByText('已新增1道待审核题。',{exact:false}).first().waitFor();
  const imported=await state();assert.equal(imported.totalQuestions,6);const created=imported.questions.find(q=>q.title==='AI转换的事务判断题');assert.equal(created?.status,'pending');checks.push('页面确认导入后新增1题并保持待审核');

  await page.goto(origin+'/#/questions/review');await page.getByRole('checkbox',{name:'审核选择 P1',exact:true}).check();await page.getByRole('checkbox',{name:'审核选择 BAD1',exact:true}).check();await page.getByRole('button',{name:'AI审核选中题目',exact:true}).click();
  const review=page.getByRole('dialog',{name:'AI审核 2 道待审核题',exact:true});await review.getByRole('button',{name:'运行 AI 审核',exact:true}).click();await review.getByText('审核报告',{exact:true}).waitFor();assert.equal((await question('P1')).status,'published');assert.equal((await question('BAD1')).status,'pending');
  assert.ok(await review.getByText('已通过审核',{exact:true}).count());assert.ok(await review.getByText('通常整数算术中2+2=4，原答案错误。',{exact:true}).count());checks.push('批量AI审核正确题发布、错误题显示原因并保留待审核');await review.getByRole('button',{name:'关闭',exact:true}).click();

  await page.goto(origin+'/#/ai');await page.getByLabel('AI组题要求',{exact:true}).fill('推荐2道基础题。');await page.getByLabel('推荐题量（组合题整组计）',{exact:true}).fill('2');await page.getByRole('button',{name:'生成推荐组题预览',exact:true}).click();await page.getByRole('button',{name:'确认创建题集',exact:true}).waitFor();
  await page.getByRole('button',{name:'确认创建题集',exact:true}).click();await page.waitForURL(/#\/papers\//);checks.push('AI工作台推荐通过页面确认创建题集');
  await page.setViewportSize({width:390,height:844});await page.goto(origin+'/#/questions/S1');await page.locator('.question-body').waitFor();
  // A viewport change starts the sidebar's mobile transition; inspect the settled layout.
  await page.waitForFunction(()=>{const sidebar=document.querySelector('.sidebar');return sidebar&&sidebar.getBoundingClientRect().right<=1;});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));checks.push('390px题目AI工作流无横向溢出且侧栏正常收起');await page.screenshot({path:resolve(folder,'question-ai-mobile.png')});
  assert.deepEqual(pageErrors,[]);assert.deepEqual(unexpectedNetwork,[]);checks.push('无未捕获页面错误，浏览器及模型均仅访问本机隔离服务');
  const final=await state();assert.ok(['explain','grade','import','review','paper_plan'].every(kind=>final.providerRequests.some(request=>request.kind===kind)));
  const report={passed:checks.length,checks,pageErrors,unexpectedNetwork,database:':memory:',provider:'deterministic-loopback',providerRequests:final.providerRequests};await writeFile(resolve(folder,'report.json'),JSON.stringify(report,null,2)+'\n');await rm(resolve(folder,'failure.json'),{force:true});console.log(JSON.stringify(report,null,2));
}catch(error){await writeFile(resolve(folder,'failure.json'),JSON.stringify({error:String(error.stack||error),checks,pageErrors,unexpectedNetwork,server:stderr},null,2)+'\n');throw error;}
finally{await browser?.close();server.kill('SIGTERM');if(server.exitCode===null)await Promise.race([new Promise(done=>server.once('exit',done)),delay(3000)]);if(server.exitCode===null)server.kill('SIGKILL');}
