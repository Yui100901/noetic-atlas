/** Optional live-provider acceptance. Credentials are read only from hidden stdin.
 * Run with a PTY: npx tsx scripts/qa/live-ai.ts. No configuration or transcript
 * is persisted. Every exercise uses generic questions in an in-memory DB. */
import Fastify from 'fastify';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import { Store, now } from '../../server/core/store.js';
import { registerAiRoutes } from '../../server/modules/ai/routes.js';
import { ApiError, parse, questionSchema } from '../../server/core/validation.js';
import { DEFAULT_AI_SETTINGS } from '../../shared/ai/ai.js';
import { buildPaper, createAttempt, submitAttempt } from '../../server/modules/practice/service.js';

async function hiddenInput():Promise<{baseUrl:string;model:string;key:string}> {
  if(!process.stdin.isTTY||!process.stdin.setRawMode)throw new Error('HIDDEN_TTY_REQUIRED');
  process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');process.stdin.resume();
  process.stdout.write('READY_FOR_HIDDEN_CONFIG\n');
  let line='';
  try{return await new Promise((resolve,reject)=>{const handle=(chunk:string)=>{if(chunk.includes('\u0003')){process.stdin.off('data',handle);reject(new Error('CANCELLED'));return;}line+=chunk;const end=line.search(/[\r\n]/);if(end>=0){process.stdin.off('data',handle);try{const value=JSON.parse(line.slice(0,end));if(typeof value.baseUrl!=='string'||typeof value.model!=='string'||typeof value.key!=='string')throw new Error('INVALID_CONFIG');resolve(value);}catch{reject(new Error('INVALID_CONFIG'));}}if(line.length>15000){process.stdin.off('data',handle);reject(new Error('CONFIG_TOO_LONG'));}};process.stdin.on('data',handle);});}finally{line='';process.stdin.pause();process.stdin.setRawMode(false);}
}
const safeCode=(code:unknown)=>typeof code==='string'&&/^[A-Z0-9_]{1,100}$/.test(code)?code:'FAILED';
let app:ReturnType<typeof Fastify>|undefined,store:Store|undefined;
const report:{name:string;ok:boolean;code?:string;httpStatus?:number;durationMs?:number;metrics?:Record<string,number|boolean>}[]=[];
let selectedModel='';
try {
  const config=await hiddenInput();const model=config.model;selectedModel=model;
  const endpoint=new URL(config.baseUrl);if(!['https:','http:'].includes(endpoint.protocol)||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw new Error('INVALID_ENDPOINT');endpoint.pathname=endpoint.pathname.replace(/\/(?:chat\/completions)?\/?$/,'')+'/models';
  try{const models=await fetch(endpoint,{headers:{Authorization:`Bearer ${config.key}`},signal:AbortSignal.timeout(30000)});if(!models.ok){process.stdout.write(JSON.stringify({name:'models',ok:false,httpStatus:models.status})+'\n');process.exitCode=1;}else{const result:any=await models.json();const ids=(Array.isArray(result.data)?result.data:[]).map((value:any)=>value.id).filter((id:any)=>typeof id==='string'&&/^[A-Za-z0-9_.:/-]{1,200}$/.test(id));if(!ids.includes(model)){process.stdout.write(JSON.stringify({name:'models',ok:false,code:'REQUESTED_MODEL_UNAVAILABLE',requestedModel:model,availableModels:ids})+'\n');process.exitCode=1;}else{process.stdout.write(JSON.stringify({name:'models',ok:true,model})+'\n');}}}catch{process.stdout.write(JSON.stringify({name:'models',ok:false,code:'MODEL_LOOKUP_FAILED'})+'\n');process.exitCode=1;}
  if(!process.exitCode){
    store=new Store(':memory:');store.put('domains','computer',{id:'computer',name:'计算机',description:'',sortOrder:0});store.put('categories','db',{id:'db',domainId:'computer',parentId:null,name:'数据库',description:'',sortOrder:0});
    const question=(id:string,changes={})=>parse(questionSchema,{id,title:'事务的原子性',type:'short_answer',stemMarkdown:'数据库事务的原子性是什么？请用转账说明。',answerMarkdown:'事务中的一组操作要么全部成功提交，要么全部回滚。转账扣款与入账属于同一事务，失败时二者一同撤销。',explanationMarkdown:'中途失败时需要恢复到事务开始前的一致状态。原子性本身不等于隔离性。',categoryIds:['db'],tagIds:[],status:'published',createdAt:now(),updatedAt:now(),...changes});
    store.put('questions','S1',question('S1'));
    store.put('questions','S2',question('S2',{title:'为什么原子性不等于隔离性',stemMarkdown:'解释原子性与隔离性的不同，并举例。',answerMarkdown:'原子性描述事务操作整体提交或回滚；隔离性描述并发事务之间的可见性和相互影响。转账操作一起完成或一起回滚属于原子性，另一个并发事务能读到什么状态属于隔离性。'}));
    store.put('questions','O1',question('O1',{title:'判断事务原子性',type:'true_false',stemMarkdown:'事务原子性表示事务内操作要么全部提交，要么全部回滚。',correctAnswers:['true'],answerMarkdown:'正确。'}));
    store.put('questions','P1',question('P1',{status:'pending'}));
    store.put('questions','BAD1',question('BAD1',{status:'pending',title:'明显错误的待审核判断题',type:'true_false',stemMarkdown:'在通常整数算术中，2+2=5。',correctAnswers:['true'],answerMarkdown:'正确，2+2=5。',explanationMarkdown:'两个物体加两个物体一共五个，所以此命题正确。'}));
    store.put('domains','chemistry',{id:'chemistry',name:'化学',description:'通用测试资料',sortOrder:1});
    store.put('categories','chem',{id:'chem',domainId:'chemistry',parentId:null,name:'化学基础',description:'',sortOrder:0});
    store.put('questions','CHEM1',question('CHEM1',{title:'水的分子式',categoryIds:['chem'],stemMarkdown:'水的分子式是什么？说明一个水分子的元素组成，并与过氧化氢区分。',answerMarkdown:'水的分子式为H2O，一个水分子含两个氢原子和一个氧原子。过氧化氢分子式为H2O2，两者不是同一种物质。',explanationMarkdown:'分子式描述不同元素原子的数量；水和过氧化氢组成比例不同。'}));
    const originalNotes='用户原始笔记：用转账理解事务边界。';store.put('study','S1',{...store.study('S1'),notes:originalNotes});
    app=Fastify({logger:false});app.setErrorHandler((err,_req,reply)=>err instanceof ApiError?reply.code(err.status).send({error:{code:err.code}}):reply.code(500).send({error:{code:'INTERNAL_ERROR'}}));registerAiRoutes(app,store);
    const api=async(path:string,payload:unknown,method:any='POST',expectedStatus?:number)=>{const response=await app!.inject({method,url:path,...(payload===undefined?{}:{payload})});if(expectedStatus!==undefined&&response.statusCode===expectedStatus)return response.json();if(response.statusCode<200||response.statusCode>=300||expectedStatus!==undefined){const error:any=new Error('API_ERROR');error.code=response.json()?.error?.code||'UNEXPECTED_HTTP_STATUS';error.httpStatus=response.statusCode;throw error;}return response.json();};
    const {hasKey:_hasKey,...defaults}=DEFAULT_AI_SETTINGS;await api('/api/ai/settings',{...defaults,enabled:true,baseUrl:config.baseUrl,model,key:config.key,timeoutSeconds:180,maxTokens:8192},'PUT');config.key='';
    const step=async(name:string,fn:()=>Promise<Record<string,number|boolean>|void>)=>{const start=Date.now();try{const metrics=await fn();const row={name,ok:true,durationMs:Date.now()-start,...(metrics?{metrics}:{})};report.push(row);process.stdout.write(JSON.stringify(row)+'\n');}catch(err:any){const row={name,ok:false,durationMs:Date.now()-start,code:safeCode(err.code||err.message),...(err.httpStatus?{httpStatus:err.httpStatus}:{})};report.push(row);process.stdout.write(JSON.stringify(row)+'\n');}};
    await step('connection',async()=>{assert.equal((await api('/api/ai/test',{})).ok,true);const settings=await api('/api/ai/settings',undefined,'GET');assert.equal(settings.hasKey,true);assert.ok(!('key' in settings));});
    await step('explain_and_note',async()=>{
      const run=await api('/api/ai/explain',{questionId:'S1'});assert.ok(run.result.explanationMarkdown.length>10);assert.equal(store!.study('S1').notes,originalNotes);
      await api(`/api/ai/runs/${run.id}/apply`,{confirmed:false,appendNotes:true},'POST',400);assert.equal(store!.study('S1').notes,originalNotes);
      await api(`/api/ai/runs/${run.id}/apply`,{confirmed:true,appendNotes:true});const notes=store!.study('S1').notes;assert.ok(notes.startsWith(originalNotes)&&notes.length>originalNotes.length);
      await api(`/api/ai/runs/${run.id}/apply`,{confirmed:true,appendNotes:true});assert.equal(store!.study('S1').notes,notes);return {originalNotesPreserved:true,repeatedApplyIsIdempotent:true};
    });
    await step('single_subjective_grade',async()=>{
      const good=await api('/api/ai/grade',{questionId:'S1',answer:'事务要么全部完成，要么都不生效；转账扣款与入账一起提交，事务失败时一起回滚。',maxPoints:5});
      const bad=await api('/api/ai/grade',{questionId:'S1',answer:'原子性就是允许操作只成功一半，扣款成功但入账失败也永远不需要回滚或撤销。',maxPoints:5});
      const goodScore=good.result.items[0].score,badScore=bad.result.items[0].score;assert.ok(Number.isFinite(goodScore)&&goodScore>=2.5&&goodScore<=5&&Number.isFinite(badScore)&&badScore>=0&&badScore<goodScore,'GRADING_DID_NOT_DISTINGUISH_CORRECTNESS');
      return {correctAnswerScore:goodScore,incorrectAnswerScore:badScore,maxPoints:5};
    });
    await step('paper_batch_grade_and_apply',async()=>{
      const paper=buildPaper(store!,{title:'通用数据库验收卷',description:'',mode:'manual',questionIds:['S1','S2','O1'],scoring:{enabled:true,questionPoints:{S1:5,S2:5,O1:2},totalPoints:12}});store!.put('papers',paper.id,paper);
      const attempt=createAttempt(store!,paper);submitAttempt(store!,attempt,{S1:{value:'事务内操作一起成功或回滚。'},S2:{value:'原子性是全部完成或全部撤销，隔离性是并发事务之间的可见性和相互影响。'},O1:{value:'true'}});
      const run=await api('/api/ai/grade',{attemptId:attempt.id,questionIds:['S1','S2']});assert.equal(run.result.items.length,2);assert.equal(store!.require<any>('attempts',attempt.id).subjectiveScore,0);
      await api(`/api/ai/runs/${run.id}/apply`,{confirmed:false,applyScores:true},'POST',400);assert.equal(store!.require<any>('attempts',attempt.id).subjectiveScore,0);
      const applied=await api(`/api/ai/runs/${run.id}/apply`,{confirmed:true,applyScores:true,appendNotes:true});const score=Math.round(run.result.items.reduce((sum:number,item:any)=>sum+item.score,0)*100)/100;
      assert.equal(applied.attempt.objectiveScore,2);assert.equal(applied.attempt.subjectiveScore,score);assert.equal(applied.attempt.totalScore,Math.round((score+2)*100)/100);assert.equal(applied.attempt.gradingStatus,'complete');
      const notes=store!.study('S1').notes,repeated=await api(`/api/ai/runs/${run.id}/apply`,{confirmed:true,applyScores:true,appendNotes:true});assert.equal(repeated.appliedScores.length,0);assert.equal(store!.study('S1').notes,notes);
      return {gradedSubjectiveItems:2,objectiveScoreUnchanged:2,subjectiveScore:score};
    });
    await step('text_import_and_pending_commit',async()=>{
      const count=store!.all('questions').length,run=await api('/api/ai/import',{text:'题目：事务的原子性表示一组操作要么全部提交，要么全部回滚。这一说法正确吗？答案：正确。解析：单个事务不能只保留部分更新。请仅转换这一道判断题，不扩写。',sourceName:'通用测试题',count:1,categoryIds:['db']});
      assert.equal(run.result.questions.length,1);assert.equal(store!.all('questions').length,count);await api(`/api/ai/runs/${run.id}/import`,{confirmed:false},'POST',400);assert.equal(store!.all('questions').length,count);
      const imported=await api(`/api/ai/runs/${run.id}/import`,{confirmed:true});assert.equal(imported.items[0].status,'pending');assert.equal(store!.all('questions').length,count+1);await api(`/api/ai/runs/${run.id}/import`,{confirmed:true},'POST',409);assert.equal(store!.all('questions').length,count+1);
      return {added:1,remainsPending:true,duplicateCommitBlocked:true};
    });
    await step('pending_review',async()=>{
      const good=store!.require<any>('questions','P1'),bad=store!.require<any>('questions','BAD1');const run=await api('/api/ai/review',{questionIds:['P1','BAD1'],autoApprove:true,expectedUpdatedAt:{P1:good.updatedAt,BAD1:bad.updatedAt}});
      const goodVerdict=run.result.items.find((item:any)=>item.questionId==='P1')?.verdict,badVerdict=run.result.items.find((item:any)=>item.questionId==='BAD1')?.verdict;
      assert.equal(goodVerdict,'valid','CORRECT_QUESTION_NOT_APPROVED');assert.equal(store!.require<any>('questions','P1').status,'published');assert.equal(badVerdict,'needs_changes','INCORRECT_QUESTION_APPROVED');assert.equal(store!.require<any>('questions','BAD1').status,'pending');assert.ok(!run.result.approvedIds.includes('BAD1'));
      return {correctQuestionPublished:true,incorrectQuestionRemainsPending:true};
    });
    await step('recommend_and_create_paper',async()=>{
      const count=store!.all('papers').length,run=await api('/api/ai/paper-plan',{prompt:'从基础概念到辨析，推荐2道数据库事务练习；不要新编题目。',count:2,filters:{categoryId:'db'}});assert.equal(run.result.items.length,2);assert.equal(new Set(run.result.items.map((item:any)=>item.questionId)).size,2);assert.equal(store!.all('papers').length,count);
      const input={title:run.result.title,description:run.result.description,questionIds:run.result.items.map((item:any)=>item.questionId),organization:'domain',domainId:'computer',scoring:{enabled:false}};
      await api(`/api/ai/runs/${run.id}/paper`,{...input,confirmed:false},'POST',400);assert.equal(store!.all('papers').length,count);const result=await api(`/api/ai/runs/${run.id}/paper`,{...input,confirmed:true});assert.equal(result.paper.questionCount,2);assert.equal(store!.all('papers').length,count+1);await api(`/api/ai/runs/${run.id}/paper`,{...input,confirmed:true},'POST',409);
      return {selectedExistingQuestions:2,explicitCreation:true};
    });
    await step('chemistry_explanation',async()=>{const run=await api('/api/ai/explain',{questionId:'CHEM1'});assert.ok(/H(?:2|₂)O/i.test(run.result.explanationMarkdown)&&/H(?:2|₂)O(?:2|₂)/i.test(run.result.explanationMarkdown),'CHEMISTRY_FORMULAS_NOT_DISTINGUISHED');return {nonComputerDomain:true,waterAndPeroxideDistinguished:true};});
    process.stdout.write(JSON.stringify({name:'summary',ok:report.every(row=>row.ok),model,passed:report.filter(row=>row.ok).length,total:report.length,storage:'memory-only'})+'\n');if(report.some(row=>!row.ok))process.exitCode=1;
  }
}catch(err:any){const row={name:'setup',ok:false,code:safeCode(err.message)};report.push(row);process.stdout.write(JSON.stringify(row)+'\n');process.exitCode=1;}finally{await app?.close();store?.db.close();await mkdir('test-results',{recursive:true});await writeFile('test-results/ai-live-acceptance.json',JSON.stringify({generatedAt:new Date().toISOString(),model:selectedModel,ok:!process.exitCode&&report.length===8&&report.every(row=>row.ok),passed:report.filter(row=>row.ok).length,total:report.length,storage:'memory-only',checks:report},null,2)+'\n');}
