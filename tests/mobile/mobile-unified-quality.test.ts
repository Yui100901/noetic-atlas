import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import initSqlJs from 'sql.js';
import { loadNativeRuntime } from '../helpers/native-runtime.js';

test('native unified quality links commit durably, upgrade old feedback, and reject forged full restores',async t=>{


 const {createLocalRuntime}=await loadNativeRuntime();
 const sql=await initSqlJs({locateFile:()=>resolve('node_modules/sql.js/dist/sql-wasm.wasm')});
 let durable:Uint8Array|undefined,failSave=false,saves=0;
 const recovery=new Map<string,Uint8Array>();
 const storage={async load(){return durable?.slice();},async save(bytes:Uint8Array){if(failSave)throw Error('simulated disk full');durable=bytes.slice();saves++;},async createRecoveryBackup(bytes:Uint8Array){const id='quality-'+recovery.size;recovery.set(id,bytes.slice());return{id,byteLength:bytes.length,createdAt:new Date().toISOString()};},async loadRecoveryBackup(id:string){return recovery.get(id)!.slice();}};
 const seed={schemaVersion:1,domains:[],categories:[],tags:[],questions:[],documents:[],papers:[]};
 let runtime=await createLocalRuntime(sql,seed,storage,{dailyPushScheduler:false});t.after(()=>runtime.close());
 const api=async(path:string,method='GET',body?:unknown,status=200)=>{const response=await runtime.fetch(path,{method,...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value as any;};
 const modify=(run:(db:InstanceType<typeof sql.Database>)=>void)=>{const db=new sql.Database(durable);try{run(db);durable=db.export();}finally{db.close();}};
 const record=(table:string,id:string)=>{const db=new sql.Database(durable);try{const values=db.exec(`SELECT data FROM ${table} WHERE id='${id}'`);return values.length?JSON.parse(String(values[0].values[0][0])):null;}finally{db.close();}};
 for(const id of ['Q1','Q2'])await api('/api/questions','POST',{id,title:'概念'+id,type:'short_answer',stemMarkdown:'说明概念'+id,answerMarkdown:'定义。',sourceRefs:[{label:'待补充的占位来源',url:'https://example.org/placeholder'}]},201);
 const report=await api('/api/question-feedback','POST',{questionId:'Q1',kind:'answer',description:'原题答案存在疑问'},201);assert.ok(record('quality_issues',report.qualityIssueId));
 let scan=await api('/api/content-quality/scans','POST',{},201);await api(`/api/content-quality/scans/${scan.id}/process`,'POST',{batchSize:100});
 const beforeGrouping=saves,groups=await api('/api/content-quality/questions?status=all&pageSize=10');
 assert.equal(groups.total,2);assert.equal(new Set(groups.items.map((group:any)=>group.questionId)).size,2);
 const q1=groups.items.find((group:any)=>group.questionId==='Q1');assert.equal(q1.issueCount,2);assert.equal(q1.activeIssueCount,2);assert.deepEqual(q1.origins,['feedback','scan']);
 assert.equal((await api('/api/content-quality/overview')).totalQuestions,2);assert.equal(saves,beforeGrouping,'native grouping reads must not persist or rewrite evidence');
 let issue=(await api('/api/content-quality/issues?origin=scan')).items.find((item:any)=>item.questionId==='Q2');
 const before=durable!.slice();failSave=true;
 try{await api(`/api/content-quality/issues/${issue.id}/review-context`,'POST',{expectedUpdatedAt:issue.updatedAt},507);}finally{failSave=false;}
 assert.deepEqual(durable,before);assert.deepEqual((await api(`/api/content-quality/issues/${issue.id}`)).feedbacks,[]);
 const prepared=await api(`/api/content-quality/issues/${issue.id}/review-context`,'POST',{expectedUpdatedAt:issue.updatedAt});
 assert.equal(record('question_feedback',prepared.feedback.id).qualityIssueId,issue.id);
 await runtime.close();
 // Reproduce the preceding app version: a real report existed without a case.
 modify(db=>{const old=record('question_feedback',report.id);delete old.origin;delete old.qualityIssueId;db.run('UPDATE question_feedback SET data=? WHERE id=?',[JSON.stringify(old),report.id]);db.run('DELETE FROM quality_issues WHERE id=?',[report.qualityIssueId]);});
 const oldDurable=durable!.slice();failSave=true;
 try{await assert.rejects(()=>createLocalRuntime(sql,seed,storage,{dailyPushScheduler:false}),/disk full/);}finally{failSave=false;}
 assert.deepEqual(durable,oldDurable,'failed startup migration must leave disk intact');
 const writes=saves;runtime=await createLocalRuntime(sql,seed,storage,{dailyPushScheduler:false});assert.equal(saves,writes+1,'new startup link is saved before opening');
 const upgraded=record('question_feedback',report.id);assert.equal(upgraded.qualityIssueId,report.qualityIssueId);assert.equal(record('quality_issues',upgraded.qualityIssueId).evidence,report.description);
 await runtime.close();const unchanged=saves;runtime=await createLocalRuntime(sql,seed,storage,{dailyPushScheduler:false});assert.equal(saves,unchanged,'idempotent startup does not rewrite the file');
 assert.equal((await api(`/api/content-quality/issues/${issue.id}`)).feedbacks[0].id,prepared.feedback.id);
 const original=durable!.slice(),forged=new sql.Database(original);
 let forgedBytes:Uint8Array;try{const row=record('question_feedback',prepared.feedback.id);row.qualityIssueId=report.qualityIssueId;forged.run('UPDATE question_feedback SET data=? WHERE id=?',[JSON.stringify(row),row.id]);forgedBytes=forged.export();}finally{forged.close();}
 await assert.rejects(()=>runtime.previewRestore(forgedBytes!,'forged.sqlite'),/质量问题|反馈/);assert.deepEqual(durable,original);
 const backup=await runtime.fetch('/api/backup.sqlite'),preview=await runtime.previewRestore(new Uint8Array(await backup.arrayBuffer()),'valid.sqlite');await runtime.restore(preview.token);
 await runtime.close();runtime=await createLocalRuntime(sql,seed,storage,{dailyPushScheduler:false});
 assert.equal((await api(`/api/content-quality/issues/${issue.id}`)).feedbacks[0].id,prepared.feedback.id);assert.equal(record('question_feedback',report.id).qualityIssueId,report.qualityIssueId);
 assert.equal((await api('/api/question-feedback/summaries','POST',{questionIds:['Q1','Q2']})).summaries.Q2.openCount,0,'system contexts are not user suspicion');
});
