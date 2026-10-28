/** Optional real-model check. Only synthetic content is sent; every write is
 * in memory. Read the existing AI configuration without initializing its DB. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {DatabaseConnection} from '../../server/database/connection.js';
import {buildApp} from '../../server/index.js';
import type {PrivateAiSettings} from '../../server/modules/ai/provider.js';

const folder=resolve('test-results/ai-question-edit-live',new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(folder,{recursive:true});
const path=resolve('data/noetic-atlas.sqlite'),digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function read(){const database=new DatabaseConnection(path,false);try{return database.getRecord<PrivateAiSettings>('ai_settings','local');}finally{database.close();}}
const settings=read();assert.ok(settings?.baseUrl&&settings.model&&settings.enabled,'AI_CONFIGURATION_NOT_ENABLED');
const fingerprint=digest(settings),fetchOriginal=globalThis.fetch;let requests=0;
globalThis.fetch=async(...args:Parameters<typeof fetch>)=>{assert.ok(++requests<=2,'LIVE_PROVIDER_REQUEST_BUDGET_EXCEEDED');return fetchOriginal(...args);};
const app=await buildApp({databasePath:':memory:',seedPath:'missing-edit-live-seed',staticRoot:'missing-edit-live-web',native:true,dailyPushScheduler:false});
const report:Record<string,unknown>={passed:false,provider:new URL(settings.baseUrl).hostname,model:settings.model,syntheticOnly:true,database:':memory:'};
try{
 const api=async(url:string,method:any='GET',payload?:unknown)=>{const response=await app.inject({url,method,...(payload===undefined?{}:{payload})});if(response.statusCode>=400){const value=response.json();throw Object.assign(Error('LIVE_EDIT_REQUEST_FAILED'),{status:response.statusCode,code:value?.error?.code||'UNKNOWN'});}return response.json();};
 const {updatedAt:_settingsVersion,...portableSettings}=settings;
 await api('/api/ai/settings','PUT',{...portableSettings,maxTokens:Math.max(4096,Math.min(settings.maxTokens,8192)),timeoutSeconds:Math.max(settings.timeoutSeconds,90)});
 const q=await api('/api/questions','POST',{id:'AI-EDIT-LIVE-SYNTHETIC',title:'基本算术校对',type:'single_choice',stemMarkdown:'在通常的整数算术中，2加2等于多少？',options:[{key:'A',text:'4'},{key:'B',text:'5'}],correctAnswers:['B'],answerMarkdown:'5',explanationMarkdown:'将两个2相加得到4。'});
 const before=await api('/api/questions/'+q.id);
 const {createdAt:_created,updatedAt:_updated,study:_study,partStudies:_parts,feedbackSummary:_feedback,...draft}=q;
 const response=await api('/api/ai/question-edit','POST',{questionId:q.id,expectedUpdatedAt:q.updatedAt,question:draft,requirements:'请给出1至3条可靠的独立修改建议，重点核对判分答案、答案说明与解析是否一致。相关判分答案和答案说明放在同一条建议，保留原考点。不需要新增归类。'});
 assert.equal(response.status,'completed');assert.equal(response.kind,'question_edit');assert.ok(response.result.suggestions.length>0);
 assert.ok(response.result.suggestions.some((value:any)=>value.changes.correctAnswers?.includes('A')),'EXPECTED_ARITHMETIC_ANSWER_CORRECTION');
 assert.deepEqual(await api('/api/questions/'+q.id),before,'ANALYSIS_MUST_NOT_SAVE_QUESTION');
 assert.equal(digest(read()),fingerprint,'WORKING_CONFIGURATION_MUST_NOT_CHANGE');
 Object.assign(report,{passed:true,providerRequests:requests,suggestionCount:response.result.suggestions.length,result:response.result,workingConfigurationUnchanged:true});
}catch(reason:any){Object.assign(report,{providerRequests:requests,error:{code:typeof reason?.code==='string'?reason.code:reason?.name||'CHECK_FAILED',httpStatus:reason?.status},workingConfigurationUnchanged:digest(read())===fingerprint});process.exitCode=1;}
finally{globalThis.fetch=fetchOriginal;await app.close();await writeFile(resolve(folder,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,result:undefined}));}
