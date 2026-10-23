/** Real public word-card text, loaded into a disposable in-memory database. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {buildApp} from '../../server/index.js';
import {collectContentNotices} from '../../shared/questions/content-notices.js';
import type {Question,SeedData} from '../../shared/models/types.js';

const source=JSON.parse(await readFile(resolve('data/content-packs/english.json'),'utf8')) as SeedData;
const word=source.questions.find(question=>question.title==='abandon')!;
const second=source.questions.find(question=>question.title==='ability')!;
assert.ok(word&&second,'English public pack contains the real word cards');
const app=await buildApp({databasePath:':memory:',seedPath:resolve('test-results/no-content-notices-seed.json'),staticRoot:resolve('dist/web'),logger:false});
async function api(url:string,payload?:unknown,method:any='POST'){
  const response=await app.inject({method,url,...(payload===undefined?{}:{payload})});assert.ok(response.statusCode<400,`${url}: ${response.statusCode} ${response.body.slice(0,400)}`);return response.json();
}
app.get('/qa/content-notices',async()=>({wordId:word.id,secondId:second.id,knowledgeId:knowledge.id,groupId:group.id,paperId:paper.id,attemptId:attempt.id,expectedNotices:collectContentNotices(noticeTexts).map(notice=>({title:notice.title,markdown:notice.markdown})),rawUnchanged:await Promise.all([word,second].map(async original=>{const question=await api(`/api/questions/${original.id}`,undefined,'GET') as Question;return {id:original.id,equal:question.stemMarkdown===original.stemMarkdown&&question.answerMarkdown===original.answerMarkdown&&question.explanationMarkdown===original.explanationMarkdown};}))}));
for(const domain of source.domains)await api('/api/domains',domain);
const categoryIds=new Set([word,second].flatMap(question=>question.categoryIds));
for(let size=-1;size!==categoryIds.size;){size=categoryIds.size;for(const category of source.categories)if(categoryIds.has(category.id)&&category.parentId)categoryIds.add(category.parentId);}
const categories=source.categories.filter(category=>categoryIds.has(category.id)),created=new Set<string>();
while(created.size<categories.length){const next=categories.find(category=>!created.has(category.id)&&(!category.parentId||created.has(category.parentId)));assert.ok(next,'Taxonomy is acyclic');await api('/api/categories',next);created.add(next.id);}
const tags=new Set([word,second].flatMap(question=>question.tagIds));for(const tag of source.tags)if(tags.has(tag.id))await api('/api/tags',tag);
for(const original of [word,second]){
  const {createdAt:_created,updatedAt:_updated,study:_study,...input}=original;
  const question=await api('/api/questions',input);await api('/api/questions/review',{confirmed:true,ids:[question.id],action:'approve',expectedUpdatedAt:{[question.id]:question.updatedAt}});
}
const knowledge=await api('/api/questions',{id:'NOTICE-KNOWLEDGE',title:'软件许可证的知识内容',type:'short_answer',stemMarkdown:'MIT许可允许商业使用、修改及再分发吗？请说明其版权声明要求。',answerMarkdown:'允许。分发副本需要保留版权声明和许可声明。',explanationMarkdown:'许可授予的权利与版权归属需要分别判断；不能因为允许商用就删除原作者声明。\n\n### MIT 与 Apache 的区别\nApache 2.0还包含明确的专利授权条款。',categoryIds:word.categoryIds,sourceRefs:[{label:'英语原始词卡',url:`#/questions/${word.id}?answer=1`},{label:'MIT许可原文',url:'https://opensource.org/license/mit'}]});
await api('/api/questions/review',{confirmed:true,ids:[knowledge.id],action:'approve',expectedUpdatedAt:{[knowledge.id]:knowledge.updatedAt}});
const group=await api('/api/questions',{id:'NOTICE-GROUP',title:'组合题许可展示验收',type:'group',stemMarkdown:'阅读下面两张词卡并回答小题。',categoryIds:word.categoryIds,parts:[word,second].map((question,index)=>({id:`part-${index+1}`,title:question.title,type:'short_answer',stemMarkdown:question.stemMarkdown,answerMarkdown:question.answerMarkdown,explanationMarkdown:question.explanationMarkdown,options:[],correctAnswers:[],weight:1}))});
await api('/api/questions/review',{confirmed:true,ids:[group.id],action:'approve',expectedUpdatedAt:{[group.id]:group.updatedAt}});
const paper=await api('/api/papers',{title:'真实词卡许可去重验收卷',mode:'manual',questionIds:[word.id,second.id],scoring:{enabled:false}});
const attempt=await api(`/api/papers/${paper.id}/attempts`,{mode:'practice'});await api(`/api/attempts/${attempt.id}/submit`,{answers:{[word.id]:{value:'放弃'},[second.id]:{value:'能力'}}});
const noticeTexts=[word,second].flatMap(q=>[q.stemMarkdown,q.answerMarkdown,q.explanationMarkdown]);
const origin=await app.listen({host:'127.0.0.1',port:0});console.log('CONTENT_NOTICES_UI_READY '+JSON.stringify({origin}));
async function close(){await app.close();process.exit(0);}process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
