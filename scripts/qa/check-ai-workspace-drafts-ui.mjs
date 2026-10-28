/** AI workspace drafts: disposable SQLite app, real page actions, loopback model. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root=resolve(import.meta.dirname,'../..'),folder=resolve(root,'test-results/ai-workspace-drafts-ui');
await mkdir(folder,{recursive:true});
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href:'playwright');
const fixture=`import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {buildApp} from './server/index.ts';
const app=await buildApp({databasePath:':memory:',seedPath:'no-ai-workspace-drafts-seed',staticRoot:'dist/web',dailyPushScheduler:false,logger:false});
const calls=[];
const provider=createServer(async(request,response)=>{try{
 const chunks=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
 const envelope=JSON.parse(Buffer.concat(chunks).toString('utf8')),content=envelope.messages[1].content;
 const input=JSON.parse(typeof content==='string'?content:content[0].text),material=input.untrustedMaterial;
 let kind,result;
 if(input.outputSchema.summary){kind='document-plan';result={title:material.sourceName+'知识块',summary:'依据资料说明整体提交与回滚。',topics:['事务','原子性']};}
 else if(input.outputSchema.items?.[0]?.reason){kind='paper';result={title:'可恢复推荐题集',description:'检验持久草稿与人工预览修改。',items:material.candidates.slice(0,material.requestedCount).map(question=>({questionId:question.id,reason:'覆盖基础概念'}))};}
 else if(input.outputSchema.questions){kind='import';const count=Math.min(2,Number(/最多(\\d+)道/.exec(input.task)?.[1]||2));result={questions:Array.from({length:count},(_,index)=>({title:'草稿验收概念题'+(index+1),type:'short_answer',stemMarkdown:'根据'+material.sourceName+'，'+(index?'转账中只扣款未入账违背了什么事务性质？':'说明事务的原子性及适用边界。'),answerMarkdown:'操作整体提交或整体回滚。',explanationMarkdown:'转账的扣款与入账要作为整体完成。',difficulty:2})),taxonomySuggestions:{domains:[],categories:[],tags:[]}};}
 else throw new Error('Unexpected fixture task');
 calls.push({kind});response.writeHead(200,{'Content-Type':'application/json',Connection:'close'});response.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}));
 }catch(error){response.writeHead(400,{'Content-Type':'application/json'});response.end(JSON.stringify({error:{message:'fixture-contract-error'}}));}});
await new Promise(done=>provider.listen(0,'127.0.0.1',done));
async function api(url,payload,method='POST'){const response=await app.inject({method,url,...(payload===undefined?{}:{payload})});assert.ok(response.statusCode<400,url+': '+response.statusCode+' '+response.body);return response.json();}
app.get('/qa/workspace-drafts',async()=>({calls,questions:await api('/api/questions?status=all&pageSize=200',undefined,'GET'),jobs:await api('/api/ai/document-jobs?page=1&pageSize=100',undefined,'GET')}));
await api('/api/domains',{id:'computer',name:'计算机'});await api('/api/categories',{id:'transactions',domainId:'computer',name:'事务'});
for(let index=1;index<=4;index++){const question=await api('/api/questions',{id:'DRAFT-Q'+index,title:'事务概念'+index,type:'short_answer',stemMarkdown:'说明事务整体提交与回滚的性质。',answerMarkdown:'原子性。',explanationMarkdown:'一组操作整体提交或整体回滚。',categoryIds:['transactions'],tagIds:[]});await api('/api/questions/review',{confirmed:true,ids:[question.id],action:'approve',expectedUpdatedAt:{[question.id]:question.updatedAt}});}
await api('/api/ai/settings',{enabled:true,baseUrl:'http://127.0.0.1:'+provider.address().port,model:'workspace-drafts-fixture',key:'fixture-only-placeholder',maxTokens:16384,timeoutSeconds:30,supportsImages:false,sendImages:false},'PUT');
const origin=await app.listen({host:'127.0.0.1',port:0});console.log('AI_WORKSPACE_DRAFTS_READY '+JSON.stringify({origin}));
process.on('SIGTERM',()=>void(async()=>{await app.close();await new Promise(done=>provider.close(()=>done()));process.exit(0);})());`;
const server=spawn(process.execPath,['--import','tsx','--input-type=module','-e',fixture],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='',browser,page;
server.stdout.on('data',value=>stdout+=value);server.stderr.on('data',value=>stderr=(stderr+value).slice(-15000));
const checks=[],errors=[],externalRequests=[];
try{
 let connection;for(let tick=0;tick<300;tick++){if(server.exitCode!==null)throw new Error(stderr);const line=stdout.split(/\r?\n/).find(value=>value.startsWith('AI_WORKSPACE_DRAFTS_READY '));if(line){connection=JSON.parse(line.slice('AI_WORKSPACE_DRAFTS_READY '.length));break;}await delay(100);}
 assert.ok(connection,stderr);const {origin}=connection;
 browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'zh-CN',reducedMotion:'reduce'});
 page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>void dialog.accept());
 await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin||['blob:','data:'].includes(url.protocol))return route.continue();externalRequests.push(url.origin);return route.abort();});
 const api=async(path,method='GET',data,expected=200)=>{const response=await context.request.fetch(origin+path,{method,...(data===undefined?{}:{data})});const text=await response.text();assert.equal(response.status(),expected,path+': '+text);return text?JSON.parse(text):null;};
 const drafts=(kind,contextId)=>api('/api/ai/workspace-drafts?'+new URLSearchParams({kind,...(contextId?{contextId}:{})}));
 const state=()=>api('/qa/workspace-drafts');
 const settle=async(run,label)=>{for(let tick=0;tick<150;tick++){const result=await run();if(result)return result;await delay(100);}assert.fail('Timed out: '+label);};
 const prompt=()=>page.getByLabel('AI组题要求',{exact:true});
 const recover=async(target=page)=>{const picker=target.getByRole('dialog',{name:'继续AI工作台草稿',exact:true});await picker.waitFor();await picker.getByRole('button',{name:'继续此草稿',exact:true}).first().click();await picker.waitFor({state:'hidden'});};
 const maybeRecover=async(readyLocator=prompt())=>{const picker=page.getByRole('dialog',{name:'继续AI工作台草稿',exact:true});await settle(async()=>await picker.isVisible()||await readyLocator.isVisible(),'draft choice or ready form');if(await picker.isVisible())await recover();};
 const save=async(scope=page)=>{await scope.getByRole('button',{name:'保存草稿',exact:true}).first().click();await settle(async()=>!await scope.getByRole('button',{name:'保存草稿',exact:true}).first().isDisabled(),'manual save settled');};
 const go=async(path)=>{await page.goto(origin+'/#/'+path);await page.waitForLoadState('networkidle');};
 const capture=async(name)=>{await settle(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'layout');await page.screenshot({path:resolve(folder,name+'.png'),fullPage:true});};

 await go('ai');await prompt().waitFor();await delay(1200);assert.equal((await drafts('paper')).length,0,'blank paper form should not create a draft');
 await prompt().fill('从已有题库推荐2道事务基础简答题，保留我的分组要求。');await page.getByLabel('推荐题量（组合题整组计）',{exact:true}).fill('2');
 const first=await settle(async()=>{const items=await drafts('paper');return items[0]?.state.prompt.includes('我的分组要求')?items[0]:null;},'paper input auto-save');
 await prompt().fill('从已有题库推荐2道事务基础简答题，最后一次输入。');await save();
 assert.equal((await drafts('paper')).length,1);assert.equal((await drafts('paper'))[0].id,first.id);checks.push('空白工作台不造草稿，推荐输入自动保存，手动保存覆盖同一ID');
 await page.getByRole('button',{name:'文件 / 文本辅助导入',exact:true}).click();await page.getByLabel('待转换文本',{exact:true}).waitFor();
 await page.getByRole('button',{name:'AI推荐组题',exact:true}).click();await maybeRecover();await prompt().waitFor();assert.match(await prompt().inputValue(),/最后一次输入/);
 await page.reload();await recover();await prompt().waitFor();assert.match(await prompt().inputValue(),/最后一次输入/);checks.push('切换工作台功能和刷新后可继续推荐草稿，最后输入不丢失');
 let releaseModel;let markModelStarted;const modelStarted=new Promise(done=>markModelStarted=done),modelBarrier=new Promise(done=>releaseModel=done);
 const holdModel=async route=>{markModelStarted();await modelBarrier;await route.continue();};await page.route('**/api/ai/paper-plan',holdModel);
 await page.getByRole('button',{name:'生成推荐组题预览',exact:true}).evaluate(button=>{button.click();button.click();});await modelStarted;await page.getByRole('button',{name:'AI处理记录',exact:true}).click();assert.ok(await prompt().isVisible(),'running recommendation should stay mounted');assert.equal(await page.getByRole('button',{name:'正在处理…',exact:true}).count(),1);releaseModel();
 await page.getByRole('button',{name:'确认创建题集',exact:true}).waitFor();await page.unroute('**/api/ai/paper-plan',holdModel);assert.equal((await state()).calls.filter(call=>call.kind==='paper').length,1);checks.push('快速连击只提交一次，处理中禁止切换工作台，避免请求中断与半成品预览写入');
 await page.getByLabel('题集名称',{exact:true}).fill('人工调整后保留的推荐题集');await page.getByLabel('覆盖与学习目标',{exact:true}).fill('不要覆盖我的预览调整。');
 const paperPreview=await settle(async()=>{const item=(await drafts('paper'))[0];return item.state.run&&item.state.title==='人工调整后保留的推荐题集'?item:null;},'paper preview saved');
 assert.equal(paperPreview.state.ids.length,2);await page.reload();await recover();await page.getByRole('button',{name:'确认创建题集',exact:true}).waitFor();
 assert.equal(await page.getByLabel('题集名称',{exact:true}).inputValue(),'人工调整后保留的推荐题集');assert.equal(await page.getByLabel('覆盖与学习目标',{exact:true}).inputValue(),'不要覆盖我的预览调整。');
 assert.equal((await state()).calls.filter(call=>call.kind==='paper').length,1,'restoring must not resubmit the model');checks.push('推荐预览与人工名称／目标修改恢复，恢复不会重新调用模型');
 await page.getByRole('button',{name:'确认创建题集',exact:true}).click();await page.waitForURL(/#\/papers\//);await go('ai');await maybeRecover();await prompt().waitFor();
 assert.equal(await page.getByRole('button',{name:'确认创建题集',exact:true}).count(),0);checks.push('确认创建题集后草稿不复活已应用的推荐预览');

 await page.getByRole('button',{name:'文件 / 文本辅助导入',exact:true}).click();await page.getByLabel('待转换文本',{exact:true}).fill('一组操作整体提交或回滚称为事务原子性。转账的扣款和入账应一起完成。');
 await page.getByLabel('来源名称',{exact:true}).fill('草稿验收教材');await page.getByLabel('处理方式',{exact:true}).selectOption('generate');await page.getByLabel('本批最多生成题量',{exact:true}).fill('2');
 await page.getByLabel('出题或整理要求',{exact:true}).fill('仅据上述材料生成概念题和应用题。');await page.getByRole('button',{name:'分析并生成结构化预览',exact:true}).click();await page.getByRole('button',{name:'确认新增到待审核',exact:true}).waitFor();
 await page.getByText('编辑完整题目结构 JSON',{exact:true}).click();const jsonField=page.getByLabel('AI转换题目JSON',{exact:true});const generated=JSON.parse(await jsonField.inputValue());assert.equal(generated.length,2);generated[0].title='人工核对后的导入预览';await jsonField.fill(JSON.stringify(generated));
 await page.locator('.ai-checkbox-list input[type=checkbox]').nth(1).uncheck();
 await page.getByLabel('处理方式',{exact:true}).selectOption('extract');assert.match(await jsonField.inputValue(),/人工核对后的导入预览/);await page.getByLabel('处理方式',{exact:true}).selectOption('generate');
 const inputBeforeBadFile=await page.getByLabel('待转换文本',{exact:true}).inputValue();await page.getByLabel('AI导入原始文件',{exact:true}).setInputFiles({name:'invalid-utf8.txt',mimeType:'text/plain',buffer:Buffer.from([0xff,0xfe,0xff])});await page.locator('.notice.error').waitFor();
 assert.equal(await page.getByLabel('待转换文本',{exact:true}).inputValue(),inputBeforeBadFile);assert.match(await jsonField.inputValue(),/人工核对后的导入预览/);assert.equal(await page.locator('.ai-checkbox-list input:checked').count(),1);checks.push('切换整理方式及读取无效文件失败后仍保留输入、上次预览与人工选择');await save();
 const importDraft=await settle(async()=>{const item=(await drafts('import'))[0];return item?.state.json.includes('人工核对后的导入预览')&&item.state.selected.length===1?item:null;},'import preview saved');
 await go('');await go('ai?tab=import');await recover();await page.getByRole('button',{name:'确认新增到待审核',exact:true}).waitFor();
 assert.equal(await page.getByLabel('来源名称',{exact:true}).inputValue(),'草稿验收教材');assert.match(await page.getByLabel('AI转换题目JSON',{exact:true}).inputValue(),/人工核对后的导入预览/);assert.equal(await page.locator('.ai-checkbox-list input:checked').count(),1);
 assert.equal((await drafts('import'))[0].id,importDraft.id);checks.push('普通导入保留文本、要求、处理方式、手改JSON及勾选，离开重入恢复同一草稿');
 await page.getByRole('button',{name:'确认新增到待审核',exact:true}).click();await settle(async()=>((await state()).questions.total===5),'import selected question');
 await page.getByLabel('出题或整理要求',{exact:true}).fill('完成导入后继续整理');await save();await page.reload();await maybeRecover(page.getByLabel('待转换文本',{exact:true}));await page.getByLabel('待转换文本',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'确认新增到待审核',exact:true}).count(),0);checks.push('导入只写入选中题且保持待审核，恢复不复活已导入预览');

 const conflictBase=(await drafts('import'))[0];await api('/api/ai/workspace-drafts/'+encodeURIComponent(conflictBase.id),'PUT',{expectedUpdatedAt:conflictBase.updatedAt,state:{...conflictBase.state,requirements:'另一个页面的新版本'}});
 await page.getByLabel('出题或整理要求',{exact:true}).fill('本页尚未保存的冲突分支');await page.getByRole('button',{name:'保存草稿',exact:true}).first().click();
 await page.getByText(/草稿.*(其他|变化|更新)|版本.*(冲突|变化)/).first().waitFor();assert.equal(await page.getByLabel('出题或整理要求',{exact:true}).inputValue(),'本页尚未保存的冲突分支');assert.equal((await drafts('import')).find(item=>item.id===conflictBase.id).state.requirements,'另一个页面的新版本');
 await page.getByRole('button',{name:'另存为新草稿',exact:true}).click();await settle(async()=>{const items=await drafts('import');return items.some(item=>item.id!==conflictBase.id&&item.state.requirements==='本页尚未保存的冲突分支');},'copy conflict branch');checks.push('双页面版本冲突保留本页输入且不覆盖远端，可另存为新草稿继续');
 await capture('import-preview-conflict-desktop');

 await page.getByRole('button',{name:'多文件 / 教材分批',exact:true}).click();await page.getByLabel('AI分批原始文件',{exact:true}).waitFor({state:'attached'});
 const files=[{name:'transactions.md',mimeType:'text/markdown',buffer:Buffer.from('# 事务\n事务操作整体提交或回滚。')},{name:'transfer.md',mimeType:'text/markdown',buffer:Buffer.from('# 转账\n扣款与入账应整体完成。')}];
 const callsBeforeFiles=(await state()).calls.length;await page.getByLabel('AI分批原始文件',{exact:true}).setInputFiles(files);await page.getByText(/已读取2份资料/).waitFor();await page.getByLabel('教材任务名称',{exact:true}).fill('恢复正文与任务参数');
 await page.getByLabel('分批出题要求',{exact:true}).fill('按两个章节各生成一题。');await page.getByLabel('每块最多题量',{exact:true}).fill('1');await page.getByLabel('整个任务最多题量',{exact:true}).fill('2');await save();
 const localDraft=await settle(async()=>{const item=(await drafts('documents'))[0];return item?.state.local?.sections.length===2?item:null;},'document extraction saved');assert.equal((await state()).calls.length,callsBeforeFiles);
 await page.reload();await recover();await page.getByLabel('教材任务名称',{exact:true}).waitFor();assert.equal(await page.getByLabel('教材任务名称',{exact:true}).inputValue(),'恢复正文与任务参数');assert.equal(await page.getByLabel('每块最多题量',{exact:true}).inputValue(),'1');assert.equal(await page.getByLabel('整个任务最多题量',{exact:true}).inputValue(),'2');assert.equal(await page.getByLabel('分批出题要求',{exact:true}).inputValue(),'按两个章节各生成一题。');
 assert.deepEqual((await drafts('documents'))[0].state.local.sections,localDraft.state.local.sections);checks.push('教材本机提取正文、文件来源和出题参数持久恢复，无需重新选择文件且不请求模型');
 await page.getByRole('button',{name:'创建可恢复教材任务',exact:true}).click();const jobRegion=page.getByRole('region',{name:'教材分批任务',exact:true});await jobRegion.waitFor();
 const jobId=(await state()).jobs.items[0].id;await jobRegion.getByRole('button',{name:'AI总结选中知识块',exact:true}).click();await settle(async()=>(await api('/api/ai/document-jobs/'+jobId)).plannedBlocks===2,'document block summaries');
 await jobRegion.getByRole('button',{name:/^为选中知识块生成题目/}).click();await settle(async()=>(await api('/api/ai/document-jobs/'+jobId)).questionCount===2,'document generated questions');
 const job=await api('/api/ai/document-jobs/'+jobId),firstBlock=job.blocks[0],lastBlock=job.blocks[1];const blockCard=jobRegion.locator('[data-document-block="'+firstBlock.id+'"]');await blockCard.getByRole('button',{name:/^展开知识块/}).click();await blockCard.getByText('编辑本块完整题目 JSON',{exact:true}).click();
 const blockJson=page.getByLabel('知识块 '+firstBlock.label+' 题目JSON',{exact:true}),blockQuestions=JSON.parse(await blockJson.inputValue());blockQuestions[0].title='保留手改的教材分块题';await blockJson.fill(JSON.stringify(blockQuestions));
 await jobRegion.getByRole('checkbox',{name:'选择知识块 '+lastBlock.label,exact:true}).uncheck();await save(jobRegion);const jobDraft=await settle(async()=>{const item=(await drafts('document-job',jobId))[0];return item?.state.edits[firstBlock.id]?.json.includes('保留手改')?item:null;},'document job edits saved');
 assert.equal(jobDraft.state.selected.length,1);await save(page.locator('.ai-document-workspace').getByLabel('AI工作台草稿',{exact:true}).first());
 await page.reload();await recover();await recover();await jobRegion.waitFor();
 await jobRegion.getByRole('button',{name:/^确认选中预览到待审核/}).waitFor();assert.equal(await jobRegion.getByRole('checkbox',{name:'选择知识块 '+lastBlock.label,exact:true}).isChecked(),false);
 await blockCard.getByRole('button',{name:/展开知识块|收起知识块/}).waitFor();if(!await blockJson.isVisible()){const expand=blockCard.getByRole('button',{name:/^展开知识块/});if(await expand.count())await expand.click();await blockCard.getByText('编辑本块完整题目 JSON',{exact:true}).click();}assert.match(await blockJson.inputValue(),/保留手改的教材分块题/);checks.push('已创建任务按权威数据重载，知识块勾选与手改JSON按任务恢复');
 const latestBlockQuestions=JSON.parse(await blockJson.inputValue());latestBlockQuestions[0].title='父草稿切换前最后输入';await blockJson.fill(JSON.stringify(latestBlockQuestions));
 const parentControls=page.locator('[data-draft-kind="documents"]');await parentControls.getByRole('button',{name:'新建草稿',exact:true}).click();await jobRegion.waitFor({state:'hidden'});
 assert.ok((await drafts('document-job',jobId)).some(item=>item.id===jobDraft.id&&item.state.edits[firstBlock.id].json.includes('父草稿切换前最后输入')),'parent draft switch must flush child before unmount');
 await parentControls.getByRole('button',{name:'切换草稿',exact:true}).click();await recover();await recover();await jobRegion.waitFor();
 await blockCard.getByRole('button',{name:/展开知识块|收起知识块/}).waitFor();if(!await blockJson.isVisible()){const expand=blockCard.getByRole('button',{name:/^展开知识块/});if(await expand.count())await expand.click();await blockCard.getByText('编辑本块完整题目 JSON',{exact:true}).click();}assert.match(await blockJson.inputValue(),/父草稿切换前最后输入/);checks.push('父级新建与切换草稿先保存子任务最后输入，重开可恢复同一任务编辑');
 await jobRegion.getByRole('button',{name:/^确认选中预览到待审核/}).click();await settle(async()=>(await api('/api/ai/document-jobs/'+jobId)).importedCount===1,'document edited import');assert.ok((await state()).questions.items.some(question=>question.title==='父草稿切换前最后输入'));checks.push('恢复后的教材编辑可确认导入，已导入分块不可重复新增');

 for(let index=0;index<4;index++)await api('/api/ai/workspace-drafts','POST',{kind:'paper',contextId:null,state:{prompt:'保留数量验收'+index}},201);
 const recent=await drafts('paper');assert.equal(recent.length,3);assert.deepEqual(recent.map(item=>item.state.prompt),['保留数量验收3','保留数量验收2','保留数量验收1']);checks.push('同类最多保留最近三份草稿，按更新时间排序');
 await settle(async()=>!await jobRegion.getByRole('button',{name:'刷新',exact:true}).isDisabled(),'document import finished');await page.getByRole('link',{name:'AI工作台',exact:true}).click();await page.waitForURL(/#\/ai$/);
 const initialPicker=page.getByRole('dialog',{name:'继续AI工作台草稿',exact:true});await initialPicker.waitFor();await initialPicker.getByRole('button',{name:'关闭',exact:true}).click();await prompt().waitFor();assert.equal(await prompt().inputValue(),'');assert.deepEqual((await drafts('paper')).map(item=>item.id),recent.map(item=>item.id));
 await page.getByRole('button',{name:'切换草稿',exact:true}).click();await recover();await prompt().waitFor();assert.equal(await prompt().inputValue(),'保留数量验收3');checks.push('初次关闭恢复弹窗进入空白工作，不删除旧草稿，仍可重新选择恢复');
 await page.setViewportSize({width:390,height:844});await capture('workspace-draft-mobile');await page.getByRole('button',{name:'切换草稿',exact:true}).first().click();await page.getByRole('dialog',{name:'继续AI工作台草稿',exact:true}).waitFor();await capture('workspace-draft-picker-mobile');await page.getByRole('dialog',{name:'继续AI工作台草稿',exact:true}).getByRole('button',{name:'关闭',exact:true}).click();assert.equal(await prompt().inputValue(),'保留数量验收3');checks.push('390px草稿操作区和恢复弹窗无溢出，已有会话关闭选择不会清空当前输入');
 assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[]);checks.push('浏览器零未捕获异常和外部请求，所有草稿及题目写入隔离内存库');
 const report={passed:checks.length,checks,errors,externalRequests,database:':memory:',provider:'deterministic-loopback'};await writeFile(resolve(folder,'report.json'),JSON.stringify(report,null,2)+'\n');await rm(resolve(folder,'failure.json'),{force:true});console.log(JSON.stringify(report));
}catch(error){await page?.screenshot({path:resolve(folder,'failure.png'),fullPage:true}).catch(()=>undefined);await writeFile(resolve(folder,'failure.json'),JSON.stringify({error:String(error.stack||error),checks,errors,externalRequests,stderr},null,2)+'\n');throw error;}
finally{await browser?.close();server.kill('SIGTERM');if(server.exitCode===null)await Promise.race([new Promise(done=>server.once('exit',done)),delay(3000)]);if(server.exitCode===null)server.kill('SIGKILL');}
