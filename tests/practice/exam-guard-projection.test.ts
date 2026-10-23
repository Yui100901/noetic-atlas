import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {Store} from '../../server/core/store.js';
import {DatabaseConnection} from '../../server/database/connection.js';
import {getActiveExam,getActiveExamId} from '../../server/modules/practice/service.js';
import {buildApp} from '../../server/index.js';

test('active exam ID and detail share predicates and earliest-session ordering while ID lookup projects no body',t=>{
 const store=new Store(':memory:');t.after(()=>store.db.close());
 assert.equal(getActiveExamId(store),undefined);assert.equal(getActiveExam(store),undefined);
 const padding='large historical question snapshot '.repeat(30000);
 for(const row of [
  {id:'practice',practiceMode:'practice',status:'in_progress',startedAt:'2020-01-01T00:00:00.000Z'},
  {id:'submitted',practiceMode:'exam',status:'submitted',startedAt:'2020-01-01T00:00:00.000Z'},
  {id:'later',practiceMode:'exam',status:'in_progress',startedAt:'2026-10-23T01:00:00.000Z'},
  {id:'earliest',practiceMode:'exam',status:'in_progress',startedAt:'2026-10-22T01:00:00.000Z'},
 ])store.put('attempts',row.id,{...row,questions:[{id:'large',answerMarkdown:padding}]});
 const original=store.database.one.bind(store.database);const observed:{sql:string;keys:string[]}[]=[];
 store.database.one=((builder:any)=>{const row=original(builder);observed.push({sql:builder.compile().sql,keys:Object.keys(row||{})});return row;}) as typeof store.database.one;
 assert.equal(getActiveExamId(store),'earliest');
 assert.deepEqual(observed[0]?.keys,['id']);assert.match(observed[0]!.sql,/^select "id" from "attempts" /);
 const detail=getActiveExam(store);assert.equal(detail?.id,'earliest');assert.equal(detail?.questions[0]?.answerMarkdown,padding);
 assert.deepEqual(observed[1]?.keys,['data']);
 // Selection, order and limit are shared; projection is the only SQL difference.
 assert.equal(observed[0]!.sql.replace('select "id"','select "data"'),observed[1]!.sql);
 store.put('attempts','earliest',{...detail,status:'submitted'});assert.equal(getActiveExamId(store),'later');
 store.remove('attempts','later');assert.equal(getActiveExamId(store),undefined);
});

test('the HTTP exam guard reads one ID column even when the active snapshot is large',async t=>{
 const folder=await mkdtemp(join(tmpdir(),'noetic-guard-projection-')),path=join(folder,'isolated.sqlite');
 const app=await buildApp({databasePath:path,seedPath:join(folder,'missing-seed.json'),staticRoot:join(folder,'no-web')});
 t.after(async()=>{await app.close();assert.equal(dirname(resolve(folder)),resolve(tmpdir()));assert.ok(basename(folder).startsWith('noetic-guard-projection-'));await rm(folder,{recursive:true,force:true});});
 const writer=new Store(path);
 try{writer.put('attempts','active-large',{id:'active-large',practiceMode:'exam',status:'in_progress',startedAt:'2026-10-22T01:00:00.000Z',questions:[{id:'question',answerMarkdown:'snapshot '.repeat(150000)}]});}
 finally{writer.db.close();}
 const original=DatabaseConnection.prototype.one;const observed:{sql:string;row:unknown}[]=[];
 t.mock.method(DatabaseConnection.prototype,'one',function(this:DatabaseConnection,builder:any){
  const row=original.call(this,builder),sql=builder.compile().sql;
  if(sql.includes('from "attempts"'))observed.push({sql,row});
  return row;
 });
 const blocked=await app.inject({method:'GET',url:'/api/questions'});
 assert.equal(blocked.statusCode,409);assert.equal(blocked.json().error.details.attemptId,'active-large');
 const health=await app.inject({method:'GET',url:'/api/health'});assert.equal(health.statusCode,200);
 assert.equal(observed.length,2);
 for(const result of observed){assert.match(result.sql,/^select "id" from "attempts" /);assert.deepEqual({...result.row as object},{id:'active-large'});assert.ok(Buffer.byteLength(JSON.stringify(result.row))<100);}
});
