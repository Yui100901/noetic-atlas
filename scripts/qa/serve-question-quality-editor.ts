/** Isolated authoring fixture; never reads the user's working database. */
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {buildApp} from '../../server/index.js';
const app=await buildApp({databasePath:':memory:',seedPath:'missing-quality-editor-qa',staticRoot:resolve('dist/web'),dailyPushScheduler:false});
async function api(url:string,payload?:unknown,method:any=payload===undefined?'GET':'POST'){const r=await app.inject({url,method,...(payload===undefined?{}:{payload})});assert.ok(r.statusCode<400,`${url}: ${r.body}`);return r.json();}
app.get('/qa/question-quality-editor',async()=>({question:await api('/api/questions/EDITOR-QUALITY'),issues:await api('/api/content-quality/issues?questionId=EDITOR-QUALITY&status=all'),scans:await api('/api/content-quality/scans?pageSize=100'),backup:await api('/api/export')}));
const sourceRefs=[{label:'事务参考',url:'https://www.postgresql.org/docs/current/tutorial-transactions.html'}];
await api('/api/questions',{id:'EDITOR-QUALITY',title:'编辑质量流程验收',type:'short_answer',stemMarkdown:'学习说明：这里是需要删除的操作提示。\n\n解释事务原子性。',answerMarkdown:'事务整体提交或回滚。',explanationMarkdown:'',sourceRefs});
await api('/api/questions',{id:'EDITOR-GROUP',title:'组合小题质量验收',type:'group',stemMarkdown:'阅读事务材料。',explanationMarkdown:'公共材料的来源和条件。',sourceRefs,parts:[{id:'first',title:'解释回滚',type:'short_answer',stemMarkdown:'学习说明：这里是需要删除的操作提示。\n\n解释回滚。',answerMarkdown:'撤销未提交变更。',explanationMarkdown:''},{id:'second',title:'判断整体性',type:'true_false',stemMarkdown:'原子性约束事务整体结果。',answerMarkdown:'正确。',correctAnswers:['true'],explanationMarkdown:'全提交或整体失败回滚。'}]});
for(const id of ['EDITOR-QUALITY','EDITOR-GROUP']){const scan=await api('/api/content-quality/scans',{filters:{questionId:id}});await api(`/api/content-quality/scans/${scan.id}/process`,{batchSize:1});}
console.log('QUESTION_QUALITY_EDITOR_READY '+JSON.stringify({origin:await app.listen({host:'127.0.0.1',port:0})}));
async function close(){await app.close();process.exit(0);}process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
