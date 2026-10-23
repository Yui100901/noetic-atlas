/** Browser acceptance fixture: in-memory DB and a deterministic loopback model. */
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {buildApp} from '../../server/index.js';

const app=await buildApp({databasePath:':memory:',seedPath:resolve('test-results/no-ai-workflows-seed.json'),staticRoot:resolve('dist/web'),logger:false});
const requests:{kind:string;questionIds:string[]}[]=[];
let paperId='';const originalNotes='原始笔记：先理解，再用转账举例。';
app.get('/qa/ai-workflows',async()=>{
  const questions=await api('/api/questions?status=all&pageSize=200',undefined,'GET'),s1=await api('/api/questions/S1',undefined,'GET');
  return {paperId,originalNotes,totalQuestions:questions.total,questions:questions.items.map((q:any)=>({id:q.id,title:q.title,status:q.status})),notes:s1.study.notes,providerRequests:requests};
});
const provider=createServer(async(request,response)=>{
  try{
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
    const envelope=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const content=envelope.messages[1].content,input=JSON.parse(typeof content==='string'?content:content[0].text),material=input.untrustedMaterial;
    let result:unknown,kind:string,questionIds:string[]=[];
    if(input.task.includes('连通性测试')){kind='connection';result={ok:true,message:'本地确定模型连接成功'};}
    else if(input.outputSchema.items?.[0]?.reason){
      kind='paper_plan';questionIds=material.candidates.slice(0,material.requestedCount).map((q:any)=>q.id);
      result={title:'AI工作流验收推荐卷',description:'概念与应用递进',items:questionIds.map(questionId=>({questionId,reason:'覆盖事务基础与边界'}))};
    }else if(input.outputSchema.items?.[0]?.score){
      kind='grade';questionIds=material.items.map((item:any)=>item.questionId);
      result={items:material.items.map((item:any)=>({questionId:item.questionId,score:item.maxPoints==null?null:Math.round(item.maxPoints*80)/100,maxPoints:item.maxPoints,comment:'已理解事务的整体提交，建议结合失败恢复解释。',strengths:['说明了整体成功或回滚'],improvements:['补充失败恢复和隔离性的区别']}))};
    }else if(input.outputSchema.items?.[0]?.verdict){
      kind='review';questionIds=material.questions.map((q:any)=>q.id);
      result={items:material.questions.map((q:any)=>q.id==='BAD1'?{questionId:q.id,verdict:'needs_changes',issues:['通常整数算术中2+2=4，原答案错误。']}:{questionId:q.id,verdict:'valid',issues:[]})};
    }else if(input.outputSchema.questions){
      kind='import';result={questions:[{title:'AI转换的事务判断题',type:'true_false',stemMarkdown:'事务中的操作要么整体提交，要么整体回滚。',answerMarkdown:'正确。',explanationMarkdown:'此题由原始资料转换，须经用户确认与审核。',correctAnswers:['true'],options:[],categoryIds:material.selectedCategoryIds||[],tagIds:material.selectedTagIds||[]}],taxonomySuggestions:{domains:[],categories:[],tags:[]}};
    }else{
      kind='explain';questionIds=[material.question.id];result={explanationMarkdown:'QA解释：事务原子性要求整组操作一起提交或回滚，不能留下转账只扣款未入账的中间结果。',followUpsMarkdown:'隔离性约束并发事务间的可见性，与原子性不同。',pitfallsMarkdown:'事务原子性不表示所有事务必须实际串行执行。'};
    }
    requests.push({kind,questionIds});response.writeHead(200,{'Content-Type':'application/json',Connection:'close'});response.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}));
  }catch{response.writeHead(400,{'Content-Type':'application/json'});response.end('{}');}
});
await new Promise<void>(done=>provider.listen(0,'127.0.0.1',done));
const providerPort=(provider.address() as {port:number}).port;
async function api(url:string,payload?:unknown,method:any='POST'){
  const response=await app.inject({method,url,...(payload===undefined?{}:{payload})});assert.ok(response.statusCode<400,`${url}: ${response.statusCode}`);return response.json();
}
await api('/api/domains',{id:'computer',name:'计算机'});await api('/api/categories',{id:'db',domainId:'computer',name:'数据库'});
for(const [id,title,type,status]of [['S1','说明事务原子性','short_answer','published'],['S2','解释事务隔离性','essay','published'],['O1','判断事务原子性','true_false','published'],['P1','正确的待审核事务题','short_answer','pending'],['BAD1','错误的待审核算术题','true_false','pending']]){
  const q=await api('/api/questions',{id,title,type,stemMarkdown:id==='BAD1'?'通常整数算术中2+2=5。':`${title}，并解释适用边界。`,answerMarkdown:id==='BAD1'?'正确，2+2=5。':'事务应整体提交或回滚；隔离性约束并发可见性。',explanationMarkdown:'QA通用知识材料。',categoryIds:['db'],tagIds:[],...(type==='true_false'?{correctAnswers:['true']}:{})});
  if(status==='published')await api('/api/questions/review',{confirmed:true,ids:[id],action:'approve',expectedUpdatedAt:{[id]:q.updatedAt}});
}
await api('/api/study/S1',{notes:originalNotes},'PUT');
const paper=await api('/api/papers',{title:'AI工作流混合验收卷',mode:'manual',questionIds:['S1','S2','O1'],scoring:{enabled:true,totalPoints:12,questionPoints:{S1:5,S2:5,O1:2}}});
paperId=paper.id;
await api('/api/ai/settings',{enabled:true,baseUrl:`http://127.0.0.1:${providerPort}`,model:'deterministic-ai-workflows',key:'qa-only-placeholder',supportsImages:false,sendImages:false,timeoutSeconds:30,maxTokens:4096},'PUT');
const origin=await app.listen({host:'127.0.0.1',port:0});console.log('AI_WORKFLOWS_READY '+JSON.stringify({origin}));
async function close(){await app.close();await new Promise<void>(done=>provider.close(()=>done()));process.exit(0);}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
