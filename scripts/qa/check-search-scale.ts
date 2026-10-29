/** Reproducible synthetic search comparison. Never opens an installation DB. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {Store} from '../../server/core/store.js';
import {questionSchema} from '../../server/core/validation.js';
import {searchQuerySchema} from '../../server/modules/search/schema.js';
import {unifiedSearch} from '../../server/modules/search/service.js';
import {baselineUnifiedSearch} from './search-scale-baseline.js';

const count=Number(process.env.SEARCH_SCALE_COUNT||30000),rounds=Number(process.env.SEARCH_SCALE_ROUNDS||5);
assert.ok(Number.isSafeInteger(count)&&count>=1000&&count<=60000);
assert.ok(Number.isSafeInteger(rounds)&&rounds>=1&&rounds<=10);
const store=new Store(':memory:'),output=resolve('test-results/search-scale');await mkdir(output,{recursive:true});
const stamp='2026-10-28T00:00:00.000Z';
try{
 const seedAt=performance.now();
 const template=questionSchema.parse({id:'SCALE-TEMPLATE',title:'synthetic',type:'short_answer',stemMarkdown:'SCALE synthetic learning material.',answerMarkdown:'REFERENCE_ONLY_CANARY atomic rollback reference.',status:'published',categoryIds:['scale-category'],tagIds:[]});
 store.transaction(()=>{
  store.put('domains','scale-domain',{id:'scale-domain',name:'SCALE共同领域',description:'合成测试',sortOrder:0});
  store.put('categories','scale-category',{id:'scale-category',name:'SCALE共同分类',domainId:'scale-domain',parentId:null,description:'分类',sortOrder:0});
  store.put('tags','scale-tag',{id:'scale-tag',name:'SCALE共同标签',domainId:null,kind:'topic',description:'标签',color:'#66CCFF'});
  for(let index=0;index<count;index++){
   const id='SCALE-Q-'+String(index).padStart(6,'0'),language=index%3;
   const title=language===0?'事务原子性 概念 '+index:language===1?'transaction rollback concept '+index:'取引の原子性 概念 '+index;
   store.put('questions',id,{...template,id,title,stemMarkdown:('SCALE common material: '+(language===0?'事务并发与隔离性，转账需要整体提交或回滚。':language===1?'A transaction changes data atomically; concurrency has an isolation boundary.':'取引は全体をコミットまたはロールバックします。')+'\n').repeat(10),status:index%20===0?'pending':'published',updatedAt:new Date(Date.parse(stamp)+index*1000).toISOString()});
   if(index%50===1)store.put('study',id,{questionId:id,notes:'SCALE common note: reason about atomicity without confusing isolation.',updatedAt:stamp});
  }
  for(let index=0;index<100;index++){
   store.put('papers','SCALE-P'+index,{id:'SCALE-P'+index,title:'SCALE common paper '+index,description:'Synthetic paper description',archived:false,domainId:'scale-domain',updatedAt:stamp});
   store.put('documents','SCALE-D'+index,{id:'SCALE-D'+index,title:'SCALE common document '+index,format:'markdown',bodyMarkdown:'SCALE common reading '+('transaction rollback reference material. '.repeat(30)),categoryIds:['scale-category'],updatedAt:stamp});
  }
 });
 const seedMs=performance.now()-seedAt,indexAt=performance.now();store.database.projections.search.ensure();const projectionRefreshMs=performance.now()-indexAt;
 const scenarios=[
  {name:'broad-all-types',input:{q:'scale'}},
  {name:'broad-selected-type',input:{q:'scale',type:'question'}},
  {name:'chinese-concept',input:{q:'事务'}},
  {name:'english-and',input:{q:'transaction rollback'}},
  {name:'japanese',input:{q:'取引'}},
  {name:'exact-id',input:{q:'SCALE-Q-000001'}},
  {name:'deep-page',input:{q:'scale',page:200}},
  {name:'reference-only',input:{q:'REFERENCE_ONLY_CANARY'}},
  {name:'empty-results-page',input:{q:'scale',type:'tag',page:20}},
  {name:'unicode-case-width',input:{q:'ＴＲＡＮＳＡＣＴＩＯＮ',sort:'updatedAt',includeUnpublished:'true'}},
 ];
 const original=store.database.all.bind(store.database),results=[];
 for(const scenario of scenarios){
  const input=searchQuerySchema.parse(scenario.input),before=baselineUnifiedSearch(store,input),after=unifiedSearch(store,input);
  assert.deepEqual(after,before,scenario.name+' contract changed');assert.doesNotMatch(JSON.stringify(after.items),/REFERENCE_ONLY_CANARY/);
  const sample=(fn:typeof unifiedSearch)=>{
   let returnedRows=0,metadataRows=0;
   store.database.all=((builder:any)=>{const rows=original(builder);returnedRows+=rows.length;metadataRows+=rows.filter(row=>typeof (row as any)?.data==='string').length;return rows;}) as typeof store.database.all;
   const started=performance.now();try{fn(store,input);}finally{store.database.all=original;}
   return{milliseconds:Number((performance.now()-started).toFixed(3)),returnedRows,metadataRows};
  };
  const previous=[],current=[];
  for(let index=0;index<rounds;index++){previous.push(sample(baselineUnifiedSearch));current.push(sample(unifiedSearch));}
  const stats=(items:typeof current)=>{const sorted=items.map(item=>item.milliseconds).sort((a,b)=>a-b);return{rounds:items.length,medianMs:sorted[Math.floor(sorted.length/2)],maxMs:sorted.at(-1),returnedRows:items[0].returnedRows,metadataRows:items[0].metadataRows};};
  results.push({scenario:scenario.name,input,total:after.total,totalAll:after.totalAll,items:after.items.length,responseBytes:Buffer.byteLength(JSON.stringify(after)),before:stats(previous),after:stats(current)});
 }
 const report={isolated:true,databasePath:':memory:',questionCount:count,seedMs:Number(seedMs.toFixed(3)),projectionRefreshMs:Number(projectionRefreshMs.toFixed(3)),scenarios:results,note:'Synthetic warm in-process query timings; baseline and optimized use identical data, matching semantics, results and projection. Cold indexing is reported separately. Not browser or production network latency.'};
 await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{store.db.close();}
