/** One AI grading entry for single, quick and mixed/group attempt reviews. Uses only disposable local fixtures. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const root=resolve(import.meta.dirname,'../..'),folder=resolve(root,'test-results/ai-grade-entry-ui');await mkdir(folder,{recursive:true});
const fixture=`
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {buildApp} from './server/index.ts';
const app=await buildApp({databasePath:':memory:',seedPath:'missing-grade-entry-fixture',staticRoot:'dist/web',logger:false,dailyPushScheduler:false}),requests=[];
app.get('/qa/grade-entry',async()=>({requests}));
const provider=createServer(async(request,response)=>{try{
 const chunks=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 const content=body.messages[1].content,input=JSON.parse(typeof content==='string'?content:content[0].text),material=input.untrustedMaterial;
 assert.ok(input.task.includes('逐项评价'));requests.push({ids:material.items.map(item=>item.questionId),requirements:material.gradingRequirements});
 const result={items:material.items.map(item=>({questionId:item.questionId,verdict:'partial',score:item.maxPoints==null?null:item.maxPoints/2,maxPoints:item.maxPoints,comment:'部分要点正确，建议补充适用边界。',strengths:['说明了整体提交'],improvements:['补充失败回滚']}))};
 if(material.gradingRequirements?.includes('QA_BAD_SCORE'))result.items[0].score='PRIVATE_BAD_SCORE_VALUE';
 if(material.gradingRequirements?.includes('QA_BAD_VERDICT'))result.items[0].verdict='PRIVATE_BAD_VERDICT_VALUE';
 response.writeHead(200,{'Content-Type':'application/json',Connection:'close'});response.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}));
}catch(error){response.writeHead(400,{'Content-Type':'application/json',Connection:'close'});response.end('{}');}});
await new Promise(done=>provider.listen(0,'127.0.0.1',done));
const api=async(url,method='GET',payload)=>{const response=await app.inject({url,method,...(payload===undefined?{}:{payload})});assert.ok(response.statusCode<400,url+': '+response.body);return response.json();};
const common={stemMarkdown:'解释事务的整体性与失败处理。',answerMarkdown:'操作整体提交或整体回滚。',categoryIds:[],tagIds:[],status:'published'};
await api('/api/import','POST',{mode:'merge',data:{schemaVersion:1,domains:[],categories:[],tags:[],documents:[],papers:[],questions:[
 {...common,id:'ENTRY-S',title:'原子性简答',type:'short_answer'},
 {...common,id:'ENTRY-E',title:'失败处理论述',type:'essay'},
 {...common,id:'ENTRY-O',title:'整体提交判断',type:'true_false',correctAnswers:['true']},
 {...common,id:'ENTRY-G',title:'组合事务材料',type:'group',parts:[{id:'s',title:'解释原子性',type:'short_answer',stemMarkdown:'说明原子性。',answerMarkdown:'整体提交或回滚。',weight:1},{id:'o',title:'判断原子性',type:'true_false',stemMarkdown:'事务可以随意部分提交。',correctAnswers:['false'],weight:1}]}
]}});
const makePaper=(title,questionIds,scoring={enabled:false})=>api('/api/papers','POST',{title,mode:'manual',questionIds,scoring});
const makeAttempt=async(paper,answers)=>{const draft=await api('/api/papers/'+paper.id+'/attempts','POST',{});return answers===undefined?draft:api('/api/attempts/'+draft.id+'/submit','POST',{answers});};
const singlePaper=await makePaper('单题唯一AI入口',['ENTRY-S']);const single=await makeAttempt(singlePaper,{'ENTRY-S':{value:'事务应整体提交。'}});
const quickDraft=await api('/api/quick-practice','POST',{questionId:'ENTRY-S'}),quick=await api('/api/attempts/'+quickDraft.id+'/submit','POST',{answers:{'ENTRY-S':{value:'单题自测回答。'}}});
const mixedPaper=await makePaper('混合与组合题唯一AI入口',['ENTRY-S','ENTRY-E','ENTRY-O','ENTRY-G'],{enabled:true,totalPoints:20,questionPoints:{'ENTRY-S':4,'ENTRY-E':6,'ENTRY-O':2,'ENTRY-G':8}});
const mixed=await makeAttempt(mixedPaper,{'ENTRY-S':{value:'整体提交。'},'ENTRY-E':{value:'失败时回滚。'},'ENTRY-O':{value:'true'},'ENTRY-G::s':{value:'作为整体。'},'ENTRY-G::o':{value:'false'}});
const objective=await makeAttempt(await makePaper('纯客观题无需AI',['ENTRY-O']),{'ENTRY-O':{value:'true'}}),inProgress=await makeAttempt(singlePaper);
await api('/api/ai/settings','PUT',{enabled:true,baseUrl:'http://127.0.0.1:'+provider.address().port,model:'grade-entry-loopback',supportsImages:false,sendImages:false,timeoutSeconds:30,maxTokens:16384});
const origin=await app.listen({host:'127.0.0.1',port:0});console.log('GRADE_ENTRY_READY '+JSON.stringify({origin,ids:{single:single.id,quick:quick.id,mixed:mixed.id,objective:objective.id,inProgress:inProgress.id}}));
async function close(){await app.close();await new Promise(done=>provider.close(done));process.exit(0);}process.on('SIGTERM',()=>void close());
`;
const server=spawn(process.execPath,['--import','tsx','--input-type=module','-e',fixture],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='',browser,page;const checks=[],errors=[],external=[];
server.stdout.on('data',value=>stdout+=value);server.stderr.on('data',value=>stderr=(stderr+value).slice(-16000));
try{
 let ready;for(let index=0;index<600;index++){if(server.exitCode!==null)throw Error(stderr);const line=stdout.split(/\r?\n/).find(value=>value.startsWith('GRADE_ENTRY_READY '));if(line){ready=JSON.parse(line.slice('GRADE_ENTRY_READY '.length));break;}await delay(100);}assert.ok(ready,stderr);const {origin,ids}=ready;
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true});page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(20000);
 page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>void dialog.accept());await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||['data:','blob:'].includes(url.protocol))return route.continue();external.push(url.href);return route.abort();});
 const api=async(path)=>{const response=await page.request.get(origin+path);assert.ok(response.ok(),await response.text());return response.json();};
 const read=id=>api('/api/attempts/'+id),state=()=>api('/qa/grade-entry');
 let navigation=0;const go=async id=>{await page.goto(origin+'/?grade-entry='+ ++navigation+'#/attempts/'+id);await page.locator('.attempt-progress').waitFor();};
 const entry=()=>page.getByRole('button',{name:/^AI评价(本题|主观题)$/});
 const capture=async name=>{assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'horizontal overflow');await page.screenshot({path:resolve(folder,name+'.png'),fullPage:true});};
 await go(ids.single);assert.equal(await entry().count(),1);assert.equal(await page.locator('.exam-question button').filter({hasText:/^AI评价/}).count(),0);await page.getByRole('button',{name:'AI评价本题',exact:true}).click();
 const single=page.getByRole('dialog',{name:'AI评价这道主观题',exact:true});await single.waitFor();assert.equal(await single.getByRole('group',{name:'选择要评价的主观题'}).count(),0);const requirement='只评价整体提交与失败回滚两个要点。';await single.getByLabel('本次判题要求（可选）',{exact:true}).fill(requirement);
 await single.getByRole('button',{name:'生成 1 题的建议评价',exact:true}).click();await single.locator('.ai-grade-card').waitFor();assert.equal((await read(ids.single)).answers['ENTRY-S'].verdict,undefined);assert.equal((await state()).requests.at(-1).requirements,requirement);
 const priorGrade=await single.locator('.ai-grade-card').innerText(),unchangedSingle=JSON.stringify(await read(ids.single));
 for(const [marker,path,description] of [['QA_BAD_SCORE','items.0.score','字段类型错误或缺失'],['QA_BAD_VERDICT','items.0.verdict','字段值不在允许范围']]){
  await single.getByLabel('本次判题要求（可选）',{exact:true}).fill(marker);await single.getByRole('button',{name:'生成 1 题的建议评价',exact:true}).click();const failure=single.getByRole('alert').filter({hasText:path});await failure.waitFor();assert.ok((await failure.innerText()).includes(description));assert.doesNotMatch(await failure.innerText(),/PRIVATE_BAD_/);assert.equal(await single.locator('.ai-grade-card').innerText(),priorGrade);assert.equal(JSON.stringify(await read(ids.single)),unchangedSingle);
 }
 const failedRuns=(await api('/api/ai/runs?kind=grade&page=1&pageSize=20')).items.filter(run=>run.status==='failed');assert.equal(failedRuns.length,2);assert.ok(failedRuns.every(run=>run.failure.validationIssues.some(issue=>['items.0.score','items.0.verdict'].includes(issue.path))));checks.push('不合法分值或判定显示具体字段及固定校验原因，失败处理留记录，上一完整结果和原成绩保留且不暴露模型非法值');
 await single.getByRole('button',{name:'确认应用选中判题结果',exact:true}).click();await single.getByText('已应用判题结果',{exact:true}).waitFor();assert.equal((await read(ids.single)).answers['ENTRY-S'].verdict,'partial');await single.getByRole('button',{name:'关闭',exact:true}).click();checks.push('单题结果页仅一个AI入口，保留判题要求、预览与显式应用，未确认不改判定');
 await go(ids.quick);assert.equal(await entry().count(),1);assert.equal(await page.locator('.ai-actions button').filter({hasText:/^AI评价/}).count(),0);await page.getByRole('button',{name:'AI评价本题',exact:true}).click();await single.waitFor();await single.getByRole('button',{name:'关闭',exact:true}).click();checks.push('随机与单题自测复盘同样只有顶部一个AI入口');
 await go(ids.mixed);assert.equal(await entry().count(),1);assert.equal(await page.getByRole('button',{name:'AI评价本题',exact:true}).count(),0);await page.getByRole('button',{name:'AI评价主观题',exact:true}).click();const mixed=page.getByRole('dialog',{name:'AI评价多道主观题',exact:true});const selection=mixed.getByRole('group',{name:'选择要评价的主观题',exact:true});await selection.waitFor();assert.equal(await selection.getByRole('checkbox').count(),3);
 await selection.getByRole('checkbox',{name:'选择评价 ENTRY-E 失败处理论述',exact:true}).uncheck();await selection.getByRole('checkbox').nth(2).uncheck();await mixed.getByRole('button',{name:'生成 1 题的建议评价',exact:true}).click();await mixed.locator('.ai-grade-card').waitFor();assert.deepEqual((await state()).requests.at(-1).ids,['ENTRY-S']);assert.equal((await read(ids.mixed)).answers['ENTRY-S'].selfScore,undefined);checks.push('混合卷与组合小题共享唯一入口，可从多题中仅选一道，客观题不会进入AI评价范围');
 await selection.getByRole('checkbox',{name:'选择评价 ENTRY-E 失败处理论述',exact:true}).check();await selection.getByRole('checkbox').nth(2).check();await mixed.getByRole('button',{name:'生成 3 题的建议评价',exact:true}).click();await mixed.locator('.ai-grade-card').nth(2).waitFor();assert.deepEqual((await state()).requests.at(-1).ids,['ENTRY-S','ENTRY-E','ENTRY-G::s']);await mixed.getByRole('button',{name:'确认应用选中判题结果',exact:true}).click();await mixed.getByText('已应用判题结果',{exact:true}).nth(2).waitFor();const graded=await read(ids.mixed);assert.equal(graded.gradingStatus,'complete');assert.equal(graded.totalScore,13);await mixed.getByRole('button',{name:'关闭',exact:true}).click();await capture('mixed-desktop');checks.push('同一入口可批量评价3道主观题，保留组合小题身份，应用后总分13且客观成绩不变');
 await go(ids.objective);assert.equal(await entry().count(),0);await go(ids.inProgress);assert.equal(await entry().count(),0);checks.push('纯客观卷及未提交作答没有多余AI评题入口');
 await page.setViewportSize({width:390,height:844});await go(ids.quick);assert.equal(await entry().count(),1);await entry().click();await single.waitFor();await capture('single-mobile');await single.getByRole('button',{name:'关闭',exact:true}).click();await go(ids.mixed);await entry().click();await mixed.waitFor();await capture('mixed-mobile');checks.push('390px单题与多题统一入口及选择框无横向溢出');
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);const report={passed:checks.length,checks,errors,external,database:':memory:',provider:'loopback-only',modelCalls:(await state()).requests.length};await writeFile(resolve(folder,'report.json'),JSON.stringify(report,null,2));await rm(resolve(folder,'failure.json'),{force:true});console.log(JSON.stringify(report));
}catch(error){await page?.screenshot({path:resolve(folder,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(resolve(folder,'failure.json'),JSON.stringify({error:String(error.stack||error),checks,errors,external,stderr,url:page?.url()},null,2));throw error;}
finally{await browser?.close();server.kill('SIGTERM');if(server.exitCode===null)await Promise.race([new Promise(done=>server.once('exit',done)),delay(3000)]);if(server.exitCode===null)server.kill('SIGKILL');}
