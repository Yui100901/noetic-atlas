/** Isolated question-editing fixture. No working database or external AI. */
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {buildApp} from '../../server/index.js';
const app=await buildApp({databasePath:':memory:',seedPath:'missing-quality-save-fixture',staticRoot:resolve('dist/web'),dailyPushScheduler:false});
let writes=0;
app.addHook('onRequest',async request=>{if(request.method==='PUT'&&request.url.startsWith('/api/questions/'))writes++;});
async function api(url:string,payload?:unknown,method:any=payload===undefined?'GET':'POST'){const result=await app.inject({method,url,...(payload===undefined?{}:{payload})});assert.ok(result.statusCode<400,`${url}: ${result.body}`);return result.json();}
async function allIssues(){const first=await api('/api/content-quality/issues?status=all&pageSize=100'),items=[...first.items];for(let page=2;(page-1)*100<first.total;page++)items.push(...(await api('/api/content-quality/issues?status=all&pageSize=100&page='+page)).items);return{...first,items};}
app.get('/qa/quality-save',async()=>({writes,questions:await api('/api/questions?status=all&pageSize=100'),issues:await allIssues()}));
for(const id of ['SAVE-ISSUE','SAVE-PLAIN','SAVE-TRIAGED','SAVE-CONFLICT','SAVE-PAGES']){
 await api('/api/questions',{id,title:'保存提醒验收'+id,type:'short_answer',stemMarkdown:'说明事务整体提交或回滚。',answerMarkdown:'事务原子性约束整体结果。'});
 if(id!=='SAVE-PLAIN')for(let n=0;n<(id==='SAVE-PAGES'?101:1);n++)await api('/api/question-feedback',{questionId:id,kind:'answer',description:'保存前仍需核查的反馈 '+n});
}
console.log('QUALITY_SAVE_READY '+JSON.stringify({origin:await app.listen({host:'127.0.0.1',port:0})}));
async function close(){await app.close();process.exit(0);}process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
