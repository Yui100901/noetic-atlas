/** Quality actions use actual routes, disposable records and a loopback model. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const folder=resolve('test-results/quality-actions-ui');await mkdir(folder,{recursive:true});
const server=spawn(process.execPath,['--import','tsx','scripts/qa/serve-unified-quality.ts'],{stdio:['ignore','pipe','pipe'],windowsHide:true});
let stdout='',stderr='',browser,page;const checks=[],errors=[],external=[],writes=[],questionWrites=[];server.stdout.on('data',v=>stdout+=v);server.stderr.on('data',v=>stderr+=v);
try{
 for(let i=0;i<600&&!stdout.includes('UNIFIED_QUALITY_READY ');i++){if(server.exitCode!==null)throw Error(stderr+stdout);await delay(100);}
 const ready=stdout.split(/\r?\n/).find(v=>v.startsWith('UNIFIED_QUALITY_READY '));assert.ok(ready,stderr);const {origin}=JSON.parse(ready.slice('UNIFIED_QUALITY_READY '.length));
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');browser=await chromium.launch({channel:'msedge',headless:true});page=await browser.newPage({viewport:{width:1440,height:1000},locale:'zh-CN'});page.setDefaultTimeout(25000);page.on('pageerror',e=>errors.push(e.message));
 page.on('request',request=>{if(request.method()==='PUT'&&/\/api\/questions\/[^/]+$/.test(new URL(request.url()).pathname))questionWrites.push(request.url());if(request.method()==='POST'&&/\/content-quality\/issues(?:\/[^/]+)?\/resolve$/.test(new URL(request.url()).pathname))writes.push(request.url());});
 await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||['data:','blob:'].includes(url.protocol))return route.continue();external.push(url.href);return route.abort();});
 const state=async()=>{const response=await page.request.get(origin+'/qa/unified-quality');assert.ok(response.ok());return response.json();};
 const api=async(path,method='GET',data)=>{const response=await page.request.fetch(origin+path,{method,...(data===undefined?{}:{data})});assert.ok(response.ok(),await response.text());return response.json();};
 const wait=async(fn,label)=>{for(let i=0;i<250;i++){if(await fn())return;await delay(100);}throw Error('Timeout: '+label);};
 const originalAttempt=JSON.stringify((await state()).attempt);
 const feedback=await api('/api/question-feedback','POST',{questionId:'FEED-S1',kind:'answer',description:'操作验收：参考答案与解析应核对。'});
 const issueId=feedback.qualityIssueId;
 await page.goto(origin+'/#/content-quality?issueId='+issueId);const detail=page.getByRole('region',{name:'质量问题详情',exact:true});await detail.waitFor();
 const item=page.locator('.question-quality-item[data-quality-issue="'+issueId+'"]'),resolution=item.getByRole('region',{name:'本项状态处理',exact:true}),note=resolution.getByLabel('本项处理依据 / 备注',{exact:true}),save=resolution.getByRole('button',{name:'保存本项状态',exact:true});
 const apply=async status=>{await resolution.getByLabel('本项处理状态',{exact:true}).selectOption(status);await save.click();};
 const current=()=>item.locator('.quality-actions').innerText();
 const beforeEmpty=writes.length;await save.click();await resolution.getByRole('alert').waitFor();assert.match(await resolution.innerText(),/填写本问题的处理依据/);assert.equal(writes.length,beforeEmpty);assert.equal(await note.evaluate(node=>document.activeElement===node),true);checks.push('空备注点击保存仅提示本项依据并聚焦，不发送状态请求');
 await note.fill('人工对照原题与解析，确认需要修正。');
 // Freeze a real old GET response before saving. It must not roll the UI or
 // optimistic version back when it arrives after the successful action.
 const detailPattern='**/api/content-quality/issues/'+issueId;let held=null,holdNext=true;
 const holdOldDetail=async route=>{if(!holdNext)return route.continue();holdNext=false;const response=await route.fetch();held={route,response,body:await response.body()};};
 await page.route(detailPattern,holdOldDetail);await detail.getByRole('button',{name:'刷新本条证据',exact:true}).click();await wait(async()=>!!held,'old GET held');
 await apply('confirmed');await wait(async()=>(await state()).issues.items.find(i=>i.id===issueId).status==='confirmed','confirmed persisted');await wait(async()=>/当前：已确认问题/.test(await current()),'current status saved');
 await held.route.fulfill({response:held.response,body:held.body});await page.unroute(detailPattern,holdOldDetail);await delay(250);
 assert.match(await current(),/当前：已确认问题/);assert.match(await detail.locator('.list-toolbar').first().innerText(),/已确认问题/);
 await apply('open');await wait(async()=>/当前：待核查/.test(await current()),'reopen uses latest version');await apply('confirmed');await wait(async()=>(await state()).issues.items.find(i=>i.id===issueId).status==='confirmed','reconfirm persisted');await wait(async()=>/当前：已确认问题/.test(await current()),'reconfirm latest version');
 assert.equal((await state()).issues.items.find(i=>i.id===issueId).status,'confirmed');checks.push('旧GET延迟到保存后返回也不回退状态，后续处理继续使用最新版本');
 assert.match(await current(),/当前：已确认问题/);const saved=(await state()).issues.items.find(i=>i.id===issueId),writesBefore=writes.length;await delay(250);assert.equal(writes.length,writesBefore);assert.equal((await state()).feedback.items.find(f=>f.id===feedback.id).status,'confirmed');checks.push('确认动作保存并同步反馈，当前状态明确显示且不会自动重复提交');
 await api('/api/content-quality/issues/'+issueId+'/resolve','POST',{status:'open',note:'另一页面已更新处理状态。',expectedUpdatedAt:saved.updatedAt});await apply('resolved');
 await wait(async()=>/状态已更新|状态已变化|刷新后/.test(await resolution.innerText()),'local version conflict');assert.equal((await state()).issues.items.find(i=>i.id===issueId).status,'open');checks.push('版本冲突409在本项表单内显示，旧操作不会覆盖新状态');
 const {study:_study,partStudies:_partStudies,feedbackSummary:_feedbackSummary,...question}=await api('/api/questions/FEED-S1');
 await api('/api/questions/FEED-S1','PUT',{...question,explanationMarkdown:'修订后的解析：乘法优先，应为14；核对保存答案。'});await page.reload();await detail.waitFor();
 assert.equal(await detail.getByRole('button',{name:'AI复核本条问题',exact:true}).isDisabled(),true);assert.match(await detail.innerText(),/变化|重新扫描|重新检查/);checks.push('原题变化时AI复核显示禁用原因，避免对历史证据继续付费分析');
 await detail.getByRole('button',{name:'重新扫描本题',exact:true}).click();await wait(async()=>(await state()).scans.items.some(s=>s.filters.questionId==='FEED-S1'&&s.status==='completed'),'rescan finished');await note.fill('已经检查保存后的修订版本，关闭本条反馈。');await wait(async()=>!(await save.isDisabled()),'resolve ready');await apply('resolved');
 await wait(async()=>(await state()).issues.items.find(i=>i.id===issueId).status==='resolved','resolved after rescan');await wait(async()=>/当前：已解决/.test(await current()),'resolved state displayed');assert.match(await item.innerText(),/已解决/);checks.push('修改原题后重新扫描，再标为已解决可实际保存并在原处显示结果');
 const slow=await api('/api/question-feedback','POST',{questionId:'FEED-SIM',kind:'answer',description:'QA_SLOW：请核查本题的答案与解析是否一致。'});
 await page.goto(origin+'/#/content-quality?issueId='+slow.qualityIssueId);await detail.waitFor();await wait(async()=>await page.getByLabel('标题 *',{exact:true}).inputValue()==='表达式优先级对照','new AI case loaded');await detail.getByRole('button',{name:'AI复核本条问题',exact:true}).click();
 const progress=detail.getByRole('region',{name:'AI处理进度',exact:true});await progress.waitFor();assert.equal(await progress.getAttribute('aria-busy'),'true');assert.equal(await page.locator('.question-quality-item[data-quality-issue="'+slow.qualityIssueId+'"]').getByRole('button',{name:'保存本项状态',exact:true}).isDisabled(),true);
 await wait(async()=>(await state()).feedback.items.some(f=>f.id===slow.id&&f.review),'local review completed');await wait(async()=>/AI复核完成|复核完成|处理完成/.test(await detail.innerText()),'local success');assert.equal((await state()).issues.items.find(i=>i.id===slow.qualityIssueId).status,'open');checks.push('AI处理进度和完成反馈位于本题详情内，复核建议不会自动改变人工状态');
 const sourceBeforeCompare=await api('/api/questions/FEED-SIM'),questionWriteCount=questionWrites.length;await detail.getByRole('button',{name:'站内查找相似与冲突',exact:true}).click();await detail.getByText('站内相似与冲突候选',{exact:true}).waitFor();await page.waitForLoadState('networkidle');assert.equal(questionWrites.length,questionWriteCount);assert.equal((await api('/api/questions/FEED-SIM')).updatedAt,sourceBeforeCompare.updatedAt);checks.push('编辑页展开站内比对不会提交父表单或保存原题');
 const {hasKey:_hasKey,...settings}=await api('/api/ai/settings');await api('/api/ai/settings','PUT',{...settings,enabled:false});const calls=(await state()).calls.length;await page.reload();await detail.waitFor();assert.equal(await detail.getByRole('button',{name:'AI复核本条问题',exact:true}).isDisabled(),true);assert.match(await detail.innerText(),/开启|配置/);assert.equal((await state()).calls.length,calls);checks.push('AI未开启时按钮禁用且给出配置入口，无模型调用');
 await page.screenshot({path:resolve(folder,'desktop.png'),fullPage:true});await page.setViewportSize({width:390,height:844});await delay(300);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:resolve(folder,'mobile.png'),fullPage:true});checks.push('移动端操作反馈与禁用提示无横向溢出');
 assert.equal(JSON.stringify((await state()).attempt),originalAttempt);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);checks.push('人工状态与AI操作均保留历史卷面，零页面异常及外网请求');
 await writeFile(resolve(folder,'report.json'),JSON.stringify({passed:checks.length,checks,errors,external,database:':memory:',provider:'loopback-only'},null,2));console.log(JSON.stringify({passed:checks.length,checks}));
}catch(error){await page?.screenshot({path:resolve(folder,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(resolve(folder,'failure.json'),JSON.stringify({error:String(error.stack||error),checks,errors,external,stderr},null,2));throw error;}
finally{await browser?.close();server.kill('SIGTERM');if(server.exitCode===null)await Promise.race([new Promise(done=>server.once('exit',done)),delay(3000)]);if(server.exitCode===null)server.kill('SIGKILL');}
