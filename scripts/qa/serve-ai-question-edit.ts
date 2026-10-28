/** Actual routes, disposable records and a deterministic loopback model. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {buildApp} from '../../server/index.js';

const app=await buildApp({databasePath:':memory:',seedPath:'missing-ai-edit-fixture',staticRoot:resolve('dist/web'),logger:false,dailyPushScheduler:false});
const requests:Array<{requirements:string;material:unknown;task:string;success:boolean}>=[];
let attemptId='';
app.get('/qa/ai-question-edit',async()=>({requests,questions:await api('/api/questions?status=all&pageSize=100'),issues:await api('/api/content-quality/issues?status=all&pageSize=100'),runs:await api('/api/ai/runs?page=1&pageSize=100'),attempt:await api('/api/attempts/'+attemptId),study:(await api('/api/questions/EDIT-S')).study}));
const provider=createServer(async(request,response)=>{
 try{
  const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
  const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const content=body.messages[1].content,input=JSON.parse(typeof content==='string'?content:content[0].text),material=input.untrustedMaterial;
  const requirements=String(material.requirements||''),question=material.question||material.draft||{};
  const failed=requirements.includes('QA_FAIL');requests.push({requirements,material,task:input.task,success:!failed});
  if(requirements.includes('QA_SLOW'))await new Promise(done=>setTimeout(done,2200));
  if(requirements.includes('QA_VERSION'))await new Promise(done=>setTimeout(done,1200));
  if(response.destroyed)return;
  if(failed){response.writeHead(503,{'Content-Type':'application/json',Connection:'close'});response.end(JSON.stringify({error:{message:'PRIVATE_EDIT_PROVIDER_BODY sk-qa-private-canary'}}));return;}
  const suggestion=(id:string,title:string,changes:unknown,partId?:string)=>({id,title,reason:'根据当前题面、参考答案及已提供的质量问题逐项核对。',confidence:'high',...(partId?{partId}:{}),changes});
  const suggestions=question.type==='group'?[
   suggestion('g-material','明确公共材料',{stemMarkdown:'阅读事务材料，分别核对整体提交、回滚和并发可见性。'}),
   suggestion('g-part','完善原子性小题',{answerMarkdown:'原子性要求一组操作整体提交或整体回滚。',explanationMarkdown:'失败时撤销本次事务中尚未提交的全部变更。'},'p1'),
   suggestion('g-choice','同步修正小题选项和答案',{options:[{key:'A',text:'全部成功才提交，否则整体回滚。'},{key:'B',text:'允许扣款成功而入账失败。'}],correctAnswers:['A'],answerMarkdown:'A。扣款与入账必须共同完成。'},'p2'),
  ]:[
   suggestion('s-stem','明确题干条件',{stemMarkdown:'明确修订：按事务整体性选择正确描述。'}),
   suggestion('s-answer','修正参考答案与判分键',{...(String(question.type).includes('choice')?{correctAnswers:['A']}:{}),answerMarkdown:'A。事务操作必须整体提交或整体回滚。'}),
   suggestion('s-explanation','补充解析边界',{explanationMarkdown:'原子性约束事务整体结果，不能留下部分提交。隔离性约束并发事务之间的可见性。'}),
   suggestion('s-taxonomy','调整分类和标签',{categoryIds:['edit-db'],tagIds:['edit-atomicity']}),
   suggestion('s-title','改进题目标题',{title:'事务整体提交与回滚'}),
  ];
  if(requirements.includes('QA_INVALID'))suggestions[0].changes={status:'published'};
  if(requirements.includes('QA_BAD_TAG'))suggestions[0].changes={tagIds:['not-a-real-tag']};
  const result={summary:'发现可分别核对的题干、参考解答、说明与知识归属建议。',suggestions,warnings:[]};
  response.writeHead(200,{'Content-Type':'application/json',Connection:'close'});response.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}));
 }catch{if(!response.destroyed){response.writeHead(400,{'Content-Type':'application/json',Connection:'close'});response.end('{}');}}
});
await new Promise<void>(done=>provider.listen(0,'127.0.0.1',done));
async function api(url:string,payload?:unknown,method:any=payload===undefined?'GET':'POST'){
 const response=await app.inject({url,method,...(payload===undefined?{}:{payload})});assert.ok(response.statusCode<400,`${url}: ${response.statusCode} ${response.body.slice(0,300)}`);return response.json();
}
await api('/api/domains',{id:'edit-computer',name:'计算机'});
await api('/api/categories',{id:'edit-basic',domainId:'edit-computer',name:'通用基础'});
await api('/api/categories',{id:'edit-db',domainId:'edit-computer',name:'数据库事务'});
await api('/api/tags',{id:'edit-foundation',name:'基础概念',domainId:'edit-computer'});
await api('/api/tags',{id:'edit-atomicity',name:'原子性',domainId:'edit-computer'});
let saved=await api('/api/questions',{id:'EDIT-S',title:'旧事务概念题',type:'single_choice',stemMarkdown:'学习说明：旧学习提示。\n\n事务允许部分操作独立提交吗？',options:[{key:'A',text:'必须整体提交或整体回滚。'},{key:'B',text:'允许部分提交。'}],correctAnswers:['B'],answerMarkdown:'B。可以部分提交。',explanationMarkdown:'旧解析需要核对。',categoryIds:['edit-basic'],tagIds:['edit-foundation'],sourceDocument:'PRIVATE_SOURCE_FILENAME_DO_NOT_SEND'});
await api('/api/questions/review',{ids:[saved.id],action:'approve',confirmed:true,expectedUpdatedAt:{[saved.id]:saved.updatedAt}});
await api('/api/study/EDIT-S',{notes:'PRIVATE_LEARNING_NOTE_DO_NOT_SEND'},'PUT');
const feedback=await api('/api/question-feedback',{questionId:'EDIT-S',kind:'answer',description:'请核对原子性的定义，以及题干中多余的学习说明。'});
await api(`/api/content-quality/issues/${feedback.qualityIssueId}/resolve`,{status:'confirmed',note:'PRIVATE_RESOLUTION_NOTE_DO_NOT_SEND',expectedUpdatedAt:(await api('/api/content-quality/issues/'+feedback.qualityIssueId)).issue.updatedAt});
const scan=await api('/api/content-quality/scans',{filters:{questionId:'EDIT-S'}});await api(`/api/content-quality/scans/${scan.id}/process`,{batchSize:1});
await api('/api/questions',{id:'EDIT-G',title:'事务组合材料',type:'group',stemMarkdown:'阅读扣款和入账的共同事务。',parts:[{id:'p1',title:'原子性小题',type:'short_answer',stemMarkdown:'说明原子性的含义。',answerMarkdown:'旧原子性说明。',explanationMarkdown:'旧小题说明。'},{id:'p2',title:'选择事务结果',type:'single_choice',stemMarkdown:'应选择哪种处理方式？',options:[{key:'A',text:'共同完成。'},{key:'B',text:'各自完成。'}],correctAnswers:['B'],answerMarkdown:'旧答案B。'}],categoryIds:['edit-basic']});
await api('/api/questions',{id:'EDIT-P',title:'待审编辑题',type:'short_answer',stemMarkdown:'解释当前事务概念。',answerMarkdown:'原待审答案。',categoryIds:['edit-basic']});
const paper=await api('/api/papers',{title:'编辑快照保护题集',mode:'manual',questionIds:['EDIT-S'],scoring:{enabled:false}}),attempt=await api(`/api/papers/${paper.id}/attempts`,{});
attemptId=attempt.id;
await api(`/api/attempts/${attempt.id}/submit`,{answers:{'EDIT-S':{value:'B'}}});
await api('/api/ai/settings',{enabled:true,baseUrl:`http://127.0.0.1:${(provider.address() as {port:number}).port}`,model:'question-edit-loopback',key:'qa-edit-placeholder',timeoutSeconds:30,maxTokens:4096,supportsImages:false,sendImages:false},'PUT');
console.log('AI_QUESTION_EDIT_READY '+JSON.stringify({origin:await app.listen({host:'127.0.0.1',port:0})}));
async function close(){await app.close();await new Promise<void>(done=>provider.close(()=>done()));process.exit(0);}process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
