/** Isolated browser fixture: only an in-memory database and random local port. */
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {buildApp} from '../../server/index.js';

const app=await buildApp({databasePath:':memory:',seedPath:'missing-choice-editor-qa-seed',staticRoot:resolve('dist/web'),dailyPushScheduler:false});
async function api(url:string,payload?:unknown,method:any=payload===undefined?'GET':'POST'){
  const response=await app.inject({method,url,...(payload===undefined?{}:{payload})});
  assert.ok(response.statusCode<400,`${url}: ${response.statusCode} ${response.body}`);return response.json();
}
await api('/api/domains',{id:'CHOICE-DOMAIN',name:'选项编辑验收'});
await api('/api/categories',{id:'CHOICE-CATEGORY',domainId:'CHOICE-DOMAIN',name:'独立测试题'});
const options=()=>['A','B','C','D'].map(key=>({key,text:'原选项'+key}));
const common={answerMarkdown:'灯具有照明功能。',explanationMarkdown:'根据选项内容判断，避免只记答案字母。',categoryIds:['CHOICE-CATEGORY'],sourceRefs:[{label:'隔离测试参考',url:'https://www.w3.org/TR/html52/'}]};
const leaf=(id:string,type:'single_choice'|'multiple_choice',correctAnswers:string[])=>({id,title:'组合'+id,type,stemMarkdown:'选择符合条件的项。',answerMarkdown:common.answerMarkdown,explanationMarkdown:common.explanationMarkdown,options:options(),correctAnswers,weight:1});
for(const input of [
  {...common,id:'CHOICE-SINGLE',title:'普通单选编辑',type:'single_choice',stemMarkdown:'识别被选中选项的内容。',options:options(),correctAnswers:['D']},
  {...common,id:'CHOICE-MULTI',title:'普通多选编辑',type:'multiple_choice',stemMarkdown:'保留多个正确选项的对应关系。',options:options(),correctAnswers:['A','C','D']},
  {...common,id:'CHOICE-GROUP',title:'组合小题编辑',type:'group',stemMarkdown:'以下各小题独立选择。',parts:[leaf('p1','single_choice',['D']),leaf('p2','multiple_choice',['A','D'])]},
]){
  const question=await api('/api/questions',input);
  await api('/api/questions/review',{ids:[question.id],action:'approve',confirmed:true,expectedUpdatedAt:{[question.id]:question.updatedAt}});
}
console.log('CHOICE_EDITOR_READY '+JSON.stringify({origin:await app.listen({host:'127.0.0.1',port:0})}));
async function close(){await app.close();process.exit(0);}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
