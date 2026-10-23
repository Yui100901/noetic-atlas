import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Store } from '../../server/core/store.js';
import { ApiError } from '../../server/core/validation.js';
import { ensureSettings, getSettings } from '../../server/modules/settings/routes.js';
import { registerPaperDraftRoutes } from '../../server/modules/practice/paper-drafts.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';
import type { PaperDraftState } from '../../shared/practice/paper-drafts.js';
import { buildApp } from '../../server/index.js';

const initial = ():PaperDraftState=>({title:'组卷草稿',description:'面向下一轮复习',mode:'manual',organization:'other',domainId:'',questionIds:['Q1'],filters:{search:'',tagIds:[]},random:{tagIds:[],tagMode:'all',types:[],collection:'all',difficultyMin:1,difficultyMax:4,frequencyMin:0},count:20,enabled:true,total:7,objectivePercent:60,pointsByType:{...DEFAULT_SETTINGS.pointsByType},overrides:{Q1:7},autoTotal:false});
async function fixture(t:test.TestContext){
  const store=new Store(':memory:');ensureSettings(store);
  store.put('questions','Q1',{id:'Q1',title:'测试一',type:'short_answer',status:'published'});store.put('questions','Q2',{id:'Q2',title:'待审核',type:'short_answer',status:'pending'});
  const app=Fastify();app.setErrorHandler((error,_request,reply)=>{if(error instanceof ApiError)reply.code(error.status).send({error:{code:error.code,message:error.message}});else reply.code(500).send({error:{message:error.message}});});
  registerPaperDraftRoutes(app,store);t.after(async()=>{await app.close();store.db.close();});return {app,store};
}
function json(response:{statusCode:number;json():any},status=200){assert.equal(response.statusCode,status,JSON.stringify(response.json()));return response.json();}

test('authoring drafts preserve full form and score state, overwrite by version and reject stale tab writes',async t=>{
  const {app}=await fixture(t),state=initial();
  const created=json(await app.inject({method:'POST',url:'/api/paper-drafts',payload:{context:'new',state}}),201);
  assert.deepEqual(created.state,state);
  const updated=json(await app.inject({method:'PUT',url:`/api/paper-drafts/${created.id}`,payload:{expectedUpdatedAt:created.updatedAt,state:{...state,title:'继续整理',overrides:{Q1:8},total:8}}}));
  assert.equal(updated.id,created.id);assert.ok(updated.updatedAt>created.updatedAt);
  const stale=await app.inject({method:'PUT',url:`/api/paper-drafts/${created.id}`,payload:{expectedUpdatedAt:created.updatedAt,state}});assert.equal(stale.statusCode,409);assert.equal(stale.json().error.code,'PAPER_DRAFT_VERSION_CONFLICT');
  assert.equal(json(await app.inject('/api/paper-drafts?context=new'))[0].state.title,'继续整理');
});
test('authoring draft cap keeps latest drafts per context, supports configured cap and explicit removal',async t=>{
  const {app,store}=await fixture(t);const created:string[]=[];
  for(let index=0;index<5;index++)created.push(json(await app.inject({method:'POST',url:'/api/paper-drafts',payload:{context:'new',state:{...initial(),title:`第${index}份`}}}),201).id);
  json(await app.inject({method:'POST',url:'/api/paper-drafts',payload:{context:'paper-A',state:initial()}}),201);
  const drafts=json(await app.inject('/api/paper-drafts?context=new'));assert.equal(drafts.length,3);assert.deepEqual(drafts.map((draft:any)=>draft.id),created.slice(-3).reverse());assert.equal(json(await app.inject('/api/paper-drafts?context=paper-A')).length,1);
  store.put('settings','system',{...getSettings(store),maxPaperDrafts:1});const latest=json(await app.inject({method:'POST',url:'/api/paper-drafts',payload:{context:'new',state:initial()}}),201);
  assert.equal(json(await app.inject('/api/paper-drafts?context=new')).length,1);json(await app.inject({method:'DELETE',url:`/api/paper-drafts/${latest.id}`}));assert.deepEqual(json(await app.inject('/api/paper-drafts?context=new')),[]);
});
test('authoring draft validation rejects unpublished or absent references and malformed state atomically',async t=>{
  const {app}=await fixture(t);
  for(const state of [{...initial(),questionIds:['Q2']},{...initial(),questionIds:['missing']},{...initial(),questionIds:['Q1','Q1']},{...initial(),filters:{tagIds:['missing']}},{...initial(),random:{...initial().random,unknownKey:'arbitrary'}},{...initial(),overrides:{Q1:-3}}]){
    const response=await app.inject({method:'POST',url:'/api/paper-drafts',payload:{context:'new',state}});assert.ok([400,404].includes(response.statusCode),response.body);
  }
  assert.deepEqual(json(await app.inject('/api/paper-drafts')),[]);
});

test('bank deletion detaches authoring filters without losing chosen questions and invalidates stale tabs',async t=>{
  const app=await buildApp({databasePath:':memory:',seedPath:'missing-draft-bank-seed',staticRoot:'missing-draft-bank-static'});t.after(()=>app.close());
  json(await app.inject({method:'POST',url:'/api/import',payload:{mode:'merge',data:{schemaVersion:1,domains:[],categories:[],tags:[],questions:[{id:'Q1',title:'引用题目',type:'short_answer',stemMarkdown:'说明互斥。',status:'published'}],documents:[],papers:[]}}}));
  json(await app.inject({method:'POST',url:'/api/question-banks',payload:{id:'bank-A',name:'临时集合',questionIds:['Q1']}}),201);
  const state={...initial(),filters:{...initial().filters,bankId:'bank-A'},random:{...initial().random,bankId:'bank-A'}};
  const original=json(await app.inject({method:'POST',url:'/api/paper-drafts',payload:{context:'new',state}}),201);
  const deleted=json(await app.inject({method:'DELETE',url:'/api/question-banks/bank-A'}));assert.equal(deleted.detachedDrafts,1);
  const current=json(await app.inject('/api/paper-drafts?context=new'))[0];assert.deepEqual(current.state.questionIds,['Q1']);assert.equal(current.state.overrides.Q1,7);assert.equal(current.state.filters.bankId,'');assert.equal(current.state.random.bankId,'');assert.ok(current.updatedAt>original.updatedAt);
  assert.equal((await app.inject({method:'PUT',url:`/api/paper-drafts/${original.id}`,payload:{expectedUpdatedAt:original.updatedAt,state}})).statusCode,409);
});

test('complete migration preserves an authoring draft after its question is archived, rejects missing references atomically',async t=>{
  const make=async()=>{const app=await buildApp({databasePath:':memory:',seedPath:'missing-draft-migration-seed',staticRoot:'missing-draft-migration-static'});t.after(()=>app.close());return app;};
  const source=await make();json(await source.inject({method:'POST',url:'/api/import',payload:{mode:'merge',data:{schemaVersion:1,domains:[],categories:[],tags:[],questions:[{id:'Q1',title:'后续归档题',type:'short_answer',stemMarkdown:'解释互斥。',status:'published'},{id:'Q2',title:'未审核新题',type:'short_answer',stemMarkdown:'解释并发。',status:'pending'}],documents:[],papers:[]}}}));
  const draft=json(await source.inject({method:'POST',url:'/api/paper-drafts',payload:{context:'new',state:initial()}}),201);
  const question=json(await source.inject('/api/questions/Q1'));json(await source.inject({method:'PUT',url:'/api/questions/Q1',payload:{...question,status:'archived'}}));
  const continued=json(await source.inject({method:'PUT',url:`/api/paper-drafts/${draft.id}`,payload:{expectedUpdatedAt:draft.updatedAt,state:{...initial(),title:'保留归档题，稍后替换'}}}));assert.equal(continued.state.questionIds[0],'Q1');
  assert.equal((await source.inject({method:'POST',url:'/api/paper-drafts',payload:{context:'new',state:initial()}})).statusCode,400);
  assert.equal((await source.inject({method:'PUT',url:`/api/paper-drafts/${draft.id}`,payload:{expectedUpdatedAt:continued.updatedAt,state:{...continued.state,questionIds:['Q1','Q2']}}})).statusCode,400);
  const backup=json(await source.inject('/api/export'));assert.equal(backup.paperDrafts.length,1);const target=await make();json(await target.inject({method:'POST',url:'/api/import',payload:{mode:'merge',data:backup}}));assert.deepEqual(json(await target.inject('/api/paper-drafts')),backup.paperDrafts);assert.equal(json(await target.inject('/api/questions/Q1')).status,'archived');
  assert.equal((await target.inject({method:'DELETE',url:'/api/questions/Q1'})).statusCode,409);
  const invalid=structuredClone(backup);invalid.paperDrafts[0].state.filters.bankId='missing-bank';const empty=await make();const rejected=await empty.inject({method:'POST',url:'/api/import',payload:{mode:'merge',data:invalid}});assert.ok([400,404].includes(rejected.statusCode),rejected.body);assert.equal(json(await empty.inject('/api/questions?status=all')).total,0);assert.deepEqual(json(await empty.inject('/api/paper-drafts')),[]);
});

test('permanent paper deletion requires clearing its authoring drafts without dropping unrelated drafts',async t=>{
  const app=await buildApp({databasePath:':memory:',seedPath:'missing-draft-delete-paper-seed',staticRoot:'missing-draft-delete-paper-static'});t.after(()=>app.close());
  json(await app.inject({method:'POST',url:'/api/import',payload:{mode:'merge',data:{schemaVersion:1,domains:[],categories:[],tags:[],questions:[{id:'Q1',title:'组卷题',type:'short_answer',stemMarkdown:'解释互斥。',status:'published'}],documents:[],papers:[]}}}));
  const paper=json(await app.inject({method:'POST',url:'/api/papers',payload:{title:'待删除练习卷',mode:'manual',questionIds:['Q1'],scoring:{enabled:false}}}),201);
  const related=json(await app.inject({method:'POST',url:'/api/paper-drafts',payload:{context:paper.id,state:initial()}}),201);
  const unrelated=json(await app.inject({method:'POST',url:'/api/paper-drafts',payload:{context:'new',state:{...initial(),title:'其他草稿'}}}),201);
  const blocked=await app.inject({method:'DELETE',url:`/api/papers/${paper.id}?permanent=true`});assert.equal(blocked.statusCode,409);assert.equal(blocked.json().error.code,'PAPER_HAS_AUTHORING_DRAFTS');assert.equal(json(await app.inject(`/api/papers/${paper.id}`)).id,paper.id);
  json(await app.inject({method:'DELETE',url:`/api/paper-drafts/${related.id}`}));json(await app.inject({method:'DELETE',url:`/api/papers/${paper.id}?permanent=true`}));assert.equal((await app.inject(`/api/papers/${paper.id}`)).statusCode,404);assert.equal(json(await app.inject('/api/paper-drafts?context=new'))[0].id,unrelated.id);
});
