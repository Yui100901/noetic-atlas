/** Disposable browser fixture. Never opens or writes the user's database. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from '../../server/index.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';

assert.equal(process.env.SMOKE_ISOLATED, '1', 'General platform QA requires explicit isolation.');
const root=resolve(import.meta.dirname,'../..');
const absent=resolve(root,'test-results/general-platform/no-fixture-seed.json');
assert.equal(existsSync(absent),false,'Fixture seed path must remain absent.');
assert.ok(existsSync(resolve(root,'dist/web/index.html')),'Build the web app before running this QA.');
const app=await buildApp({databasePath:':memory:',seedPath:absent,staticRoot:resolve(root,'dist/web')});
async function api(url:string,method:'GET'|'POST'|'PUT'='GET',payload?:unknown){
 const response=await app.inject({method,url,...(payload===undefined?{}:{payload})});
 assert.ok(response.statusCode<400,`${url}: ${response.statusCode} ${response.body.slice(0,400)}`);
 return response.json();
}
try{
 const stamp='2026-10-23T00:00:00.000Z';
 const questions=Array.from({length:40},(_,index)=>{
  const type=index<6?'short_answer':index%3===0?'short_answer':index%3===1?'single_choice':'true_false';
  return {id:`GP-Q${String(index).padStart(2,'0')}`,title:`${index<30?'通用':'个人'}概念${String(index).padStart(2,'0')}`,type,stemMarkdown:`概念题干 ${index}：请辨析接口与实现的关系。`,answerMarkdown:'接口规定可使用的操作与契约，实现说明具体怎样完成。',explanationMarkdown:'使用者依赖清楚的契约；同一接口可有不同实现。',options:type==='single_choice'?[{key:'A',text:'接口描述约定'},{key:'B',text:'接口总是唯一实现'}]:[],correctAnswers:type==='single_choice'?['A']:type==='true_false'?['true']:[],difficulty:2,depth:2,frequency:3,collection:index<30?'general':'personal',status:'published',categoryIds:['gp-basics'],tagIds:['gp-concept'],resumePriority:'P0',createdAt:stamp,updatedAt:stamp};
 });
 const legacyState={title:'旧草稿恢复验收',description:'恢复原顺序与分值',mode:'manual',organization:'other',domainId:'',questionIds:['GP-Q01','GP-Q00'],filters:{collection:'all',priority:'P0'},random:{collection:'all',tagIds:[],tagMode:'all',types:[],priority:'P1'},count:4,enabled:true,total:13,objectivePercent:60,pointsByType:{...DEFAULT_SETTINGS.pointsByType},overrides:{'GP-Q00':8,'GP-Q01':5},autoTotal:true};
 await api('/api/import','POST',{mode:'merge',data:{schemaVersion:1,domains:[{id:'gp-computing',name:'计算机学习',description:'隔离测试领域',sortOrder:0}],categories:[{id:'gp-basics',name:'通用基础',domainId:'gp-computing',parentId:null,description:'概念与示例',sortOrder:0}],tags:[{id:'gp-concept',name:'概念辨析',domainId:'gp-computing',kind:'topic',color:'#5264db',description:'隔离验收标签'}],questions,documents:[],papers:[],paperDrafts:[{id:'gp-legacy-draft',context:'new',createdAt:stamp,updatedAt:stamp,state:legacyState}]}});
 const drafts=await api('/api/paper-drafts?context=new');
 assert.equal(drafts.length,1);assert.equal(Object.hasOwn(drafts[0].state.filters,'priority'),false);assert.equal(Object.hasOwn(drafts[0].state.random,'priority'),false);
 assert.equal((await api('/api/questions?collection=personal&pageSize=200')).total,10);
 assert.equal(Object.hasOwn((await api('/api/questions/GP-Q00')),'resumePriority'),false);
 const settings=await api('/api/settings');await api('/api/settings','PUT',{settings:{...settings,autosaveDebounceMs:10000}});
 // Register before readiness so each run has an ephemeral unguessable port.
 // The marker carries only non-sensitive fixture facts.
 const origin=await app.listen({host:'127.0.0.1',port:0});
 console.log('GENERAL_PLATFORM_READY '+JSON.stringify({origin,total:40,personal:10,draftId:'gp-legacy-draft',isolatedDatabase:true}));
}catch(error){await app.close();throw error;}
let closing=false;const close=async()=>{if(closing)return;closing=true;await app.close();process.exit(0);};
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());process.on('disconnect',()=>void close());
