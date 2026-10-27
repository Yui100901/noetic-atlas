import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { buildApp } from '../../server/index.js';

const app = await buildApp({databasePath:':memory:',seedPath:'no-concept-ui-seed',staticRoot:resolve('dist/web'),dailyPushScheduler:false});
async function api(url:string,payload?:unknown,method:any='POST') {const response=await app.inject({method,url,...(payload===undefined?{}:{payload})});assert.ok(response.statusCode<400,response.body);return response.json();}
await api('/api/domains',{id:'CONCEPT-ECON',name:'经济学'});
await api('/api/categories',{id:'CONCEPT-ECON-CAT',domainId:'CONCEPT-ECON',name:'经济学概念'});
for(const spec of [
 {id:'CONCEPT-1',title:'沉没成本',stemMarkdown:'解释沉没成本。',answerMarkdown:'已经发生且无法收回的支出。',explanationMarkdown:'沉没成本的英文为sunk cost；理性边际决策主要比较未来增量成本和收益。',concept:{term:'沉没成本',meaningPrompt:'已经发生且无法收回的支出',acceptedAnswers:['沉没成本','sunk cost']}},
 {id:'CONCEPT-2',title:'机会成本',stemMarkdown:'解释机会成本。',answerMarkdown:'最佳放弃方案的价值。',concept:{term:'机会成本',meaningPrompt:'选择某个方案时放弃的最佳替代方案的价值',acceptedAnswers:['机会成本','opportunity cost']}},
]) {const q=await api('/api/questions',{...spec,type:'short_answer',categoryIds:['CONCEPT-ECON-CAT']});await api('/api/questions/review',{ids:[q.id],action:'approve',confirmed:true,expectedUpdatedAt:{[q.id]:q.updatedAt}});}
await api('/api/questions',{id:'CONCEPT-PENDING',title:'待审核经济学基础',type:'true_false',stemMarkdown:'机会选择涉及权衡。',correctAnswers:['true'],categoryIds:['CONCEPT-ECON-CAT']});
const paper=await api('/api/papers',{title:'经济学概念双向练习',mode:'manual',practiceKind:'concept',questionIds:['CONCEPT-1','CONCEPT-2'],scoring:{enabled:false}});
const legacy=await api('/api/questions',{id:'CONCEPT-LEGACY',title:'边际收益',type:'short_answer',stemMarkdown:'解释边际收益。',answerMarkdown:'每增加一单位活动所带来的新增收益。',categoryIds:['CONCEPT-ECON-CAT']});
await api('/api/questions/review',{ids:[legacy.id],action:'approve',confirmed:true,expectedUpdatedAt:{[legacy.id]:legacy.updatedAt}});
const oldCard=await api('/api/review-scheduler/review',{questionId:legacy.id,direction:'standard',rating:'good',requestId:'concept-ui-legacy-original'});
await api('/api/review-scheduler/card',{questionId:legacy.id,direction:'standard',dueAt:new Date(Date.now()-86400000).toISOString()},'PATCH');
const current=await api('/api/questions/'+legacy.id,undefined,'GET');
await api('/api/questions/'+legacy.id,{...current,concept:{term:'边际收益',meaningPrompt:'每增加一单位活动所带来的新增收益',acceptedAnswers:['边际收益','marginal benefit']}},'PUT');
const origin=await app.listen({host:'127.0.0.1',port:0});console.log('CONCEPT_SETS_READY '+JSON.stringify({origin,paperId:paper.id,legacyId:legacy.id,legacyCardId:oldCard.card.id}));
const close=async()=>{await app.close();process.exit(0);};process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
