/** Self-contained word-card presentation cases in a disposable in-memory DB. */
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {buildApp} from '../../server/index.js';
import {collectContentNotices} from '../../shared/questions/content-notices.js';
import {questionSchema} from '../../server/core/validation.js';
import type {Question} from '../../shared/models/types.js';

// These deliberately abbreviated license samples mirror the parser unit-test
// cases. They exercise exact wrappers and de-duplication, not a public corpus.
const wrapper='以下声明随单题一并保留。全包来源与变更记录另见随包 english-NOTICE.md。';
const princeton='Princeton WordNet 3.0\nWordNet Release 3.0\n\nPermission to use, copy, modify and distribute.\nThe copyright notice must appear on ALL copies.\nPrinceton may not be used in advertising.\nLICENSEE agrees to preserve same.';
const chinese='Chinese Open WordNet\nCopyright: 2013, 2014 Francis Bond, Shan Wang\n\nChinese Open WordNet\n\nPermission to use, copy, modify and distribute.\nPreserve the copyright notice and disclaimer.\nLICENSEE agrees to preserve same.';
const ecdict='ECDICT metadata only\nMIT License\n\nCopyright (c) 2025 Linwei\n\nPermission is hereby granted.\nThe above copyright notice shall be included in all copies.\nTHE SOFTWARE IS PROVIDED "AS IS".';
const license=`### 数据许可与完整署名声明\n${wrapper}\n\n\`\`\`text\n${[princeton,chinese,ecdict].join('\n\n')}\n\`\`\``;
const instruction='请回忆其英文含义、中文释义、主要词性及使用方式；可尝试先口头或书面造句，再查看释义与来源用例。';
const learning='### 学习与审核说明\n合成示例用于检验展示边界；释义、搭配和例句仍需人工审核。';
const word=questionSchema.parse({
  id:'NOTICE-ABANDON',title:'abandon',type:'short_answer',categoryIds:['notice-vocabulary'],
  stemMarkdown:`请解释 **abandon** 的含义并观察下列搭配。\n\n${instruction}`,
  answerMarkdown:'**verb / 动词 · 02228031-v**\n\n放弃；离开。',
  explanationMarkdown:[
    '### 使用方式',
    '- abandon：某人 + 动词 + 某物（WordNet 框架 8；义项 02228031-v）\n- abandon：某人 + 动词 + 某物（WordNet 框架 8；义项 02227741-v）\n- abandon：某人 + 动词 + 某人（WordNet 框架 9；义项 02228031-v）\n- abandon：某人 + 动词 + 某人（WordNet 框架 9；义项 02227741-v）',
    'We abandoned the old car in the empty parking lot.',
    '（Princeton WordNet 3.0；义项 02228031-v 原例句）',
    '### 词形变化（ECDICT 元数据）\n过去式：abandoned',learning,license,
  ].join('\n\n'),
});
const second=questionSchema.parse({
  id:'NOTICE-ABILITY',title:'ability',type:'short_answer',categoryIds:word.categoryIds,
  stemMarkdown:`请解释 **ability** 的含义。\n\n${instruction}`,
  answerMarkdown:'**noun / 名词 · 05200169-n**\n\n能力；完成某项任务的本领。',
  explanationMarkdown:`### 使用方式\n通过练习可以提升处理任务的能力。\n\n${learning}\n\n${license}`,
});
const app=await buildApp({databasePath:':memory:',seedPath:resolve('test-results/no-content-notices-seed.json'),staticRoot:resolve('dist/web'),logger:false,dailyPushScheduler:false});
async function api(url:string,payload?:unknown,method:any='POST'){
  const response=await app.inject({method,url,...(payload===undefined?{}:{payload})});assert.ok(response.statusCode<400,`${url}: ${response.statusCode} ${response.body.slice(0,400)}`);return response.json();
}
app.get('/qa/content-notices',async()=>({wordId:word.id,secondId:second.id,knowledgeId:knowledge.id,groupId:group.id,paperId:paper.id,attemptId:attempt.id,expectedNotices:collectContentNotices(noticeTexts).map(notice=>({title:notice.title,markdown:notice.markdown})),rawUnchanged:await Promise.all([word,second].map(async original=>{const question=await api(`/api/questions/${original.id}`,undefined,'GET') as Question;return {id:original.id,equal:question.stemMarkdown===original.stemMarkdown&&question.answerMarkdown===original.answerMarkdown&&question.explanationMarkdown===original.explanationMarkdown};}))}));
await api('/api/domains',{id:'notice-domain',name:'说明与许可隔离样本'});
await api('/api/categories',{id:'notice-vocabulary',domainId:'notice-domain',name:'合成英语词卡'});
for(const original of [word,second]){
  const {createdAt:_created,updatedAt:_updated,...input}=original;
  const question=await api('/api/questions',input);await api('/api/questions/review',{confirmed:true,ids:[question.id],action:'approve',expectedUpdatedAt:{[question.id]:question.updatedAt}});
}
const knowledge=await api('/api/questions',{id:'NOTICE-KNOWLEDGE',title:'软件许可证的知识内容',type:'short_answer',stemMarkdown:'MIT许可允许商业使用、修改及再分发吗？请说明其版权声明要求。',answerMarkdown:'允许。分发副本需要保留版权声明和许可声明。',explanationMarkdown:'许可授予的权利与版权归属需要分别判断；不能因为允许商用就删除原作者声明。\n\n### MIT 与 Apache 的区别\nApache 2.0还包含明确的专利授权条款。',categoryIds:word.categoryIds,sourceRefs:[{label:'英语原始词卡',url:`#/questions/${word.id}?answer=1`},{label:'MIT许可原文',url:'https://opensource.org/license/mit'}]});
await api('/api/questions/review',{confirmed:true,ids:[knowledge.id],action:'approve',expectedUpdatedAt:{[knowledge.id]:knowledge.updatedAt}});
const group=await api('/api/questions',{id:'NOTICE-GROUP',title:'组合题许可展示验收',type:'group',stemMarkdown:'阅读下面两张词卡并回答小题。',categoryIds:word.categoryIds,parts:[word,second].map((question,index)=>({id:`part-${index+1}`,title:question.title,type:'short_answer',stemMarkdown:question.stemMarkdown,answerMarkdown:question.answerMarkdown,explanationMarkdown:question.explanationMarkdown,options:[],correctAnswers:[],weight:1}))});
await api('/api/questions/review',{confirmed:true,ids:[group.id],action:'approve',expectedUpdatedAt:{[group.id]:group.updatedAt}});
const paper=await api('/api/papers',{title:'合成词卡许可去重验收卷',mode:'manual',questionIds:[word.id,second.id],scoring:{enabled:false}});
const attempt=await api(`/api/papers/${paper.id}/attempts`,{mode:'practice'});await api(`/api/attempts/${attempt.id}/submit`,{answers:{[word.id]:{value:'放弃'},[second.id]:{value:'能力'}}});
const noticeTexts=[word,second].flatMap(q=>[q.stemMarkdown,q.answerMarkdown,q.explanationMarkdown]);
const origin=await app.listen({host:'127.0.0.1',port:0});console.log('CONTENT_NOTICES_UI_READY '+JSON.stringify({origin}));
async function close(){await app.close();process.exit(0);}process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
