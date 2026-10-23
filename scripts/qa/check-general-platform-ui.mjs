/** Run with an installed Playwright, optionally located via PLAYWRIGHT_MODULE. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

assert.equal(process.env.SMOKE_ISOLATED,'1','Only an isolated in-memory fixture may be used.');
const root=resolve(import.meta.dirname,'../..'),output=resolve(root,'test-results/general-platform');
let chromium;
try{({chromium}=await(process.env.PLAYWRIGHT_MODULE?import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href):import('playwright')));}
catch(error){throw new Error('Install Playwright for QA or specify its module with PLAYWRIGHT_MODULE.',{cause:error});}
await mkdir(output,{recursive:true});
const child=spawn(process.execPath,['--import','tsx','scripts/qa/serve-general-platform.ts'],{cwd:root,env:{...process.env,SMOKE_ISOLATED:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='',browser,page;child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr=(stderr+chunk).slice(-12000));
const checks=[],errors=[],failedResponses=[],writes=[],restorationEvidence={};
try{
 let ready;
 for(let i=0;i<300;i++){
  if(child.exitCode!==null)throw new Error(`Fixture exited: ${stderr}`);
  const marker=stdout.split(/\r?\n/).find(line=>line.startsWith('GENERAL_PLATFORM_READY '));
  if(marker){ready=JSON.parse(marker.slice('GENERAL_PLATFORM_READY '.length));break;}await delay(100);
 }
 assert.ok(ready,stderr);assert.equal(ready.isolatedDatabase,true);
 const base=ready.origin;
 const channel=process.env.PLAYWRIGHT_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined);
 browser=await chromium.launch({headless:true,...(channel?{channel}:{})});
 page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(20000);
 page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>void dialog.accept());
 page.on('response',response=>{if(new URL(response.url()).pathname.startsWith('/api/')&&response.status()>=400)failedResponses.push({path:new URL(response.url()).pathname,status:response.status()});});
 page.on('request',request=>{if(['POST','PUT','PATCH'].includes(request.method())&&new URL(request.url()).pathname.startsWith('/api/')){const body=request.postDataJSON();writes.push({path:new URL(request.url()).pathname,body});}});
 const api=async(path,method='GET',data,status=200)=>{const response=await page.request.fetch(base+path,{method,...(data===undefined?{}:{data})});assert.equal(response.status(),status,await response.text());return response.json();};
 const go=async hash=>{await page.goto(base+'/?generalqa='+Date.now()+hash,{waitUntil:'domcontentloaded'});await page.getByRole('heading',{level:1}).first().waitFor();};
 const act=async(locator,path,method='POST',status=200)=>{const pending=page.waitForResponse(response=>new URL(response.url()).pathname===path&&response.request().method()===method);await locator.click();const response=await pending;assert.equal(response.status(),status,await response.text());return response.json();};
 const generalUI=async()=>{assert.doesNotMatch(await page.locator('body').innerText(),/简历|优先级|resumePriority/);};
 const beginFresh=async()=>{const picker=page.getByRole('dialog',{name:'继续组卷草稿',exact:true});if(await picker.isVisible())await picker.getByRole('button',{name:'重新组卷',exact:true}).click();await page.waitForFunction(()=>{const fieldset=document.querySelector('.authoring-form-fieldset');return fieldset&&!fieldset.disabled;});};

 await go('#/');await page.getByText('知识的不同练法',{exact:true}).waitFor();await generalUI();assert.match(await page.locator('.dashboard-stats').innerText(),/个人专项\s*10/);checks.push('总览使用通用学习内容与个人专项统计，不展示简历或优先级入口');
 await go('#/questions');await page.locator('.question-row').first().waitFor();await page.getByRole('button',{name:/^个人专项$/}).click();await page.waitForFunction(()=>document.querySelector('.result-heading')?.textContent.includes('10 道'));assert.equal(await page.locator('.question-row').count(),10);await page.getByRole('button',{name:/^筛选/}).click();await generalUI();assert.equal(await page.getByLabel('内容属性',{exact:true}).inputValue(),'personal');checks.push('知识题库个人专项筛选正常，高级筛选仅保留通用学习维度');
 await go('#/questions/new');await page.getByLabel('标题 *',{exact:true}).fill('个人概念新增验收');await page.getByLabel('内容属性',{exact:true}).selectOption('personal');await page.getByLabel('题干 Markdown',{exact:true}).fill('解释抽象如何帮助组织知识。');await page.getByLabel('参考答案',{exact:true}).fill('保留当前问题必要特征并清楚表达约束。');await generalUI();const added=await act(page.getByRole('button',{name:'保存题目',exact:true}),'/api/questions','POST',201);assert.equal(added.collection,'personal');assert.equal(added.status,'pending');assert.equal(Object.hasOwn(added,'resumePriority'),false);await page.waitForURL(/#\/questions\//);await api('/api/questions/review','POST',{ids:[added.id],action:'approve',confirmed:true,expectedUpdatedAt:{[added.id]:added.updatedAt}});assert.equal((await api('/api/questions?collection=personal&pageSize=200')).total,11);await go(`#/questions/${added.id}/edit`);await page.getByLabel('标题 *',{exact:true}).waitFor();await generalUI();assert.equal(await page.getByLabel('内容属性',{exact:true}).inputValue(),'personal');checks.push('网页新增个人学习题进入待审核，确认后可筛选；编辑器无简历专用字段');

 // Simulate a pre-upgrade client response as well as the fixture's old JSON import.
 // Strict current APIs ensure any replay of these fields would fail visibly.
 await page.route('**/api/paper-drafts?context=new',async route=>{const response=await route.fetch();const body=await response.json();for(const draft of body){draft.state.filters={...draft.state.filters,priority:'P0',resumePriority:'P0',unknownLegacy:'ignored'};draft.state.random={...draft.state.random,priority:'P1',resumePriority:'P2'};}await route.fulfill({response,json:body});});
 await go('#/papers/new/manual');const picker=page.getByRole('dialog',{name:'继续组卷草稿',exact:true});
 // Restoration changes the debounced candidate filters. The old list can still
 // be visible for 240ms, then unmount when its replacement query starts.
 await page.getByRole('button',{name:'通用概念00',exact:true}).waitFor();
 const previousCandidate=await page.getByRole('button',{name:'通用概念00',exact:true}).elementHandle();
 const restoredCandidates=page.waitForResponse(response=>{
  const url=new URL(response.url());return url.pathname==='/api/questions'&&url.searchParams.get('collection')==='all'&&response.request().method()==='GET';
 });
 await picker.getByRole('button',{name:/旧草稿恢复验收/}).click();
 // Optional deterministic evidence for the original flaky sequence: interact
 // with the still-mounted old row, then observe its removal by the new query.
 if(process.env.GENERAL_PLATFORM_RACE_PROBE==='1'){
  await previousCandidate.evaluate(button=>button.click());
  await page.waitForFunction(button=>button.getAttribute('aria-expanded')==='true',previousCandidate);
  restorationEvidence.earlyClickExpanded=true;
 }
 await page.getByLabel('GP-Q00 分值',{exact:true}).waitFor();assert.equal(await page.getByLabel('GP-Q00 分值',{exact:true}).inputValue(),'8');assert.match(await page.locator('.selected-questions li').first().innerText(),/GP-Q01/);await generalUI();checks.push('旧版本草稿恢复顺序及分值，旧筛选字段不再产生界面或筛选限制');
 const candidateResponse=await restoredCandidates;assert.equal(candidateResponse.status(),200,await candidateResponse.text());
 const candidatePage=await candidateResponse.json();const restoredQuestion=candidatePage.items.find(question=>question.id==='GP-Q00');
 assert.equal(restoredQuestion?.stemMarkdown,'概念题干 0：请辨析接口与实现的关系。');
 await candidateResponse.finished();
 await page.waitForFunction(button=>!button.isConnected,previousCandidate);
 const candidate=page.getByRole('button',{name:'通用概念00',exact:true});await candidate.waitFor();
 restorationEvidence.responseFilter=new URL(candidateResponse.url()).searchParams.get('collection');
 restorationEvidence.restoredResponseContainsStem=true;restorationEvidence.originalCandidateRemoved=true;
 restorationEvidence.newCandidateInitiallyExpanded=await candidate.getAttribute('aria-expanded')==='true';
 await writeFile(resolve(output,'draft-restoration-evidence.json'),JSON.stringify(restorationEvidence,null,2)+'\n');
 if(process.env.GENERAL_PLATFORM_RACE_PROBE==='1')await writeFile(resolve(output,'draft-restoration-race-probe.json'),JSON.stringify(restorationEvidence,null,2)+'\n');
 await candidate.click();await page.locator('.question-row.is-expanded').filter({has:page.getByRole('button',{name:'通用概念00',exact:true})}).waitFor();await page.getByText('概念题干 0：请辨析接口与实现的关系。',{exact:true}).waitFor();assert.match(page.url(),/#\/papers\/new\/manual$/);assert.equal(await page.locator('.question-row .question-row-side a').count(),0);checks.push('手动组卷题目原位展开预览，点击标题不会跳转离开表单');
 await page.getByLabel('GP-Q00 分值',{exact:true}).fill('8.25');await page.locator('.selected-questions li').nth(1).getByRole('button',{name:'上移',exact:true}).click();await page.getByLabel('练习卷名称 *',{exact:true}).fill('通用平台手动练习');await act(page.getByRole('button',{name:'保存组卷草稿',exact:true}),'/api/paper-drafts/gp-legacy-draft','PUT');let drafts=await api('/api/paper-drafts?context=new');assert.equal(drafts.length,1);assert.equal(drafts[0].id,ready.draftId);assert.deepEqual(drafts[0].state.questionIds,['GP-Q00','GP-Q01']);assert.equal(drafts[0].state.overrides['GP-Q00'],8.25);assert.equal(Object.hasOwn(drafts[0].state.filters,'priority'),false);assert.equal(Object.hasOwn(drafts[0].state.random,'priority'),false);
 await page.getByLabel('练习目标',{exact:true}).fill('离开后继续保留');const flushed=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/paper-drafts/gp-legacy-draft'&&response.request().method()==='PUT');await page.locator('.sidebar a[href="#/questions"]').click();assert.equal((await flushed).status(),200);await page.getByRole('heading',{name:'把知识，积累成自己的能力。',exact:true}).waitFor();await go('#/papers/new/manual');await page.getByRole('dialog',{name:'继续组卷草稿',exact:true}).getByRole('button',{name:/通用平台手动练习/}).click();assert.equal(await page.getByLabel('练习目标',{exact:true}).inputValue(),'离开后继续保留');assert.equal(await page.getByLabel('GP-Q00 分值',{exact:true}).inputValue(),'8.25');assert.match(await page.locator('.selected-questions li').first().innerText(),/GP-Q00/);await act(page.getByRole('button',{name:'保存组卷草稿',exact:true}),'/api/paper-drafts/gp-legacy-draft','PUT');drafts=await api('/api/paper-drafts?context=new');assert.equal(drafts.length,1);assert.equal(drafts[0].id,ready.draftId);checks.push('手动草稿离开保存、重进继续并覆盖同ID，顺序和8.25分逐题设置均保留');
 const manual=await act(page.getByRole('button',{name:'创建练习卷',exact:true}),'/api/papers','POST',201);await page.waitForURL(/#\/papers\/paper-/);assert.deepEqual(manual.questionIds,['GP-Q00','GP-Q01']);assert.equal(manual.scoring.questionPoints['GP-Q00'],8.25);assert.equal(manual.scoring.totalPoints,13.25);checks.push('手动组卷生成正式练习卷，题目顺序与精确分值正确');

 await go('#/papers/new/random');await beginFresh();await page.getByLabel('练习卷名称 *',{exact:true}).fill('通用平台随机练习');await page.getByLabel('启用计分',{exact:true}).uncheck();await page.getByLabel('题目数量',{exact:true}).fill('4');await page.getByLabel('知识领域',{exact:true}).selectOption('gp-computing');await page.getByLabel('分类（包括子类）',{exact:true}).selectOption('gp-basics');await page.getByLabel('计算机学习 · 概念辨析',{exact:true}).check();await page.getByLabel('内容属性',{exact:true}).selectOption('personal');await generalUI();const preview=await act(page.getByRole('button',{name:'预览组卷构成',exact:true}),'/api/papers/preview');assert.equal(preview.questionCount,4);assert.ok(preview.questions.every(q=>q.collection==='personal'));const random=await act(page.getByRole('button',{name:'创建练习卷',exact:true}),'/api/papers','POST',201);await page.waitForURL(/#\/papers\/paper-/);assert.equal(random.questionCount,4);assert.equal(new Set(random.questionIds).size,4);assert.ok(random.questions.every(q=>q.collection==='personal'));checks.push('随机组卷按领域、分类、标签与个人专项交集预览和创建，抽4题且无重复');
 await go('#/quick');await page.getByLabel('知识领域',{exact:true}).selectOption('gp-computing');await page.getByLabel('分类（包括子类）',{exact:true}).selectOption('gp-basics');await page.getByLabel('计算机学习 · 概念辨析',{exact:true}).check();await page.getByLabel('内容属性',{exact:true}).selectOption('personal');await generalUI();const first=await act(page.getByRole('button',{name:'随机抽一题',exact:true}),'/api/quick-practice','POST',201);assert.equal(first.questions.length,1);assert.equal(first.questions[0].collection,'personal');await page.locator('.quick-current-attempt .exam-question').first().waitFor();const second=await act(page.getByRole('button',{name:'重新随机一题',exact:true}),'/api/quick-practice','POST',201);assert.notEqual(second.questions[0].sourceQuestionId,first.questions[0].sourceQuestionId);await page.getByRole('button',{name:'交卷并查看解析',exact:true}).first().waitFor();const answer=page.getByLabel('我的回答',{exact:true});if(await answer.count())await answer.fill('接口描述契约，实现完成行为。');else await page.locator('.answer-options input').first().check();const submitted=await act(page.getByRole('button',{name:'交卷并查看解析',exact:true}).first(),`/api/attempts/${second.id}/submit`);assert.equal(submitted.status,'submitted');checks.push('随机单题按交集筛选、重新抽题排除上一题，并可正常提交及查看解析');

 await page.setViewportSize({width:390,height:844});
 for(const [hash,name]of[['#/','overview'],['#/questions?collection=personal','questions'],['#/questions/new','editor'],['#/papers/new/manual','manual'],['#/papers/new/random','random'],['#/quick','quick']]){
  await go(hash);if(hash.includes('/papers/new'))await beginFresh();if(hash.includes('/questions?'))await page.locator('.question-row').first().waitFor();await generalUI();await page.waitForTimeout(150);const dimensions=await page.evaluate(()=>({document:document.documentElement.scrollWidth,viewport:innerWidth}));assert.ok(dimensions.document<=dimensions.viewport+1,`${name} overflow: ${JSON.stringify(dimensions)}`);await page.screenshot({path:resolve(output,`${name}-390.png`)});
 }
 checks.push('390px总览、题库、编辑、手动组卷、随机组卷及单题自测均无横向溢出');
 assert.ok(writes.length>8);for(const write of writes)assert.doesNotMatch(JSON.stringify(write.body),/"(?:priority|resumePriority|unknownLegacy)"\s*:/,`${write.path} replayed retired fields`);checks.push('浏览器所有新增、组卷、草稿、随机自测写请求均未回传旧字段');
 assert.deepEqual(errors,[]);assert.deepEqual(failedResponses,[]);checks.push('无浏览器运行异常及失败的API请求');
 const report={passed:checks.length,checks,browserErrors:errors,failedResponses,writeRequestsChecked:writes.length,restorationEvidence,isolatedDatabase:true};await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}catch(error){console.error('General platform QA failed',page?.url(),checks,stderr);await page?.screenshot({path:resolve(output,'failure.png'),timeout:5000}).catch(()=>{});throw error;}
finally{await browser?.close();child.kill();}
