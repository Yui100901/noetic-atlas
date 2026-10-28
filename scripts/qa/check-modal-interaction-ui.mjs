/** Exercise the shared dialog against a real attempt page in a memory fixture. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const output=resolve('test-results/modal-interaction');await mkdir(output,{recursive:true});
const server=spawn(process.execPath,['--import','tsx','scripts/qa/serve-ai-question-edit.ts'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='',browser,page,release;const errors=[],checks=[];server.stdout.on('data',value=>stdout+=value);server.stderr.on('data',value=>stderr+=value);
try{
 for(let i=0;i<600&&!stdout.includes('AI_QUESTION_EDIT_READY ');i++){if(server.exitCode!==null)throw Error(stderr);await delay(100);}
 const line=stdout.split(/\r?\n/).find(value=>value.startsWith('AI_QUESTION_EDIT_READY '));assert.ok(line,stderr);const{origin}=JSON.parse(line.slice('AI_QUESTION_EDIT_READY '.length));
 const{chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');browser=await chromium.launch({channel:'msedge',headless:true});page=await browser.newPage({viewport:{width:390,height:844}});page.on('pageerror',error=>errors.push(error.message));
 const before=await(await page.request.get(origin+'/qa/ai-question-edit')).json();
 // This fixture's attempt is objective; add one subjective attempt through the actual API.
 const api=async(url,data)=>{const response=await page.request.post(origin+url,{data});assert.ok(response.ok(),await response.text());return response.json();};
 // Use the existing pending subjective question, explicitly approving this disposable copy first.
 const q=await(await page.request.get(origin+'/api/questions/EDIT-P')).json();await api('/api/questions/review',{ids:[q.id],action:'approve',confirmed:true,expectedUpdatedAt:{[q.id]:q.updatedAt}});
 const subjectPaper=await api('/api/papers',{title:'主观弹窗检查',mode:'manual',questionIds:[q.id],scoring:{enabled:false}}),attempt=await api('/api/papers/'+subjectPaper.id+'/attempts',{});await api('/api/attempts/'+attempt.id+'/submit',{answers:{[q.id]:{value:'原子性是整体提交或回滚。'}}});
 await page.goto(origin+'/#/attempts/'+attempt.id);const entry=page.getByRole('button',{name:'AI评价本题',exact:true});await entry.waitFor();await entry.click();const dialog=page.getByRole('dialog',{name:'AI评价这道主观题',exact:true});await dialog.waitFor();
 assert.equal(await dialog.getByRole('button',{name:'关闭',exact:true}).getAttribute('type'),'button');assert.equal(await page.evaluate(()=>document.body.style.overflow),'hidden');
 const box=await dialog.getByRole('button',{name:'关闭',exact:true}).boundingBox();assert.ok(box.width>=44&&box.height>=44);checks.push('弹窗关闭为普通按钮，手机关闭热区至少44px，打开后锁定背景滚动');
 let requested=false;const barrier=new Promise(done=>release=done);await page.route('**/api/ai/grade',async route=>{requested=true;await barrier;await route.fulfill({status:502,contentType:'application/json',body:JSON.stringify({error:{code:'AI_INVALID_OUTPUT',message:'隔离测试的输出格式错误',details:{failure:{code:'AI_INVALID_OUTPUT',validationIssues:[{path:'items.0.score',rule:'invalid_type'}]}}}})}).catch(()=>{});});
 await dialog.getByRole('button',{name:'生成 1 题的建议评价',exact:true}).click();for(let i=0;i<100&&!requested;i++)await delay(50);assert.ok(requested);await dialog.getByRole('button',{name:'正在处理…',exact:true}).waitFor();await page.keyboard.press('Escape');assert.equal(await dialog.isVisible(),true);await dialog.getByRole('button',{name:'关闭',exact:true}).click();assert.equal(await dialog.isVisible(),true);checks.push('处理期间Escape和关闭按钮读取当前忙碌状态，均不会误关弹窗或中断请求');
 release();await dialog.getByRole('button',{name:'生成 1 题的建议评价',exact:true}).waitFor();await dialog.getByRole('alert').filter({hasText:'items.0.score'}).waitFor();
 await dialog.evaluate(element=>{const hidden=document.createElement('details');hidden.innerHTML='<summary>未展开的测试设置</summary><input aria-label="隐藏设置"/>';element.append(hidden);});
 const generate=dialog.getByRole('button',{name:'生成 1 题的建议评价',exact:true});await generate.focus();await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'未展开的测试设置');
 await page.keyboard.press('Tab');assert.equal(await dialog.getByRole('button',{name:'关闭',exact:true}).evaluate(element=>element===document.activeElement),true,JSON.stringify(await dialog.evaluate(element=>({active:document.activeElement?.outerHTML,targets:[...element.querySelectorAll('button,input,textarea,summary')].map(node=>({tag:node.tagName,tab:node.tabIndex,text:node.getAttribute('aria-label')||node.textContent,rects:node.getClientRects().length,width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height}))}))));await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'未展开的测试设置');checks.push('Tab/Shift+Tab按可见控件环绕，关闭details中的输入不参与焦点循环');
 await page.screenshot({path:resolve(output,'mobile-dialog.png'),fullPage:true});await page.keyboard.press('Escape');assert.equal(await dialog.count(),0);assert.equal(await page.evaluate(()=>document.body.style.overflow),'');assert.equal(await entry.evaluate(element=>element===document.activeElement),true);checks.push('完成后Escape正常关闭，背景滚动和原入口焦点恢复');
 const after=await(await page.request.get(origin+'/qa/ai-question-edit')).json();assert.deepEqual(after.attempt,before.attempt);assert.deepEqual(errors,[]);await writeFile(resolve(output,'report.json'),JSON.stringify({passed:checks.length,checks,errors,database:':memory:',providerCalls:0},null,2));console.log(JSON.stringify({passed:checks.length,checks,errors}));
}catch(error){await page?.screenshot({path:resolve(output,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(resolve(output,'failure.json'),JSON.stringify({error:String(error.stack||error),checks,errors,stderr},null,2));throw error;}
finally{release?.();await browser?.close();server.kill();}
