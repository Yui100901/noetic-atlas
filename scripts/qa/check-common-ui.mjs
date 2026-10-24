/** Source-backed common-question packs run only in an isolated memory service. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root=resolve(import.meta.dirname,'../..'),output=resolve(root,'test-results/common-ui');
const packIds=(await readdir(resolve(root,'data/content-packs'))).filter(name=>name.endsWith('-common-202610.json')).map(name=>name.slice(0,-5)).sort();
assert.equal(packIds.length,11,'Expected a pack for every current domain');
const packs=await Promise.all(packIds.map(async name=>JSON.parse(await readFile(resolve(root,'data/content-packs',name+'.json'),'utf8'))));
const originals=packs.flatMap(pack=>pack.questions),total=originals.length;
assert.ok(total>0);assert.equal(new Set(originals.map(question=>question.id)).size,total);
await mkdir(output,{recursive:true});
const{chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');
const fixture=`import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {buildApp} from './server/index.ts';
import {Store} from './server/core/store.ts';
import {validatePack,validatePackSet} from './scripts/content/manage.ts';
import {importData,exportData} from './server/modules/transfer/migration.ts';
const names=${JSON.stringify(packIds)};
const packs=await Promise.all(names.map(async name=>validatePack(JSON.parse(await readFile('data/content-packs/'+name+'.json','utf8')))));
validatePackSet(packs);const staging=new Store(':memory:');for(const pack of packs)importData(staging,pack);
const questions=staging.all('questions');assert.equal(questions.length,${total});assert.ok(questions.every(question=>question.status==='pending'));
const app=await buildApp({databasePath:':memory:',seedPath:'no-common-ui-seed',staticRoot:'dist/web',logger:false});
const response=await app.inject({method:'POST',url:'/api/import',payload:{mode:'merge',data:exportData(staging)}});assert.ok(response.statusCode<400,response.body);staging.db.close();
const origin=await app.listen({host:'127.0.0.1',port:0});console.log('COMMON_UI_READY '+JSON.stringify({origin,total:questions.length}));`;
const server=spawn(process.execPath,['--import','tsx','--input-type=module','-e',fixture],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='',browser,page;server.stdout.on('data',value=>stdout+=value);server.stderr.on('data',value=>stderr=(stderr+value).slice(-15000));
const checks=[],errors=[],externalRequests=[],measurements=[],domainCounts=[],practiced=[];
try{
  let state;for(let index=0;index<300;index++){if(server.exitCode!==null)throw Error('Memory fixture failed: '+stderr);const line=stdout.split(/\r?\n/).find(value=>value.startsWith('COMMON_UI_READY '));if(line){state=JSON.parse(line.slice('COMMON_UI_READY '.length));break;}await delay(100);}
  assert.ok(state,stderr);const{origin}=state;
  browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true});
  page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(15000);
  page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>void dialog.accept());
  await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||['data:','blob:'].includes(url.protocol))return route.continue();externalRequests.push(url.origin);return route.abort();});
  const api=async(path,method='GET',data)=>{const response=await page.request.fetch(origin+path,{method,...(data===undefined?{}:{data})});assert.ok(response.ok(),path+': '+await response.text());return response.json();};
  let navigation=0;const go=async path=>{await page.goto(origin+'/?common-ui='+ ++navigation+'#/'+path);await page.locator('.page-header').waitFor();await page.waitForLoadState('networkidle');};
  const noOverflow=async label=>{const size=await page.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth}));measurements.push({label,...size});assert.ok(size.width<=size.viewport+1,label+': '+JSON.stringify(size));};
  const capture=async label=>{await noOverflow(label);await page.screenshot({path:resolve(output,label+'.png'),fullPage:true});};
  const bootstrap=await api('/api/bootstrap');assert.equal(bootstrap.domains.length,11);assert.equal((await api('/api/questions?status=pending')).total,total);assert.equal((await api('/api/questions')).total,0);
  const categories=new Map(bootstrap.categories.map(category=>[category.id,category])),tags=new Map(bootstrap.tags.map(tag=>[tag.id,tag]));
  for(const question of originals){assert.ok(question.categoryIds.length&&question.tagIds.length);assert.ok(Number.isInteger(question.frequency)&&question.frequency>=0&&question.frequency<=3);assert.match(question.frequencyBasis,/未统计|非统计|不代表|不是统计/);for(const id of question.categoryIds)assert.ok(categories.has(id));for(const id of question.tagIds)assert.ok(tags.has(id));}
  checks.push(`${packIds.length}包共${total}道唯一待审核题，11领域及分类/标签依赖完整，复习F分级有非统计依据说明`);
  for(const domain of bootstrap.domains){const found=await api('/api/questions?status=pending&domainId='+encodeURIComponent(domain.id));assert.ok(found.total>0);const question=originals.find(value=>value.categoryIds.some(id=>categories.get(id)?.domainId===domain.id));assert.ok(question);
    assert.ok((await api('/api/questions?status=pending&categoryId='+encodeURIComponent(question.categoryIds[0]))).total>0);
    const topic=question.tagIds.find(id=>tags.get(id)?.domainId===domain.id);assert.ok(topic);assert.ok((await api('/api/questions?status=pending&domainId='+encodeURIComponent(domain.id)+'&tagIds='+encodeURIComponent(topic))).total>0);
    const blocked=await page.request.post(origin+'/api/quick-practice',{data:{questionId:question.id}});assert.equal(blocked.status(),400);assert.equal((await blocked.json()).error.code,'QUESTION_UNAVAILABLE');
    domainCounts.push({id:domain.id,name:domain.name,total:found.total,sampleId:question.id});}
  checks.push('11领域均可按领域/分类/主题筛选，待审核题均被作答接口拒绝');
  const pending=originals.find(question=>question.id.startsWith('ENGLISH-COMMON-'));assert.ok(pending);await go('questions/'+encodeURIComponent(pending.id));assert.equal(await page.getByRole('button',{name:'开始单题自测',exact:true}).count(),0);await page.getByText('待审核，尚未进入正式题库或组卷。',{exact:true}).waitFor();
  const reviewed=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/questions/review'&&response.request().method()==='POST');await page.getByRole('button',{name:'确认审核通过',exact:true}).click();assert.equal((await reviewed).status(),200);await page.getByRole('button',{name:'开始单题自测',exact:true}).waitFor();
  const remaining=originals.filter(question=>question.id!==pending.id);for(let start=0;start<remaining.length;start+=300){const questions=remaining.slice(start,start+300);const result=await api('/api/questions/review','POST',{ids:questions.map(question=>question.id),action:'approve',confirmed:true,expectedUpdatedAt:Object.fromEntries(questions.map(question=>[question.id,question.updatedAt]))});assert.equal(result.count,questions.length);}
  assert.equal((await api('/api/questions?status=pending')).total,0);assert.equal((await api('/api/questions')).total,total);checks.push('通过实际单题审核按钮及批量审核接口，仅在memory fixture批准本批全部题');
  for(const level of [1,2,3]){const expected=originals.filter(question=>question.frequency===level).length;if(expected)assert.equal((await api('/api/questions?frequency='+level)).total,expected);}checks.push('F1/F2/F3结构化筛选结果与源包逐题计数一致');
  await go('questions');const domainSelect=page.getByLabel('知识领域',{exact:true});assert.equal(await domainSelect.locator('option').count(),12);for(const domain of domainCounts){await domainSelect.selectOption(domain.id);await page.getByText('找到 '+domain.total+' 道题目',{exact:true}).waitFor();}
  checks.push('题库领域下拉逐域切换，11域题数与内容包相符');
  await page.setViewportSize({width:390,height:844});
  for(const domain of domainCounts){const sample=domain.id==='physics'?originals.find(question=>question.id.startsWith('PHYSICS-COMMON-')&&question.explanationMarkdown.includes('ΔU=80')):originals.find(question=>question.id===domain.sampleId);assert.ok(sample);await go('questions/'+encodeURIComponent(sample.id));await page.getByRole('button',{name:'我想过了，展开答案与解析',exact:true}).click();await page.locator('.answer-content').waitFor();const text=await page.locator('.answer-content').innerText();assert.ok(text.length>50);if(domain.id==='physics'){assert.match(text,/50 J/);assert.match(text,/系统对外做功/);}await noOverflow('390px-explanation-'+domain.id);if(['physics','medicine-pharmacy','geography'].includes(domain.id))await capture('mobile-'+domain.id+'-explanation');}
  checks.push('390px逐11域阅读真实解析，物理第一定律公式/符号约定与医学基础解释可读且无横向溢出');
  const exercises=[
    originals.find(question=>question.id.startsWith('ENGLISH-COMMON-')&&question.type==='single_choice'),
    originals.find(question=>question.id.startsWith('CHEMISTRY-COMMON-')&&question.type==='multiple_choice'),
    originals.find(question=>question.id.startsWith('GEOGRAPHY-COMMON-')&&question.type==='true_false'),
    originals.find(question=>question.id.startsWith('PHYSICS-COMMON-')&&question.type==='fill_blank'),
    originals.find(question=>question.id.startsWith('JAPANESE-COMMON-')&&question.type==='fill_blank'),
  ];
  for(const question of exercises){assert.ok(question);await go('questions/'+encodeURIComponent(question.id));await page.getByRole('button',{name:'开始单题自测',exact:true}).click();await page.waitForURL(/#\/attempts\//);await page.locator('.exam-question').first().waitFor();const attemptId=decodeURIComponent(page.url().split('/').pop());const active=await api('/api/attempts/'+attemptId);for(const field of ['answerMarkdown','explanationMarkdown','correctAnswers'])assert.equal(active.questions[0][field],undefined);
    if(question.type==='fill_blank'){const inputs=page.locator('.blank-answer-fields input');assert.equal(await inputs.count(),question.blanks.length);for(let index=0;index<question.blanks.length;index++)await inputs.nth(index).fill(question.blanks[index].answers[0]);}
    else{const inputs=page.locator('.answer-options input'),keys=question.type==='true_false'?['true','false']:question.options.map(option=>option.key);for(const key of question.correctAnswers)await inputs.nth(keys.indexOf(key)).check();}
    await noOverflow('390px-answering-'+question.type);await page.getByRole('button',{name:'交卷并查看解析',exact:true}).first().click();await page.getByText('回答正确',{exact:false}).first().waitFor();const submitted=await api('/api/attempts/'+attemptId);assert.equal(submitted.answerStates[question.id],'correct');assert.ok(submitted.questions[0].explanationMarkdown.length>10);practiced.push({id:question.id,type:question.type,answerState:submitted.answerStates[question.id]});await noOverflow('390px-submitted-'+question.type);}
  checks.push('手机实际作答单选/多选/判断/物理与日语填空五题全部判对，作答前不返回答案与解析');
  await capture('mobile-last-submitted');assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[]);
  const report={passed:checks.length,checks,packs:packIds,total,domainCounts,practiced,measurements,errors,externalRequests,isolated:true,databasePath:':memory:'};await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:checks.length,total,packs:packIds.length,checks,errors,externalRequests}));
}catch(error){await page?.screenshot({path:resolve(output,'failure.png'),fullPage:true}).catch(()=>{});console.error({url:page?.url(),checks,stderr});throw error;}
finally{await browser?.close();server.kill();}
