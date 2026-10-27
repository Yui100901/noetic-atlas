import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import initSqlJs from 'sql.js';
import { build } from 'vite';
import { nativeAliases } from '../../mobile/vite-aliases.js';

test('offline concept sets retain reverse drafts, distinct FSRS identity and portable SQLite restore', async t => {
  const folder = resolve('test-results/native-concept-set'); await mkdir(folder, {recursive:true});
  await build({configFile:false,logLevel:'error',define:{'process.env':'{}'},resolve:{alias:nativeAliases},build:{outDir:folder,emptyOutDir:false,minify:false,lib:{entry:resolve('mobile/runtime.ts'),formats:['es'],fileName:()=> 'runtime.mjs'}}});
  const {createLocalRuntime} = await import(pathToFileURL(resolve(folder,'runtime.mjs')).href);
  const sql = await initSqlJs({locateFile:()=>resolve('node_modules/sql.js/dist/sql-wasm.wasm')});
  let durable:Uint8Array|undefined;
  const backups=new Map<string,Uint8Array>();
  const storage={
    async load(){return durable?.slice();},async save(bytes:Uint8Array){durable=bytes.slice();},
    async createRecoveryBackup(bytes:Uint8Array){const id=`concept-${backups.size}`;backups.set(id,bytes.slice());return{id,byteLength:bytes.length,createdAt:new Date().toISOString()};},
    async loadRecoveryBackup(id:string){return backups.get(id)!.slice();},
  };
  const seed={schemaVersion:1,generatedAt:new Date().toISOString(),domains:[],categories:[],tags:[],questions:[],documents:[],papers:[]};
  let runtime=await createLocalRuntime(sql,seed,storage,{dailyPushScheduler:false});t.after(()=>runtime.close());
  const api=async(path:string,method='GET',body?:unknown,expected=200)=>{const response=await runtime.fetch(path,{method,...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json();assert.equal(response.status,expected,JSON.stringify(value));return value as any;};
  const question=await api('/api/questions','POST',{id:'NATIVE-CONCEPT',type:'short_answer',title:'沉没成本',stemMarkdown:'解释沉没成本。',answerMarkdown:'已发生且无法收回的支出。',concept:{term:'沉没成本',meaningPrompt:'已发生且无法收回的支出',acceptedAnswers:['沉没成本','sunk cost']}},201);
  await api('/api/questions/review','POST',{ids:[question.id],action:'approve',confirmed:true,expectedUpdatedAt:{[question.id]:question.updatedAt}});
  const paper=await api('/api/papers','POST',{title:'经济学概念集',mode:'manual',practiceKind:'concept',questionIds:[question.id],scoring:{enabled:false}},201);
  const reverse=await api(`/api/papers/${paper.id}/attempts`,'POST',{vocabularyDirection:'meaning_to_word'},201);
  assert.ok(!JSON.stringify(reverse).includes('沉没成本'));assert.equal(reverse.practiceKind,'concept');
  await api(`/api/attempts/${reverse.id}`,'PUT',{answers:{[question.id]:{value:['sunk cost']}}});
  await runtime.close();runtime=await createLocalRuntime(sql,seed,storage,{dailyPushScheduler:false});
  assert.equal((await api(`/api/attempts/${reverse.id}`)).answers[question.id].value[0],'sunk cost');
  const submitted=await api(`/api/attempts/${reverse.id}/submit`,'POST');assert.equal(submitted.answerStates[question.id],'correct');assert.equal(submitted.questions[0].concept.term,'沉没成本');
  assert.equal((await api(`/api/review-scheduler/attempts/${reverse.id}`)).items[0].direction,'meaning_to_word');
  const backup=await runtime.fetch('/api/backup.sqlite');assert.equal(backup.status,200);const preview=await runtime.previewRestore(new Uint8Array(await backup.arrayBuffer()),'concept.sqlite');assert.equal(preview.counts.attempts,1);
  await runtime.close();runtime=await createLocalRuntime(sql,seed,storage,{dailyPushScheduler:false});
  assert.equal((await api(`/api/questions/${question.id}/history`)).items[0].question.concept.term,'沉没成本');

  // An existing ordinary card may be enriched with concept metadata later.
  // Editing/reading must leave the complete old event chain byte-for-byte intact.
  const ordinary=await api('/api/questions','POST',{id:'NATIVE-LEGACY-CONCEPT',type:'short_answer',title:'机会成本',stemMarkdown:'解释机会成本。',answerMarkdown:'所放弃的最佳替代方案的价值。'},201);
  await api('/api/questions/review','POST',{ids:[ordinary.id],action:'approve',confirmed:true,expectedUpdatedAt:{[ordinary.id]:ordinary.updatedAt}});
  const old=await api('/api/review-scheduler/review','POST',{questionId:ordinary.id,direction:'standard',rating:'good',requestId:'native-legacy-first'});
  await api('/api/review-scheduler/card','PATCH',{questionId:ordinary.id,direction:'standard',dueAt:new Date(Date.now()-86400000).toISOString()});
  const rawReviewRows=async()=>{
    const response=await runtime.fetch('/api/backup.sqlite');assert.equal(response.status,200);
    const copy=new sql.Database(new Uint8Array(await response.arrayBuffer()));
    try{return Object.fromEntries(['review_cards','review_events','reviews'].map(table=>[table,copy.exec(`SELECT id,data FROM ${table} ORDER BY id`)]));}finally{copy.close();}
  };
  const beforeEnrichment=await rawReviewRows();
  const current=await api(`/api/questions/${ordinary.id}`);
  await api(`/api/questions/${ordinary.id}`,'PUT',{...current,concept:{term:'机会成本',meaningPrompt:'所放弃的最佳替代方案的价值',acceptedAnswers:['机会成本','opportunity cost']},expectedUpdatedAt:current.updatedAt});
  const alias=await api(`/api/review-scheduler/card?questionId=${ordinary.id}&direction=word_to_meaning`);
  assert.equal(alias.direction,'standard');assert.equal(alias.card.id,old.card.id);assert.equal(alias.card.memory.reps,1);
  const queue=await api('/api/review-scheduler/queue?direction=word_to_meaning&page=1&pageSize=100');
  const tasks=queue.items.filter((item:any)=>item.questionId===ordinary.id);
  assert.equal(tasks.length,1);assert.equal(tasks[0].direction,'standard');assert.equal(tasks[0].logicalDirection,'word_to_meaning');
  assert.deepEqual(await rawReviewRows(),beforeEnrichment);
  const next=await api('/api/review-scheduler/review','POST',{questionId:ordinary.id,direction:tasks[0].direction,rating:'good',requestId:'native-legacy-next'});
  assert.equal(next.card.id,old.card.id);assert.equal(next.card.memory.reps,2);assert.equal(next.eventCount,2);
  await api('/api/review-scheduler/review','POST',{questionId:ordinary.id,direction:'word_to_meaning',rating:'good',requestId:'native-legacy-next'});
  assert.ok(!(await api('/api/review-scheduler/queue')).items.some((item:any)=>item.questionId===ordinary.id));
  const exportJson=await api('/api/export');assert.equal(exportJson.reviewCards.filter((card:any)=>card.questionId===ordinary.id).length,1);
  const sqlite=await runtime.fetch('/api/backup.sqlite');const legacyPreview=await runtime.previewRestore(new Uint8Array(await sqlite.arrayBuffer()),'legacy-concept.sqlite');
  await runtime.restore(legacyPreview.token);
  await runtime.close();runtime=await createLocalRuntime(sql,seed,storage,{dailyPushScheduler:false});
  const restored=await api(`/api/review-scheduler/card?questionId=${ordinary.id}&direction=word_to_meaning`);
  assert.equal(restored.card.id,old.card.id);assert.equal(restored.card.memory.reps,2);assert.equal(restored.eventCount,2);
});
