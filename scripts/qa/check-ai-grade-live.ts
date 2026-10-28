/** Two real-model grading checks using synthetic answers and an in-memory DB.
 * Existing settings are read-only; no actual question, answer or note is sent. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {DatabaseConnection} from '../../server/database/connection.js';
import {buildApp} from '../../server/index.js';
import type {PrivateAiSettings} from '../../server/modules/ai/provider.js';
const folder=resolve('test-results/ai-grade-live',new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(folder,{recursive:true});
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function read(){const database=new DatabaseConnection(resolve('data/noetic-atlas.sqlite'),false);try{return database.getRecord<PrivateAiSettings>('ai_settings','local');}finally{database.close();}}
const settings=read();assert.ok(settings?.enabled&&settings.baseUrl&&settings.model,'AI_CONFIGURATION_NOT_ENABLED');const fingerprint=hash(settings);
const app=await buildApp({databasePath:':memory:',seedPath:'missing-grade-live-seed',staticRoot:'missing-grade-live-web',native:true,dailyPushScheduler:false});
const originalFetch=globalThis.fetch;let calls=0;globalThis.fetch=async(...args:Parameters<typeof fetch>)=>{assert.ok(++calls<=2,'LIVE_GRADE_CALL_LIMIT');return originalFetch(...args);};
const report:any={passed:false,syntheticOnly:true,database:':memory:',checks:[]};
try{
 const api=async(url:string,method:any='GET',payload?:unknown)=>{const response=await app.inject({url,method,...(payload===undefined?{}:{payload})});if(response.statusCode>=400){const error=response.json().error;throw Object.assign(Error('LIVE_GRADE_FAILED'),{code:error.code,status:response.statusCode,validationIssues:error.details?.failure?.validationIssues});}return response.json();};
 const {updatedAt:unused,...portable}=settings;await api('/api/ai/settings','PUT',{...portable,timeoutSeconds:Math.max(settings.timeoutSeconds,90)});
 await api('/api/questions','POST',{id:'GRADE-LIVE-TOKEN',title:'Token概念',type:'short_answer',stemMarkdown:'Token是否总等于一个汉字或一个英文单词？',answerMarkdown:'不等于。Token由分词器定义，可以是字词、子词或其他文本片段，具体切分与模型有关。'});
 const question=await api('/api/questions/GRADE-LIVE-TOKEN');await api('/api/questions/review','POST',{ids:[question.id],action:'approve',confirmed:true,expectedUpdatedAt:{[question.id]:question.updatedAt}});
 const paper=await api('/api/papers','POST',{title:'合成无分判题',mode:'manual',questionIds:[question.id],scoring:{enabled:false}}),started=await api(`/api/papers/${paper.id}/attempts`,'POST',{});
 const submitted=await api(`/api/attempts/${started.id}/submit`,'POST',{answers:{[question.id]:{value:'Token一定是一个完整英文单词，每个汉字也固定只有一个Token。'}}});
 const unscored=await api(`/api/attempts/${started.id}/ai-review`,'POST',{gradingRequirements:'允许等价表述，请指出理解错误及改进方向。'});
 assert.equal(unscored.status,'completed');assert.ok(['correct','partial','incorrect'].includes(unscored.result.items[0].verdict));assert.equal(unscored.result.items[0].score,null);assert.equal(unscored.result.items[0].maxPoints,null);assert.equal(unscored.result.items[0].requiresRegrade,undefined);assert.deepEqual(await api(`/api/attempts/${started.id}`),submitted);
 report.checks.push({mode:'unscored-attempt',verdict:unscored.result.items[0].verdict,providerCalls:unscored.diagnostics.providerCalls,warnings:unscored.warnings});
 const scored=await api('/api/ai/grade','POST',{questionId:question.id,answer:'Token不是固定的字或词，它是分词器划定的文本片段，可以含子词；不同模型的切分可能不同。',maxPoints:6,gradingRequirements:'关键是理解Token与分词器及切分边界；满分6分，最多两位小数。'});
 assert.equal(scored.status,'completed');const result=scored.result.items[0];assert.ok(['correct','partial','incorrect'].includes(result.verdict));assert.equal(result.maxPoints,6);assert.ok(result.score>=0&&result.score<=6);assert.equal(result.requiresRegrade,undefined);
 report.checks.push({mode:'scored-single',verdict:result.verdict,score:result.score,maxPoints:result.maxPoints,providerCalls:scored.diagnostics.providerCalls,warnings:scored.warnings});report.passed=true;
}catch(error:any){report.error={code:typeof error?.code==='string'?error.code:error?.name||'CHECK_FAILED',status:error?.status,validationIssues:error?.validationIssues};process.exitCode=1;}
finally{globalThis.fetch=originalFetch;report.providerCalls=calls;report.workingConfigurationUnchanged=hash(read())===fingerprint;if(!report.workingConfigurationUnchanged){report.passed=false;process.exitCode=1;}await app.close();await writeFile(resolve(folder,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
