/** Synthetic startup profiling. Never opens the installation database. */
import assert from 'node:assert/strict';
import {mkdtemp,rm,rmdir,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {Store} from '../../server/core/store.js';
import {buildApp} from '../../server/index.js';
import {questionSchema} from '../../server/core/validation.js';
import {DEFAULT_SETTINGS} from '../../shared/models/settings.js';

const count=Number(process.env.STARTUP_SCALE_COUNT||30000),label=process.argv.includes('--baseline')?'baseline':'current';
assert.ok(Number.isInteger(count)&&count>=100&&count<=50000);
const folder=await mkdtemp(join(tmpdir(),'atlas-startup-scale-')),path=join(folder,'synthetic.sqlite'),output=resolve('test-results/startup-scale');await mkdir(output,{recursive:true});
const store=new Store(path),stamp='2026-10-28T00:00:00.000Z',seedAt=performance.now();
try{
 store.transaction(()=>{
  store.put('domains','computer',{id:'computer',name:'合成计算机领域',description:'',sortOrder:0});
  store.put('categories','basics',{id:'basics',name:'基础',domainId:'computer',parentId:null,description:'',sortOrder:0});
  store.put('tags','concept',{id:'concept',name:'概念',domainId:'computer',kind:'topic',description:'',color:'#39c5bb'});
  store.put('settings','system',structuredClone(DEFAULT_SETTINGS));
  const question=questionSchema.parse({id:'template',title:'合成基础概念',type:'short_answer',stemMarkdown:'说明并发事务的隔离性及边界。'.repeat(30),answerMarkdown:'隔离性约束事务并发执行时的可见性及相互影响。'.repeat(20),explanationMarkdown:'结合隔离级别与应用场景理解约束。'.repeat(20),categoryIds:['basics'],tagIds:['concept'],status:'published',createdAt:stamp,updatedAt:stamp});
  for(let index=0;index<count;index++)store.put('questions','STARTUP-'+index,{...question,id:'STARTUP-'+index,title:'合成基础概念 '+index});
 });
}finally{store.db.close();}
const seedMs=performance.now()-seedAt;
type Profile={allCalls:Record<string,{calls:number;rows:number;ms:number}>;getCalls:Record<string,number>;phases:Record<string,number>};
let current:Profile|undefined;
const all=Store.prototype.all,get=Store.prototype.get,normalize=Store.prototype.normalizeLegacyTags,validate=Store.prototype.validateTaxonomyReferences;
Store.prototype.all=function(table:any){const start=performance.now(),value=all.call(this,table);if(current){const item=current.allCalls[table]||={calls:0,rows:0,ms:0};item.calls++;item.rows+=value.length;item.ms+=performance.now()-start;}return value;};
Store.prototype.get=function(table:any,id:string){if(current)current.getCalls[table]=(current.getCalls[table]||0)+1;return get.call(this,table,id);};
Store.prototype.normalizeLegacyTags=function(){const start=performance.now();try{return normalize.call(this);}finally{if(current)current.phases.normalizeLegacyTags=performance.now()-start;}};
Store.prototype.validateTaxonomyReferences=function(){const start=performance.now();try{return validate.call(this);}finally{if(current)current.phases.validateTaxonomyReferences=performance.now()-start;}};
try{
 const runs=[];
 for(let index=0;index<3;index++){
  current={allCalls:{},getCalls:{},phases:{}};const started=performance.now();
  const app=await buildApp({databasePath:path,seedPath:'no-startup-scale-seed',staticRoot:'missing-startup-scale-assets',dailyPushScheduler:false,logger:false});
  const buildAppMs=performance.now()-started,profile=structuredClone(current);current=undefined;
  try{
   const healthAt=performance.now(),health=await app.inject('/api/health');assert.equal(health.statusCode,200);const healthMs=performance.now()-healthAt;
   const firstAt=performance.now(),bootstrap=await app.inject('/api/bootstrap');assert.equal(bootstrap.statusCode,200);assert.equal(bootstrap.json().stats.totalQuestions,count);const firstBootstrapMs=performance.now()-firstAt;
   const nextAt=performance.now(),next=await app.inject('/api/bootstrap');assert.equal(next.statusCode,200);const warmBootstrapMs=performance.now()-nextAt;
   runs.push({kind:index===0?'freshly_seeded':'clean_reopen',buildAppMs,healthMs,firstBootstrapMs,warmBootstrapMs,bootstrapBytes:Buffer.byteLength(bootstrap.body),profile});
  }finally{await app.close();}
 }
 const report={label,isolated:true,questions:count,seedMs,runs,note:'Synthetic file-backed SQLite timings after code import; first run includes pending read/search projection refresh. No real work data. Run without builds/full tests for comparable timings.'};
 await writeFile(join(output,label+'.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{
 Store.prototype.all=all;Store.prototype.get=get;Store.prototype.normalizeLegacyTags=normalize;Store.prototype.validateTaxonomyReferences=validate;
 // Only exact files created in this unique temporary directory are removed.
 await rm(path,{force:true});await rm(path+'-journal',{force:true});await rmdir(folder);
}
