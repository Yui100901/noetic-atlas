import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildApp } from '../../server/index.js';

async function fixture(t:test.TestContext){
 const folder=await mkdtemp(join(tmpdir(),'noetic-exam-guard-'));const path=join(folder,'isolated.sqlite');
 const app=await buildApp({databasePath:path,seedPath:join(folder,'none.json'),staticRoot:join(folder,'no-web')});
 t.after(async()=>{await app.close();assert.equal(dirname(resolve(folder)),resolve(tmpdir()));assert.ok(folder.includes('noetic-exam-guard-'));await rm(folder,{recursive:true,force:true});});
 const api=async(method:any,url:string,payload?:unknown,expected=200)=>{const response=await app.inject({method,url,...(payload===undefined?{}:{payload})});assert.equal(response.statusCode,expected,response.body);return response.json();};
 const question=await api('POST','/api/questions',{id:'S1',title:'通用原子性练习',type:'short_answer',stemMarkdown:'说明事务原子性。',answerMarkdown:'全部提交或回滚。'},201);await api('POST','/api/questions/review',{confirmed:true,action:'approve',ids:['S1'],expectedUpdatedAt:{S1:question.updatedAt}});
 const paper=await api('POST','/api/papers',{title:'通用测试卷',mode:'manual',questionIds:['S1'],scoring:{enabled:false}},201);
 const other=await api('POST',`/api/papers/${paper.id}/attempts`,{},201);
 const asset=await api('POST','/api/assets',{filename:'fixture.png',mimeType:'image/png',dataBase64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/bZkAAAAASUVORK5CYII='},201);
 const exam=await api('POST',`/api/papers/${paper.id}/attempts`,{mode:'exam',durationMinutes:1},201);
 const row=()=>{const db=new DatabaseSync(path);try{return JSON.parse((db.prepare('SELECT data FROM attempts WHERE id=?').get(exam.id) as any).data);}finally{db.close();}};
 return{api,app,path,paper,exam,other,asset,row};
}

test('active exam locks all other application APIs including answers AI docs and exports while own session and images remain available',async t=>{
 const f=await fixture(t);const base=`/api/attempts/${f.exam.id}`;
 for(const[method,url,payload]of [
 ['GET','/api/questions',undefined],['GET','/api/questions/S1',undefined],['POST','/api/ai/explain',{questionId:'S1'}],
 ['GET',`/api/papers/${f.paper.id}/export?answers=true`,undefined],['GET','/api/docs/',undefined],['GET','/api/openapi.json',undefined],
 ['GET','/api/settings',undefined],['GET','/api/attempts',undefined],['GET',`/api/attempts/${f.other.id}`,undefined],['POST','/api/paper-drafts',{}],['DELETE',`/api/papers/${f.paper.id}`,undefined]
 ] as const){const result=await f.api(method,url,payload,409);assert.equal(result.error.code,'EXAM_ACTIVE');assert.equal(result.error.details.attemptId,f.exam.id);}
 await f.api('GET','/api/health');await f.api('GET','/api/bootstrap');await f.api('GET','/api/exams/active');assert.equal((await f.api('GET',base)).status,'in_progress');await f.api('GET',`/api/assets/${f.asset.id}`);await f.api('GET',`/api/assets/${f.asset.id}/data`);const image=await f.app.inject({method:'GET',url:`/api/assets/${f.asset.id}/content`});assert.equal(image.statusCode,200);
 await f.api('PUT',base,{answers:{S1:{value:'操作全部完成或全部回滚。'}}});await f.api('POST',base+'/sync');assert.equal((await f.api('POST',base+'/submit',{})).status,'submitted');assert.equal((await f.api('GET','/api/questions/S1')).id,'S1');assert.equal((await f.api('GET','/api/openapi.json')).info.version,'1.0.0');
});

test('expired exam GET stays read-only and locked until explicit sync durably auto-submits then unlocks',async t=>{
 const f=await fixture(t);const db=new DatabaseSync(f.path);const record=f.row();record.startedAt=new Date(Date.now()-120000).toISOString();record.deadlineAt=new Date(Date.parse(record.startedAt)+60000).toISOString();db.prepare('UPDATE attempts SET data=? WHERE id=?').run(JSON.stringify(record),record.id);db.close();
 const before=JSON.stringify(f.row());assert.equal((await f.api('GET',`/api/attempts/${record.id}`)).status,'in_progress');await f.api('GET','/api/questions',undefined,409);assert.equal(JSON.stringify(f.row()),before);
 const synced=await f.api('POST','/api/exams/sync');assert.equal(synced.attempt,null);const after=await f.api('GET',`/api/attempts/${record.id}`);assert.equal(after.status,'submitted');assert.equal(after.autoSubmitted,true);assert.equal(after.submittedAt,record.deadlineAt);assert.equal(after.elapsedSeconds,60);await f.api('GET','/api/questions');
});
