import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import initSqlJs from 'sql.js';
import { loadNativeRuntime } from '../helpers/native-runtime.js';

test('offline quality runs survive restart, disk failures roll back, and full restore rebuilds disposable signatures',async t=>{
  const {createLocalRuntime}=await loadNativeRuntime();
  const sql=await initSqlJs({locateFile:()=>resolve('node_modules/sql.js/dist/sql-wasm.wasm')});
  let durable:Uint8Array|undefined,failSave=false,saves=0;
  const backups=new Map<string,Uint8Array>();
  const storage={async load(){return durable?.slice();},async save(bytes:Uint8Array){if(failSave)throw Error('simulated disk full');durable=bytes.slice();saves++;},async createRecoveryBackup(bytes:Uint8Array){const id='quality-'+backups.size;backups.set(id,bytes.slice());return{id,byteLength:bytes.length,createdAt:new Date().toISOString()};},async loadRecoveryBackup(id:string){return backups.get(id)!.slice();}};
  const seed={schemaVersion:1,domains:[],categories:[],tags:[],questions:[],documents:[],papers:[]};
  let runtime=await createLocalRuntime(sql,seed,storage,{dailyPushScheduler:false});t.after(()=>runtime.close());
  const api=async(path:string,method='GET',body?:unknown,expected=200)=>{const response=await runtime.fetch(path,{method,...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();assert.equal(response.status,expected,JSON.stringify(value));return value as any;};
  const rows=(table:string)=>{const copy=new sql.Database(durable);try{return copy.exec(`SELECT id,data FROM ${table} ORDER BY id`);}finally{copy.close();}};
  for(let i=0;i<3;i++)await api('/api/questions','POST',{id:'Q'+i,title:'基础问题'+i,type:'short_answer',stemMarkdown:'解释独立概念'+i,answerMarkdown:'对应的定义和含义。',sourceRefs:[{label:'待补充的占位来源',url:'https://example.org/placeholder'}]},201);
  const questionsBefore=rows('questions');let run=await api('/api/content-quality/scans','POST',{},201);
  run=await api(`/api/content-quality/scans/${run.id}/process`,'POST',{batchSize:1});assert.equal(run.processed,1);
  const issue=(await api('/api/content-quality/issues')).items[0];assert.ok(issue);
  const countBefore=saves;await api('/api/content-quality/overview');await api('/api/content-quality/issues');assert.equal(saves,countBefore);
  await runtime.close();runtime=await createLocalRuntime(sql,seed,storage,{dailyPushScheduler:false});
  assert.equal((await api('/api/content-quality/scans/'+run.id)).processed,1);
  const beforeBytes=durable!.slice();failSave=true;
  try{await api(`/api/content-quality/scans/${run.id}/process`,'POST',{batchSize:1},507);await api(`/api/content-quality/issues/${issue.id}/resolve`,'POST',{status:'dismissed',note:'保持原始课堂题。',expectedUpdatedAt:issue.updatedAt},507);}finally{failSave=false;}
  assert.deepEqual(durable,beforeBytes);assert.equal((await api('/api/content-quality/scans/'+run.id)).processed,1);assert.equal((await api('/api/content-quality/issues/'+issue.id)).issue.status,'open');
  const resolved=await api(`/api/content-quality/issues/${issue.id}/resolve`,'POST',{status:'dismissed',note:'保留原始课堂题，出处后续补齐。',expectedUpdatedAt:issue.updatedAt});assert.equal(resolved.status,'dismissed');
  await runtime.close();runtime=await createLocalRuntime(sql,seed,storage,{dailyPushScheduler:false});assert.equal((await api('/api/content-quality/issues/'+issue.id)).issue.note,resolved.note);
  const backup=await runtime.fetch('/api/backup.sqlite');assert.equal(backup.status,200);const preview=await runtime.previewRestore(new Uint8Array(await backup.arrayBuffer()),'content-quality.sqlite');
  assert.equal(preview.counts.quality_scans,1);assert.ok(preview.counts.quality_issues>0);assert.ok(!Object.hasOwn(preview.counts,'quality_fingerprints'));
  await runtime.restore(preview.token);await runtime.close();runtime=await createLocalRuntime(sql,seed,storage,{dailyPushScheduler:false});assert.deepEqual(rows('questions'),questionsBefore);assert.equal(rows('quality_fingerprints').length,0);
  assert.equal((await api('/api/content-quality/issues/'+issue.id)).issue.status,'dismissed');
  const rejected=await api(`/api/content-quality/scans/${run.id}/process`,'POST',{batchSize:1},409);assert.equal(rejected.error.code,'QUALITY_REBUILD_REQUIRED');
  let rebuilt=await api('/api/content-quality/scans','POST',{},201);rebuilt=await api(`/api/content-quality/scans/${rebuilt.id}/process`,'POST',{batchSize:100});assert.equal(rebuilt.status,'completed');assert.equal(rebuilt.processed,3);
  assert.equal((await api('/api/content-quality/issues/'+issue.id)).issue.status,'dismissed');assert.deepEqual(rows('questions'),questionsBefore);
});
