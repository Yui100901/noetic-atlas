import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import initSqlJs from 'sql.js';
import { loadNativeRuntime } from '../helpers/native-runtime.js';

test('AI in the production mobile WASM runtime persists and applies only confirmed suggestions',async t=>{


  const {createLocalRuntime}=await loadNativeRuntime();
  const sql=await initSqlJs({locateFile:()=>resolve('node_modules/sql.js/dist/sql-wasm.wasm')});
  let durable:Uint8Array|undefined,failSave=false,calls=0,invalidProvider=false;
  const recovery=new Map<string,Uint8Array>();
  const storage={async load(){return durable?.slice();},async save(bytes:Uint8Array){if(failSave)throw new Error('disk full');durable=bytes.slice();},async createRecoveryBackup(bytes:Uint8Array){const id='edit-'+recovery.size;recovery.set(id,bytes.slice());return{id,byteLength:bytes.length,createdAt:new Date().toISOString()};},async loadRecoveryBackup(id:string){return recovery.get(id)!.slice();}};
  const seed={schemaVersion:1,generatedAt:new Date().toISOString(),domains:[],categories:[],tags:[],questions:[],documents:[],papers:[]};
  let runtime=await createLocalRuntime(sql,seed,storage);
  const provider=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);assert.equal(req.headers.authorization,'Bearer mobile-test-key');const material=JSON.parse(body.messages[1].content);calls++;let result;
    if(invalidProvider){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{invalid JSON'}}]}));return;}
    if(material.task.includes('至多20条可独立应用'))result={summary:'移动端逐条编辑建议',suggestions:[{id:'clarify',title:'说明回滚边界',reason:'补充失败后的整体结果。',confidence:'high',changes:{explanationMarkdown:'任一操作失败时，事务整体回滚。'}}],warnings:[]};
    else if(material.task.includes('逐项评价'))result={items:material.untrustedMaterial.items.map((item:any)=>({questionId:item.questionId,score:item.maxPoints===null?null:item.maxPoints/2,maxPoints:item.maxPoints,comment:'移动端评价：概念正确，可补充事务边界。',strengths:['概念明确'],improvements:['说明边界']}))};
    else result={explanationMarkdown:'移动端原子性解释',followUpsMarkdown:'追问日志恢复',pitfallsMarkdown:'并发与原子性的区别'};
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}));
  });
  await new Promise<void>(done=>provider.listen(0,'127.0.0.1',done));const port=(provider.address() as {port:number}).port;
  t.after(async()=>{await runtime.close();await new Promise<void>(done=>provider.close(()=>done()));});
  const api=async(path:string,method='GET',body?:unknown,status=200)=>{const response=await runtime.fetch(path,{method,...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value as any;};
  let question:any;
  await t.test('settings, explanation results and idempotent notes survive reopen',async()=>{
    const {hasKey:_hasKey,...settings}=await api('/api/ai/settings');await api('/api/ai/settings','PUT',{...settings,enabled:true,baseUrl:`http://127.0.0.1:${port}/v1`,model:'mobile-local-test',key:'mobile-test-key'});
    question=await api('/api/questions','POST',{title:'手机AI事务题',type:'short_answer',stemMarkdown:'什么是事务原子性？',answerMarkdown:'整组成功或整组回滚',categoryIds:[],tagIds:[]},201);
    await api('/api/questions/review','POST',{ids:[question.id],action:'approve',confirmed:true,expectedUpdatedAt:{[question.id]:question.updatedAt}});
    const run=await api('/api/ai/explain','POST',{questionId:question.id});await api(`/api/ai/runs/${run.id}/apply`,'POST',{confirmed:true,appendNotes:true});await api(`/api/ai/runs/${run.id}/apply`,'POST',{confirmed:true,appendNotes:true});
    await runtime.close();runtime=await createLocalRuntime(sql,seed,storage);
    assert.equal((await api('/api/ai/settings')).hasKey,true);assert.equal((await api('/api/ai/runs')).length,1);assert.equal((await api(`/api/questions/${question.id}`)).study.notes.match(/移动端原子性解释/g).length,1);
  });
  await t.test('SQLite export redacts credentials without replacing the live durable database',async()=>{
    const beforeSettings=await api('/api/ai/settings');const response=await runtime.fetch('/api/backup.sqlite');assert.equal(response.status,200);const bytes=new Uint8Array(await response.arrayBuffer());
    assert.equal(Buffer.from(bytes).includes(Buffer.from('mobile-test-key')),false);
    const copy=new sql.Database(bytes);const copied=copy.exec('SELECT data FROM ai_settings')[0];assert.equal(JSON.parse(String(copied.values[0][0])).key,'');copy.close();
    assert.deepEqual(await api('/api/ai/settings'),beforeSettings);
    const settings=await api('/api/settings');await api('/api/settings','PUT',{settings:{...settings,maxDraftsPerPaper:4}});await api(`/api/study/${question.id}`,'PUT',{notes:'导出副本后继续写入的学习笔记'});
    await runtime.close();runtime=await createLocalRuntime(sql,seed,storage);assert.equal((await api('/api/ai/settings')).hasKey,true);assert.equal((await api('/api/settings')).maxDraftsPerPaper,4);assert.equal((await api(`/api/questions/${question.id}`)).study.notes,'导出副本后继续写入的学习笔记');
    const original=new sql.Database(durable);const originalRecord=JSON.parse(String(original.exec('SELECT data FROM ai_settings')[0].values[0][0]));assert.equal(originalRecord.key,'mobile-test-key');original.close();
  });
  await t.test('submitted scores remain pending until explicit apply, and failed durable commit rolls back AI run',async()=>{
    const paper=await api('/api/papers','POST',{title:'手机AI阅卷',mode:'manual',questionIds:[question.id],scoring:{enabled:true,totalPoints:8,questionPoints:{[question.id]:8}}},201);
    const attempt=await api(`/api/papers/${paper.id}/attempts`,'POST',undefined,201);await api(`/api/attempts/${attempt.id}/submit`,'POST',{answers:{[question.id]:{value:'事务操作一起成功或者失败'}}});
    const run=await api('/api/ai/grade','POST',{attemptId:attempt.id,questionIds:[question.id]});assert.equal((await api(`/api/attempts/${attempt.id}`)).pendingSubjectiveCount,1);
    const applied=await api(`/api/ai/runs/${run.id}/apply`,'POST',{confirmed:true,applyScores:true,appendNotes:true});assert.equal(applied.attempt.subjectiveScore,4);
    const runsBefore=(await api('/api/ai/runs')).length;const bytesBefore=durable!.slice();failSave=true;await api('/api/ai/explain','POST',{questionId:question.id},507);failSave=false;
    assert.equal((await api('/api/ai/runs')).length,runsBefore);assert.deepEqual(durable,bytesBefore);assert.equal(calls,3);
  });
  await t.test('provider errors retain only safe failure audit across restart, and disk failure rolls it back',async()=>{
    const notesBefore=(await api(`/api/questions/${question.id}`)).study.notes;
    const runsBefore=(await api('/api/ai/runs')).length;
    invalidProvider=true;
    const response=await runtime.fetch('/api/ai/explain',{method:'POST',body:JSON.stringify({questionId:question.id})});
    assert.equal(response.status,502);
    const error=await response.json() as any;
    assert.equal(error.error.code,'AI_INVALID_JSON');
    const auditId=response.headers.get('x-atlas-ai-audit-id');assert.ok(auditId);
    await runtime.close();runtime=await createLocalRuntime(sql,seed,storage);
    const runs=await api('/api/ai/runs');assert.equal(runs.length,runsBefore+1);
    const failed=runs.find((run:any)=>run.id===auditId);assert.equal(failed.status,'failed');assert.equal(failed.failure.code,'AI_INVALID_JSON');assert.equal(failed.result,undefined);
    assert.ok(!JSON.stringify(failed).includes('mobile-test-key'));assert.ok(!JSON.stringify(failed).includes('{invalid JSON'));
    assert.equal((await api(`/api/questions/${question.id}`)).study.notes,notesBefore);
    const durableBefore=durable!.slice();failSave=true;
    await api('/api/ai/explain','POST',{questionId:question.id},507);failSave=false;invalidProvider=false;
    assert.deepEqual(durable,durableBefore);assert.equal((await api('/api/ai/runs')).length,runsBefore+1);
  });
  await t.test('editing previews persist without modifying the source and survive validated full SQLite restore',async()=>{
    const saved=await api('/api/questions/'+question.id),{study,partStudies,feedbackSummary,id,createdAt,updatedAt,...draft}=saved;
    const body={questionId:id,expectedUpdatedAt:updatedAt,question:{...draft,stemMarkdown:'未保存的移动端编辑草稿。'}};
    const run=await api('/api/ai/question-edit','POST',body);assert.equal(run.kind,'question_edit');assert.equal(run.result.suggestions.length,1);assert.deepEqual(await api('/api/questions/'+id),saved);
    const before=durable!.slice();failSave=true;await api('/api/ai/question-edit','POST',body,507);failSave=false;assert.deepEqual(durable,before);
    await runtime.close();runtime=await createLocalRuntime(sql,seed,storage);assert.equal((await api('/api/ai/runs/'+run.id)).result.suggestions[0].id,'clarify');
    const bytes=new Uint8Array(await(await runtime.fetch('/api/backup.sqlite')).arrayBuffer());const preview=await runtime.previewRestore(bytes,'edit-preview.sqlite');assert.ok(preview.counts.ai_runs>0);
    const corrupt=new sql.Database(bytes);try{const row=JSON.parse(String(corrupt.exec("SELECT data FROM ai_runs WHERE id='"+run.id+"'")[0].values[0][0]));row.result.suggestions[0].changes.status='published';corrupt.run('UPDATE ai_runs SET data=? WHERE id=?',[JSON.stringify(row),row.id]);await assert.rejects(runtime.previewRestore(corrupt.export(),'forged-edit.sqlite'));}finally{corrupt.close();}
    const confirmed=await runtime.previewRestore(bytes,'valid-edit.sqlite');await runtime.restore(confirmed.token);await runtime.close();runtime=await createLocalRuntime(sql,seed,storage);
    assert.equal((await api('/api/ai/runs/'+run.id)).result.suggestions[0].changes.explanationMarkdown,'任一操作失败时，事务整体回滚。');assert.deepEqual(await api('/api/questions/'+id),saved);
  });
});
