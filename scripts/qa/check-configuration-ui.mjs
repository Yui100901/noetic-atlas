/** Exercise real downloads, previews, conflicts and retention in an empty memory DB. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createReviewedReleaseQuestion } from './release-fixture.mjs';
const root=resolve(import.meta.dirname,'../..'),output=resolve(root,'test-results/configuration-ui');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');
const server=spawn(process.execPath,['--import','tsx','scripts/qa/serve-configuration.ts'],{cwd:root,stdio:['ignore','pipe','pipe'],windowsHide:true});
let stdout='',stderr='',browser;server.stdout.on('data',value=>{stdout+=value;});server.stderr.on('data',value=>{stderr=(stderr+value).slice(-8000);});
const checks=[],errors=[];
await mkdir(output,{recursive:true});
try {
  let origin;
  for(let i=0;i<300;i++){
    if(server.exitCode!==null)throw Error('Configuration fixture stopped: '+stderr);
    const line=stdout.split(/\r?\n/).find(line=>line.startsWith('CONFIGURATION_UI_READY '));
    if(line){origin=JSON.parse(line.slice('CONFIGURATION_UI_READY '.length)).origin;break;}
    await delay(100);
  }
  assert.ok(origin,'Configuration fixture did not start');
  const api=async(path,method='GET',body)=>{
    const response=await fetch(origin+path,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
    const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;
  };
  assert.equal((await api('/api/bootstrap')).stats.totalQuestions,0);checks.push('新安装为空题库');
  browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true});
  const context=await browser.newContext({viewport:{width:1360,height:940},acceptDownloads:true});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+'/#/settings');await page.getByRole('button',{name:'数据与备份',exact:true}).click();
  const panel=page.getByRole('region',{name:'配置迁移'});await panel.waitFor();
  const exported=async()=>{
    const pending=page.waitForEvent('download');await panel.getByRole('button',{name:'导出配置',exact:true}).click();
    const download=await pending;const content=JSON.parse(await readFile(await download.path(),'utf8'));return content;
  };
  const initial=await exported();assert.equal(initial.ai.enabled,false);assert.equal(initial.ai.baseUrl,'');assert.ok(!('key'in initial.ai));assert.ok(!('questions'in initial));checks.push('真实配置下载不含题目或密钥');
  await panel.getByLabel('导出时包含AI端点、模型和请求参数').uncheck();assert.ok(!('ai'in await exported()));checks.push('可选择只导出常规配置');
  const upload=async(data)=>{
    await panel.getByLabel('选择配置JSON文件').setInputFiles({name:'preferences.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});
  };
  const ai=await api('/api/ai/settings');await api('/api/ai/settings','PUT',{enabled:true,baseUrl:'https://example.org/old',model:'test-model',supportsImages:false,sendImages:false,timeoutSeconds:60,maxTokens:4096,updatedAt:ai.updatedAt,key:'only-in-disposable-test-database'});
  const incoming={...initial,system:{...initial.system,maxDraftsPerPaper:5,randomQuestionCount:8},ai:{...initial.ai,enabled:true,baseUrl:'https://example.org/new',model:'test-model'}};
  await upload(incoming);await panel.getByRole('heading',{name:'常规配置差异'}).waitFor();
  assert.equal((await api('/api/settings')).maxDraftsPerPaper,3);assert.match(await panel.innerText(),/每卷草稿上限/);assert.match(await panel.innerText(),/清除本机旧密钥/);checks.push('预览字段差异与换接口清密钥提示，预览不写库');
  await panel.getByRole('button',{name:'确认应用配置',exact:true}).click();await panel.getByText('配置已导入。',{exact:false}).waitFor();
  assert.equal((await api('/api/settings')).maxDraftsPerPaper,5);assert.equal((await api('/api/ai/settings')).hasKey,false);checks.push('显式确认覆盖自定义配置并清除不同服务旧密钥');
  await upload({...incoming,ai:{...incoming.ai,key:'rejected-secret-must-not-echo'}});
  await page.getByText(/未知|Unrecognized|无效/).first().waitFor();assert.doesNotMatch(await panel.innerText(),/rejected-secret-must-not-echo/);assert.equal((await api('/api/settings')).maxDraftsPerPaper,5);checks.push('含密钥非法文件拒绝，错误不回显密钥值');
  const withoutAi={...incoming,system:{...incoming.system,maxDraftsPerPaper:6}};delete withoutAi.ai;
  await upload(withoutAi);await panel.getByRole('button',{name:'确认应用配置',exact:true}).waitFor();
  const current=await api('/api/settings');await api('/api/settings','PUT',{settings:{...current,autosaveDebounceMs:500}});
  await panel.getByRole('button',{name:'确认应用配置',exact:true}).click();await panel.getByRole('button',{name:'重新预览配置',exact:true}).waitFor();
  assert.equal((await api('/api/settings')).maxDraftsPerPaper,5);checks.push('预览过期不覆盖，需要重新预览');
  await panel.getByRole('button',{name:'重新预览配置',exact:true}).click();await panel.getByRole('button',{name:'确认应用配置',exact:true}).click();await panel.getByText('配置已导入。',{exact:false}).waitFor();assert.equal((await api('/api/settings')).maxDraftsPerPaper,6);
  const question=await createReviewedReleaseQuestion(api),paper=await api('/api/papers','POST',{title:'配置保留测试卷',mode:'manual',questionIds:[question.id]});
  for(let i=0;i<3;i++)await api(`/api/papers/${paper.id}/attempts`,'POST');
  const retain={...withoutAi,system:{...withoutAi.system,maxDraftsPerPaper:1}};
  await upload(retain);const confirm=panel.getByRole('button',{name:'确认应用配置',exact:true});await confirm.waitFor();assert.equal(await confirm.isDisabled(),true);
  assert.equal((await api(`/api/papers/${paper.id}/drafts`)).length,3);checks.push('记录清理预览展示并要求额外确认');
  await page.screenshot({path:resolve(output,'configuration-desktop.png')});
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:resolve(output,'configuration-mobile.png')});checks.push('390px差异表和操作按钮无横向溢出');
  await panel.getByLabel('我确认应用配置并清理上述超限记录').check();await confirm.click();await panel.getByText('配置已导入。',{exact:false}).waitFor();assert.equal((await api(`/api/papers/${paper.id}/drafts`)).length,1);assert.equal((await api('/api/questions?pageSize=10')).total,1);checks.push('确认后按规则保留最近草稿，题库继续保留');
  assert.deepEqual(errors,[]);
  const report={success:true,passed:checks.length,checks,pageErrors:errors,realProviderCalls:0,workingDatabaseAccessed:false};
  await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} finally {if(browser)await browser.close();server.kill();}
