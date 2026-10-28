import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../../server/index.js';
import {Store} from '../../server/core/store.js';
import {exportData,importData} from '../../server/modules/transfer/migration.js';
import {exportShare} from '../../server/modules/sharing/routes.js';
import {questionSchema} from '../../server/core/validation.js';
import {aiWorkspaceDraftCreateSchema,aiWorkspaceDraftSchema} from '../../server/modules/ai/workspace-draft-schema.js';
import {AI_WORKSPACE_DRAFT_MAX_BYTES} from '../../shared/ai/workspace-drafts.js';
// @ts-expect-error portable release helper is deliberately plain JavaScript.
import {validatePublicData,createEmptyPublicData} from '../../scripts/release/validate-public-data.mjs';

const stamp='2026-10-28T00:00:00.000Z';
async function fixture(t:TestContext){
 const app=await buildApp({databasePath:':memory:',staticRoot:'no-ai-draft-assets',dailyPushScheduler:false});t.after(()=>app.close());
 const api=async(url:string,method:any='GET',payload?:unknown,status=200)=>{const response=await app.inject({url,method,...(payload===undefined?{}:{payload})});assert.equal(response.statusCode,status,response.body);return response.json();};
 const create=(kind='paper',state:Record<string,unknown>={prompt:'尚未完成的要求'},contextId:string|null=null)=>api('/api/ai/workspace-drafts','POST',{kind,contextId,state},201);
 return{app,api,create};
}
test('AI drafts save unfinished inputs and JSON without invoking the model or publishing content',async t=>{
 const {api,create}=await fixture(t);
 let draft=await create('import',{text:'私有待整理资料',sourceName:'教材',count:null,json:'[{"title":',selected:[0],difficulty:'',categoryIds:['already-deleted-id']});
 assert.equal((await api('/api/ai/workspace-drafts?kind=import'))[0].state.json,'[{"title":');
 const old=draft;draft=await api(`/api/ai/workspace-drafts/${draft.id}`,'PUT',{expectedUpdatedAt:draft.updatedAt,state:{...draft.state,text:'更新内容'}});
 assert.equal(draft.id,old.id);assert.notEqual(draft.updatedAt,old.updatedAt);assert.equal((await api(`/api/ai/workspace-drafts/${draft.id}`)).state.text,'更新内容');
 assert.deepEqual(await api('/api/ai/runs'),[]);assert.equal((await api('/api/questions')).total,0);assert.equal((await api('/api/papers')).length,0);
});
test('AI draft stale writes and deletion cannot overwrite another tab, and deleted drafts cannot revive',async t=>{
 const {api,create}=await fixture(t),first=await create();
 const newer=await api(`/api/ai/workspace-drafts/${first.id}`,'PUT',{expectedUpdatedAt:first.updatedAt,state:{prompt:'另一个页面'}});
 const conflict=await api(`/api/ai/workspace-drafts/${first.id}`,'PUT',{expectedUpdatedAt:first.updatedAt,state:{prompt:'旧页面'}},409);
 assert.equal(conflict.error.code,'AI_WORKSPACE_DRAFT_VERSION_CONFLICT');
 await api(`/api/ai/workspace-drafts/${first.id}`,'DELETE',{expectedUpdatedAt:first.updatedAt},409);
 assert.equal((await api(`/api/ai/workspace-drafts/${first.id}`)).state.prompt,'另一个页面');
 await api(`/api/ai/workspace-drafts/${first.id}`,'DELETE',{expectedUpdatedAt:newer.updatedAt});
 await api(`/api/ai/workspace-drafts/${first.id}`,'PUT',{expectedUpdatedAt:newer.updatedAt,state:{prompt:'不能复活'}},404);
});
test('retention keeps the newest three in each workspace and each document job, with indexed scoped reads',async t=>{
 const {api,create}=await fixture(t),ids:string[]=[];
 for(let i=0;i<5;i++)ids.push((await create('paper',{prompt:String(i)})).id);
 const importDraft=await create('import',{text:'其他工作台私有正文'});
 const jobA=await api('/api/ai/document-jobs','POST',{confirmed:true,sourceName:'任务A',sections:[{text:'教材基础概念'}]},201),jobB=await api('/api/ai/document-jobs','POST',{confirmed:true,sourceName:'任务B',sections:[{text:'另一个教材概念'}]},201);
 for(let i=0;i<5;i++)await create('document-job',{search:String(i)},jobA.id);
 const other=await create('document-job',{search:'不泄露给其他任务'},jobB.id);
 const paper=await api('/api/ai/workspace-drafts?kind=paper');assert.deepEqual(paper.map((d:any)=>d.id),ids.slice(2).reverse());
 assert.deepEqual((await api('/api/ai/workspace-drafts?kind=import')).map((d:any)=>d.id),[importDraft.id]);
 assert.deepEqual((await api('/api/ai/workspace-drafts?kind=document-job&contextId='+jobA.id)).map((d:any)=>d.state.search),['4','3','2']);
 assert.deepEqual((await api('/api/ai/workspace-drafts?kind=document-job&contextId='+jobB.id)).map((d:any)=>d.id),[other.id]);
 const store=new Store(':memory:');t.after(()=>store.db.close());
 const f=store.database.expressions.field.bind(store.database.expressions),plan=store.database.explain(store.database.query.selectFrom('ai_workspace_drafts').select('data').where(f('data','kind'),'=','paper').where(f('data','contextId'),'is',null).orderBy(f('data','updatedAt'),'desc').limit(3));
 assert.match(JSON.stringify(plan),/ai_workspace_drafts_context_updated_idx/);
});
test('draft scope and schema reject credentials, transient controls, unknown fields and non-JSON state',async t=>{
 const {api,create}=await fixture(t);
 await api('/api/ai/workspace-drafts','GET',undefined,400);await api('/api/ai/workspace-drafts?kind=document-job','GET',undefined,400);
 await api('/api/ai/workspace-drafts?kind=paper&contextId=job-a','GET',undefined,400);
 await api('/api/ai/workspace-drafts','POST',{kind:'paper',contextId:'job-a',state:{}},400);
 for(const state of [{apiKey:'SECRET'},{busy:true},{error:'trace'},{prompt:'x',unexpected:1},{run:{enabled:true,key:'SECRET'}},{filters:{baseUrl:'https://secret.invalid'}}])await api('/api/ai/workspace-drafts','POST',{kind:'paper',contextId:null,state},400);
 for(const value of [NaN,Infinity,undefined,()=>{},new Date()])assert.equal(aiWorkspaceDraftCreateSchema.safeParse({kind:'paper',contextId:null,state:{points:{q:value}}}).success,false);
 const draft=await create();await api(`/api/ai/workspace-drafts/${draft.id}`,'PUT',{expectedUpdatedAt:draft.updatedAt,state:{run:{key:'SECRET'}}},400);
 assert.equal((await api('/api/ai/workspace-drafts?kind=paper')).length,1);
});
test('draft body limits bound bytes and recursion while allowing extracted textbook text',()=>{
 const value={kind:'import',contextId:null,state:{text:'教'.repeat(1_000_000)}};assert.equal(aiWorkspaceDraftCreateSchema.safeParse(value).success,true);
 assert.equal(aiWorkspaceDraftCreateSchema.safeParse({...value,state:{text:'x'.repeat(AI_WORKSPACE_DRAFT_MAX_BYTES)}}).success,false);
 let nested:unknown='x';for(let i=0;i<30;i++)nested={next:nested};assert.equal(aiWorkspaceDraftCreateSchema.safeParse({...value,state:{run:nested}}).success,false);
});
test('completed preview snapshots allow reviewing but never supply credentials or authority to apply',async t=>{
 const {api,create}=await fixture(t),run={id:'missing-authoritative-run',kind:'paper_plan',status:'completed',createdAt:stamp,model:'local',warnings:[],questionIds:['q'],result:{title:'已完成预览',description:'目标',requestedCount:1,candidateCount:1,items:[{questionId:'q',reason:'基础概念'}],candidates:[{id:'q',title:'概念',type:'short_answer'}]}};
 const draft=await create('paper',{prompt:'复习',run,ids:['q'],title:'已修改标题',points:{q:null}});assert.deepEqual((await api(`/api/ai/workspace-drafts/${draft.id}`)).state.run,run);
 await api('/api/ai/runs/missing-authoritative-run/paper','POST',{confirmed:true,title:'不能凭草稿创建',questionIds:['q'],organization:'other'},404);
 assert.equal((await api('/api/papers')).length,0);
 for(const changed of [{...run,key:'SECRET'},{...run,_context:{secret:1}},{...run,status:'running'}])assert.equal(aiWorkspaceDraftSchema.safeParse({...draft,state:{run:changed}}).success,false);
});
test('complete JSON migration preserves AI drafts, skips same-ID conflicts and rejects invalid rows atomically',t=>{
 const source=new Store(':memory:'),target=new Store(':memory:');t.after(()=>{source.db.close();target.db.close();});
 const value={id:'private-ai-draft',kind:'document-job',contextId:'historical-job',state:{edits:{block:{json:'[{',selected:[0],baseQuestions:'[]',baseRunId:null}}},createdAt:stamp,updatedAt:stamp};source.put('ai_workspace_drafts',value.id,value);
 const exported=exportData(source);assert.deepEqual((exported as any).aiWorkspaceDrafts,[value]);importData(target,exported);assert.deepEqual(target.require('ai_workspace_drafts',value.id),value);
 target.put('ai_workspace_drafts',value.id,{...value,state:{search:'本机新版本'}});importData(target,exported);assert.equal(target.require<any>('ai_workspace_drafts',value.id).state.search,'本机新版本');
 const malformed={...exported,aiWorkspaceDrafts:[{...value,state:{apiKey:'PRIVATE'}}]};assert.throws(()=>importData(target,malformed));assert.equal(target.all('ai_workspace_drafts').length,1);
 const legacy:any={...exported};delete legacy.aiWorkspaceDrafts;const empty=new Store(':memory:');try{importData(empty,legacy);assert.deepEqual(empty.all('ai_workspace_drafts'),[]);}finally{empty.db.close();}
});
test('AI draft endpoints remain same-origin and are documented with versioned bodies',async t=>{
 const {api,app}=await fixture(t);const denied=await app.inject({url:'/api/ai/workspace-drafts',method:'POST',headers:{origin:'https://elsewhere.invalid'},payload:{kind:'paper',contextId:null,state:{prompt:'blocked'}}});assert.equal(denied.statusCode,403);
 const spec=await api('/api/openapi.json');assert.ok(spec.paths['/api/ai/workspace-drafts'].post.requestBody);assert.ok(spec.paths['/api/ai/workspace-drafts/{id}'].put.requestBody);assert.equal((await api('/api/ai/workspace-drafts?kind=paper')).length,0);
});
test('deleting a textbook task removes only its own drafts and rejects stale recreation',async t=>{
 const {api,create}=await fixture(t),job=await api('/api/ai/document-jobs','POST',{confirmed:true,sourceName:'临时教材',sections:[{text:'保存基础知识'}]},201);
 const draft=await create('document-job',{search:'待校订',edits:{}},job.id);await create('documents',{sourceName:'尚未创建的教材'});
 await api(`/api/ai/document-jobs/${job.id}`,'DELETE');assert.deepEqual(await api('/api/ai/workspace-drafts?kind=document-job&contextId='+job.id),[]);
 assert.equal((await api('/api/ai/workspace-drafts?kind=documents')).length,1);
 await api(`/api/ai/workspace-drafts/${draft.id}`,'PUT',{expectedUpdatedAt:draft.updatedAt,state:{search:'不能复活'}},404);
 await api('/api/ai/workspace-drafts','POST',{kind:'document-job',contextId:job.id,state:{search:'不能另存复活'}},404);
});
test('content sharing and clean-release validation never include private AI workspace drafts',t=>{
 const store=new Store(':memory:');t.after(()=>store.db.close());
 const question=questionSchema.parse({id:'public-q',title:'公开概念',type:'short_answer',stemMarkdown:'解释原子性',answerMarkdown:'全部成功或回滚',status:'published'});store.put('questions',question.id!,question);
 store.put('ai_workspace_drafts','private',{id:'private',kind:'paper',contextId:null,state:{prompt:'NEVER_EXPORT_AI_DRAFT'},createdAt:stamp,updatedAt:stamp});
 const shared=exportShare(store,{kind:'questions',ids:['public-q']});assert.equal(JSON.stringify(shared).includes('NEVER_EXPORT_AI_DRAFT'),false);assert.equal(Object.hasOwn(shared,'aiWorkspaceDrafts'),false);
 for(const key of ['aiWorkspaceDrafts','ai_workspace_drafts'])assert.throws(()=>validatePublicData({...createEmptyPublicData(),[key]:[{state:{prompt:'private'}}]}));
});
