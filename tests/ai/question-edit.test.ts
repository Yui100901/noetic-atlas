import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {createServer} from 'node:http';
import {Store,now,nextStamp} from '../../server/core/store.js';
import {ApiError,questionSchema} from '../../server/core/validation.js';
import {registerAiRoutes} from '../../server/modules/ai/routes.js';
import {createQuestionFeedback} from '../../server/modules/quality-feedback/service.js';
import {createQualityScan,processQualityScan,resolveQualityIssue} from '../../server/modules/content-quality/service.js';
import {buildApp} from '../../server/index.js';

const proposal=(changes:any,id='one',extra:any={})=>({id,title:'逐项修改建议',reason:'明确表述定义及适用条件。',confidence:'high',changes,...extra});
const output=(suggestions:any[])=>({summary:'核对当前草稿和相关质量记录。',suggestions,warnings:[]});
async function fixture(t:test.TestContext){
 const store=new Store(':memory:');
 for(const domain of ['cs','geo']){store.put('domains',domain,{id:domain,name:domain,description:'',sortOrder:0});store.put('categories',domain+'-cat',{id:domain+'-cat',name:domain,domainId:domain,parentId:null,description:'',sortOrder:0});store.put('tags',domain+'-tag',{id:domain+'-tag',name:domain,domainId:domain,kind:'topic',description:'',color:'#123456'});}
 const put=(id='Q',changes:any={})=>{const q=questionSchema.parse({id,title:'事务整体性',type:'short_answer',stemMarkdown:'解释事务原子性。',answerMarkdown:'全有或全无',categoryIds:['cs-cat'],tagIds:['cs-tag'],sourceDocument:'C:/PRIVATE_SOURCE_PATH',sourceAnchor:'PRIVATE_SOURCE_ANCHOR',createdAt:now(),updatedAt:now(),...changes});store.put('questions',id,q);return q;};put();
 store.putStudy({...store.study('Q'),notes:'PRIVATE_LEARNING_NOTE'});
 const requests:any[]=[],completions:any[]=[];let mode='json',handler:((material:any)=>any)=()=>output([proposal({explanationMarkdown:'全部操作成功提交，否则回滚。'})]);
 const provider=createServer(async(request,response)=>{let raw='';for await(const chunk of request)raw+=chunk;const completion=JSON.parse(raw),material=JSON.parse(completion.messages[1].content);requests.push(material);completions.push(completion);
  if(mode==='fail'){response.writeHead(503,{'Content-Type':'application/json'});response.end(JSON.stringify({error:{message:'PRIVATE_PROVIDER_SECRET'}}));return;}
  const result=await handler(material.untrustedMaterial);
  if(mode==='sse'&&completion.stream){response.writeHead(200,{'Content-Type':'text/event-stream'});response.write('data: '+JSON.stringify({choices:[{delta:{content:JSON.stringify(result)},finish_reason:null}]})+'\n\n');response.end('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');}
  else{response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}));}
 });await new Promise<void>(done=>provider.listen(0,'127.0.0.1',done));
 store.put('ai_settings','local',{enabled:true,baseUrl:`http://127.0.0.1:${(provider.address() as {port:number}).port}`,key:'PRIVATE_API_KEY',model:'edit-model',maxTokens:4096,timeoutSeconds:10,supportsImages:false,sendImages:false,updatedAt:now()});
 const app=Fastify();app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof ApiError?error.status:500).send({error:{code:error instanceof ApiError?error.code:'TEST_ERROR',message:error.message,details:error instanceof ApiError?error.details:undefined}}));registerAiRoutes(app,store);
 const draft=()=>{const {id,createdAt,updatedAt,...q}=store.require<any>('questions','Q');return q;};
 const body=(changes:any={})=>({questionId:'Q',expectedUpdatedAt:store.require<any>('questions','Q').updatedAt,question:draft(),...changes});
 const call=(changes:any={},headers:any={})=>app.inject({method:'POST',url:'/api/ai/question-edit',payload:body(changes),headers});
 t.after(async()=>{await app.close();store.database.close();provider.closeAllConnections();await new Promise<void>(done=>provider.close(()=>done()));});
 return{store,app,put,requests,completions,draft,body,call,mode:(value:string)=>mode=value,handler:(value:typeof handler)=>handler=value};
}

test('editing analysis uses the current unsaved draft, bounded provenance and independent suggestions without content writes',async t=>{
 const f=await fixture(t);const feedback=createQuestionFeedback(f.store,{questionId:'Q',kind:'answer',description:'核对定义完整性。'});const before=[f.store.all('questions'),f.store.all('quality_issues'),f.store.all('question_feedback'),f.store.all('study')];
 f.handler(material=>{assert.equal(material.question.stemMarkdown,'当前未保存的事务定义问题。');assert.ok(material.qualityIssues.some((issue:any)=>issue.id===feedback.qualityIssueId));assert.ok(material.qualityIssues.every((issue:any)=>issue.active&&issue.draftChangedSinceSaved));return output([proposal({stemMarkdown:'解释事务原子性及失败时的整体结果。'}),proposal({answerMarkdown:'原子性保证全部成功或全部回滚。'},'two'),proposal({categoryIds:['geo-cat'],tagIds:['geo-tag']},'three')]);});
 // Include an existing cross-domain label in the current candidate catalog.
 const q=f.draft();q.categoryIds=['cs-cat','geo-cat'];q.tagIds=['cs-tag'];
 const response=await f.call({question:{...q,stemMarkdown:'当前未保存的事务定义问题。'}});assert.equal(response.statusCode,200,response.body);const run=response.json();assert.equal(run.kind,'question_edit');assert.equal(run.status,'completed');assert.equal(run.result.suggestions.length,3);assert.ok(run.warnings.some((value:string)=>value.includes('草稿')));
 assert.deepEqual([f.store.all('questions'),f.store.all('quality_issues'),f.store.all('question_feedback'),f.store.all('study')],before);
 const sent=JSON.stringify(f.requests);for(const secret of ['PRIVATE_SOURCE_PATH','PRIVATE_SOURCE_ANCHOR','PRIVATE_LEARNING_NOTE','PRIVATE_API_KEY'])assert.ok(!sent.includes(secret));assert.equal(run._context,undefined);assert.ok(run.diagnostics.providerCalls===1);
 const history=await f.app.inject('/api/ai/runs?kind=question_edit');assert.equal(history.json().length,1);
 const wrongApply=await f.app.inject({method:'POST',url:'/api/ai/runs/'+run.id+'/apply',payload:{confirmed:true,appendNotes:true}});assert.equal(wrongApply.statusCode,400);assert.deepEqual(f.store.all('questions'),before[0]);
});

test('dependent objective changes are atomic and existing group parts and blanks remain valid',async t=>{
 const f=await fixture(t);
 f.put('Q',{type:'single_choice',options:[{key:'A',text:'整体提交'},{key:'B',text:'部分提交'}],correctAnswers:['B']});
 f.handler(()=>output([proposal({options:[{key:'A',text:'全部成功或全部回滚'},{key:'C',text:'允许部分结果'}],correctAnswers:['A']})]));assert.equal((await f.call()).statusCode,200);
 f.put('Q',{type:'group',options:[],correctAnswers:[],parts:[{id:'child',title:'解释原子性',type:'short_answer',stemMarkdown:'解释事务整体性。',answerMarkdown:'全有或全无'},{id:'blank',title:'填入术语',type:'fill_blank',stemMarkdown:'事务整体性叫____。',blanks:[{id:'term',label:'术语',answers:['原子性']}]}]});
 f.handler(()=>output([proposal({title:'说明整体失败时的结果',answerMarkdown:'任一操作失败，整体回滚。'},'child-edit',{partId:'child'}),proposal({blanks:[{id:'term',label:'术语',answers:['原子性','Atomicity'],caseSensitive:false,trim:true}]},'blank-edit',{partId:'blank'})]));const result=await f.call();assert.equal(result.statusCode,200,result.body);assert.equal(result.json().result.suggestions.length,2);assert.equal(f.store.require<any>('questions','Q').parts[0].title,'解释原子性');
});

test('invalid identities, state writes, references and independently invalid patches fail closed and retain safe failed audit',async t=>{
 const f=await fixture(t);const before=f.store.require('questions','Q');
 const bad=[proposal({status:'published'}),proposal({stemMarkdown:'改法'},'bad',{partId:'unknown'}),proposal({categoryIds:['missing']}),proposal({categoryIds:['geo-cat']}),proposal({options:[{key:'A',text:'a'},{key:'B',text:'b'}],correctAnswers:['A']}),proposal({})];
 for(const suggestion of bad){f.handler(()=>output([suggestion]));const response=await f.call();assert.equal(response.statusCode,502,response.body);assert.ok(response.json().error.code.startsWith('AI_'));assert.deepEqual(f.store.require('questions','Q'),before);}
 f.handler(()=>output([proposal({answerMarkdown:'一'}),proposal({answerMarkdown:'二'})]));assert.equal((await f.call()).statusCode,502);
 assert.equal(f.store.all<any>('ai_runs').filter(run=>run.status==='failed').length,bad.length+1);assert.ok(f.store.all<any>('ai_runs').every(run=>!run.result));
});

test('source version conflicts before and during analysis never publish stale suggestions or change original content',async t=>{
 const f=await fixture(t);const old=f.body();f.put('Q',{updatedAt:nextStamp(old.expectedUpdatedAt)});
 const pre=await f.call(old);assert.equal(pre.statusCode,409);assert.equal(f.requests.length,0);assert.deepEqual(f.store.all('ai_runs'),[]);
 const before=f.store.require<any>('questions','Q');f.handler(()=>{f.store.put('questions','Q',{...before,updatedAt:nextStamp(before.updatedAt),title:'其他页面改过'});return output([proposal({answerMarkdown:'定义修订。'})]);});
 const late=await f.call();assert.equal(late.statusCode,409);assert.equal(late.json().error.code,'AI_QUESTION_VERSION_CONFLICT');assert.equal(f.store.all<any>('ai_runs')[0].status,'failed');assert.equal(f.store.require<any>('questions','Q').title,'其他页面改过');
});

test('closed or stale quality evidence is marked as history and unresolved issues are prioritized without private notes',async t=>{
 const f=await fixture(t);f.put('Q',{sourceRefs:[{label:'占位来源',url:'https://example.org/source'}]});const scan=createQualityScan(f.store,{questionId:'Q',status:'all'});processQualityScan(f.store,scan.id,1);const scanIssue=f.store.all<any>('quality_issues')[0];resolveQualityIssue(f.store,scanIssue.id,{status:'resolved',note:'PRIVATE_QUALITY_DECISION',expectedUpdatedAt:scanIssue.updatedAt});
 const current=f.store.require<any>('questions','Q');f.store.put('questions','Q',{...current,stemMarkdown:'新的已保存表述。',updatedAt:nextStamp(current.updatedAt)});createQuestionFeedback(f.store,{questionId:'Q',kind:'answer',description:'新的用户反馈。'});
 const response=await f.call();assert.equal(response.statusCode,200,response.body);const context=f.requests[0].untrustedMaterial.qualityIssues;assert.equal(context[0].active,true);const closed=context.find((item:any)=>item.status==='resolved');assert.equal(closed.active,false);assert.equal(closed.sourceChanged,true);assert.ok(!JSON.stringify(context).includes('PRIVATE_QUALITY_DECISION'));
});

test('image omission is explicit and real SSE forwards status, deltas and only the complete validated result',async t=>{
 const f=await fixture(t);f.put('Q',{stemMarkdown:'观察图片 ![图](https://example.org/remote.png) 后解释。'});f.mode('sse');
 const response=await f.call({}, {accept:'text/event-stream'});assert.equal(response.statusCode,200);assert.ok(String(response.headers['content-type']).includes('text/event-stream'));
 const events=response.body.split('\n\n').filter(frame=>frame.startsWith('data: ')).map(frame=>JSON.parse(frame.slice(6)));
 // An established SSE stream reports upstream/validation failures as error
 // events with HTTP 200. Preserve strict forwarding checks, with safe evidence.
 const diagnostic=JSON.stringify({events:events.map(event=>event.type==='error'?{type:event.type,code:event.error?.code,message:event.error?.message}:{type:event.type}),providerStream:f.completions.map(value=>value.stream)});
 assert.deepEqual(events.filter(event=>event.type==='error'),[],diagnostic);assert.ok(events.some(event=>event.type==='status'),diagnostic);assert.ok(events.some(event=>event.type==='delta'),diagnostic);const result=events.find(event=>event.type==='result');assert.ok(result);assert.ok(result.result.warnings.some((value:string)=>value.includes('图')));assert.equal(f.completions[0].stream,true);
 assert.ok(!JSON.stringify(f.completions).includes('image_url'));assert.equal(f.store.all<any>('ai_runs').filter(run=>run.status==='completed').length,1);
});

test('provider failures are visible in question-edit history without private provider bodies or keys',async t=>{
 const f=await fixture(t);f.mode('fail');const before=f.store.require('questions','Q'),response=await f.call();assert.equal(response.statusCode,502);const runs=f.store.all<any>('ai_runs');assert.equal(runs.length,1);assert.equal(runs[0].kind,'question_edit');assert.equal(runs[0].status,'failed');assert.equal(runs[0].failure.code,'AI_PROVIDER_ERROR');assert.equal(runs[0].diagnostics.httpStatus,503);assert.deepEqual(f.store.require('questions','Q'),before);
 for(const secret of ['PRIVATE_PROVIDER_SECRET','PRIVATE_API_KEY'])assert.ok(!JSON.stringify([response.json(),runs]).includes(secret));
});

test('oversized drafts are rejected before provider calls without truncation or history material',async t=>{
 const f=await fixture(t),question=f.draft(),before=f.store.require('questions','Q');const response=await f.call({question:{...question,stemMarkdown:'题'.repeat(160_000)}});assert.equal(response.statusCode,413);assert.equal(response.json().error.code,'AI_EDIT_INPUT_TOO_LARGE');assert.equal(f.requests.length,0);assert.deepEqual(f.store.all('ai_runs'),[]);assert.deepEqual(f.store.require('questions','Q'),before);
});

test('question edit OpenAPI declares strict field patches, versioned input, safe results and SSE; active exams remain locked',async t=>{
 const app=await buildApp({databasePath:':memory:',seedPath:'no-edit-openapi-seed',staticRoot:'no-edit-web',native:true,dailyPushScheduler:false});t.after(()=>app.close());const response=await app.inject('/api/openapi.json');assert.equal(response.statusCode,200);const spec=response.json(),route=spec.paths['/api/ai/question-edit'].post,body=route.requestBody.content['application/json'].schema;assert.ok(body.required.includes('expectedUpdatedAt'));assert.ok(body.required.includes('question'));assert.equal(body.additionalProperties,false);assert.ok(route.responses[200].content['text/event-stream']);const suggestion=spec.components.schemas.AiQuestionEditResult.properties.suggestions;assert.equal(suggestion.maxItems,20);assert.equal(suggestion.items.properties.changes.additionalProperties,false);assert.ok(!suggestion.items.properties.changes.properties.status);assert.ok(spec.components.schemas.AiRun.oneOf[0].properties.kind.enum.includes('question_edit'));
 const api=async(url:string,payload:any)=>{const r=await app.inject({method:'POST',url,payload});assert.ok(r.statusCode<400,r.body);return r.json();};const q=await api('/api/questions',{id:'EXAM-EDIT',type:'short_answer',title:'考试题',stemMarkdown:'解释事务。',answerMarkdown:'整体性'});await api('/api/questions/review',{ids:[q.id],action:'approve',confirmed:true,expectedUpdatedAt:{[q.id]:q.updatedAt}});const paper=await api('/api/papers',{title:'锁定题集',mode:'manual',questionIds:[q.id],scoring:{enabled:false}});await api('/api/papers/'+paper.id+'/attempts',{mode:'exam',durationMinutes:1});const blocked=await app.inject({method:'POST',url:'/api/ai/question-edit',payload:{},headers:{accept:'text/event-stream'}});assert.equal(blocked.statusCode,409);assert.equal(blocked.json().error.code,'EXAM_ACTIVE');
});
