import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../server/core/store.js';
import { questionSchema } from '../../server/core/validation.js';
import type { Question, VocabularyData } from '../../shared/models/types.js';
import { attemptView, buildPaper, createAttempt, createQuickAttempt, paperView, saveAttempt, submitAttempt, validateAttemptSnapshot } from '../../server/modules/practice/service.js';
import { resolveVocabularyQuestion, reverseVocabularyQuestion } from '../../server/modules/practice/vocabulary-practice.js';
import { questionStatistics } from '../../server/modules/questions/history.js';
import { exportData, importData } from '../../server/modules/transfer/migration.js';
import { attemptExportDocument } from '../../server/modules/transfer/exports.js';
import { exportShare, importShare, planShareImport } from '../../server/modules/sharing/routes.js';
import { buildApp } from '../../server/index.js';

const vocabulary:VocabularyData={language:'en',headword:'abandon',meaningPrompt:'放弃；遗弃；离弃',acceptedAnswers:['abandon'],pronunciations:[{label:'美式',ipa:'/əˈbændən/',sourceLabel:'IPA source',sourceUrl:'https://example.org/ipa',license:'MIT',method:'source'}]};
function fixture(t:test.TestContext){
  const store=new Store(':memory:');t.after(()=>store.db.close());
  const q=questionSchema.parse({id:'EN-V-1',title:'abandon',type:'short_answer',stemMarkdown:'abandon：解释含义',answerMarkdown:'放弃',explanationMarkdown:'I will abandon that plan. 关联词：abandoned',status:'published',vocabulary}) as Question;
  const second={...q,id:'EN-V-2',title:'retain',stemMarkdown:'retain：解释含义',answerMarkdown:'保留',explanationMarkdown:'retain the result',vocabulary:{...vocabulary,headword:'retain',meaningPrompt:'继续拥有；保持',acceptedAnswers:['retain'],pronunciations:[{...vocabulary.pronunciations[0]!,ipa:'/rɪˈteɪn/'}]}};
  const standard={...q,id:'GRAMMAR',title:'一般过去时',stemMarkdown:'解释一般过去时',vocabulary:undefined};
  for(const item of [q,second,standard])store.put('questions',item.id,item);
  const paper=buildPaper(store,{title:'高频词汇练习',description:'本组词汇',mode:'manual',practiceKind:'vocabulary',questionIds:[q.id,second.id],scoring:{enabled:false}});store.put('papers',paper.id,paper);
  return{store,q,second,standard,paper};
}

test('vocabulary is a set attribute; manual sets reject other cards and random sets filter to vocabulary',t=>{
  const{store,q,second,standard,paper}=fixture(t);assert.equal(paperView(paper).practiceKind,'vocabulary');
  assert.throws(()=>buildPaper(store,{title:'混合',description:'',mode:'manual',practiceKind:'vocabulary',questionIds:[q.id,standard.id]}),/词汇信息|词卡/);
  const random=buildPaper(store,{title:'随机',description:'',mode:'random',practiceKind:'vocabulary',count:2,scoring:{enabled:false}});assert.deepEqual(new Set(random.questionIds),new Set([q.id,second.id]));
  const plain=buildPaper(store,{title:'普通',description:'',mode:'manual',questionIds:[q.id],scoring:{enabled:false}});assert.equal(paperView(plain).practiceKind,'standard');assert.throws(()=>createAttempt(store,plain,{vocabularyDirection:'meaning_to_word'}),/词汇题集/);
});

test('every reverse set item hides word forms, IPA, examples and answers until submission',t=>{
  const{store,q,second,paper}=fixture(t),attempt=createAttempt(store,paper,{vocabularyDirection:'meaning_to_word'}),view=attemptView(attempt),serialized=JSON.stringify(view);
  for(const forbidden of ['abandon','retain','əˈbændən','rɪˈteɪn','example.org','关联词'])assert.equal(serialized.includes(forbidden),false,forbidden);
  assert.equal(view.vocabularyDirection,'meaning_to_word');assert.deepEqual(view.questions.map(row=>row.id),[q.id,second.id]);
  for(const question of view.questions){assert.equal(question.type,'fill_blank');assert.equal(question.vocabulary,undefined);assert.equal((question.blanks![0] as any).answers,undefined);}
  validateAttemptSnapshot(attempt);const tampered=structuredClone(attempt);tampered.questions[1]!.stemMarkdown+=' retain';assert.throws(()=>validateAttemptSnapshot(tampered));
  submitAttempt(store,attempt,{[q.id]:{value:[' Abandon ']},[second.id]:{value:['retain']}});assert.equal(attemptView(attempt).questions[0]!.vocabulary?.headword,'abandon');
});

test('both directions preserve points, IDs and source snapshots; resumed drafts keep direction and omissions do not count',t=>{
  const{store,q,second,paper}=fixture(t),scored=buildPaper(store,{title:paper.title,description:'',mode:'manual',practiceKind:'vocabulary',questionIds:paper.questionIds,scoring:{enabled:true,totalPoints:12,questionPoints:{[q.id]:5,[second.id]:7}}}),original=JSON.stringify(scored);
  const forward=createAttempt(store,scored);assert.equal(forward.vocabularyDirection,'word_to_meaning');assert.equal(forward.objectiveMax,0);assert.equal(forward.subjectiveMax,12);
  const reverse=createAttempt(store,scored,{vocabularyDirection:'meaning_to_word'});assert.equal(reverse.objectiveMax,12);assert.equal(reverse.subjectiveMax,0);assert.deepEqual(reverse.scoring!.questionPoints,{[q.id]:5,[second.id]:7});
  saveAttempt(store,reverse,{[q.id]:{value:['abandon']}});const resumed=store.require<typeof reverse>('attempts',reverse.id);assert.equal(resumed.vocabularyDirection,'meaning_to_word');submitAttempt(store,resumed);assert.equal(resumed.objectiveScore,5);
  assert.equal(questionStatistics(store,q.id).correct,1);assert.equal(questionStatistics(store,second.id).answered,0);assert.equal(JSON.stringify(scored),original);assert.equal(store.require<Question>('questions',q.id).type,'short_answer');
});

test('legacy set metadata is resolved by word identity for practice and portable sharing without rewriting snapshots',t=>{
  const{store,q,paper}=fixture(t),legacy=structuredClone(paper);for(const question of legacy.snapshot)delete question.vocabulary;store.put('papers',legacy.id,legacy);const frozen=JSON.stringify(legacy);
  assert.equal(resolveVocabularyQuestion(store,legacy.snapshot[0]!).vocabulary?.headword,q.title);assert.equal(createAttempt(store,legacy,{vocabularyDirection:'meaning_to_word'}).questions.length,2);
  const shared=exportShare(store,{kind:'paper',id:legacy.id});assert.equal(shared.papers[0]!.practiceKind,'vocabulary');assert.ok(shared.papers[0]!.snapshot.every(row=>row.vocabulary));
  const recipient=new Store(':memory:');t.after(()=>recipient.db.close());importShare(recipient,shared);assert.equal(recipient.all<typeof paper>('papers')[0]!.practiceKind,'vocabulary');assert.ok(recipient.all<typeof paper>('papers')[0]!.snapshot.every(row=>row.vocabulary));assert.equal(JSON.stringify(store.require('papers',legacy.id)),frozen);
  store.put('questions',q.id,{...q,title:'changed'});assert.throws(()=>createAttempt(store,legacy,{vocabularyDirection:'meaning_to_word'}),/词汇信息/);
});

test('unsafe hints fail authoring, sessions and sharing import before any attempt is saved',t=>{
  const{store,q,paper}=fixture(t),bad={...q,vocabulary:{...vocabulary,meaningPrompt:'abandon'}};store.put('questions',q.id,bad);
  assert.throws(()=>buildPaper(store,{title:'坏词集',description:'',mode:'manual',practiceKind:'vocabulary',questionIds:[q.id]}),/提示/);
  const invalid=structuredClone(paper);invalid.snapshot[0]=bad;assert.throws(()=>createAttempt(store,invalid,{vocabularyDirection:'meaning_to_word'}));
  const shared=exportShare(store,{kind:'paper',id:paper.id});shared.papers[0]!.snapshot[0]!.vocabulary!.meaningPrompt='abandon';shared.questions[0]!.vocabulary!.meaningPrompt='abandon';
  const recipient=new Store(':memory:');t.after(()=>recipient.db.close());assert.throws(()=>planShareImport(recipient,shared));
});

test('migration and exports retain kind, direction and pronunciation while reverse blank papers hide answers',t=>{
  const{store,q,second,paper}=fixture(t),target=new Store(':memory:');t.after(()=>target.db.close());const attempt=createAttempt(store,paper,{vocabularyDirection:'meaning_to_word'});submitAttempt(store,attempt,{[q.id]:{value:['abandon']},[second.id]:{value:['retain']}});
  importData(target,exportData(store));const restored=target.require<typeof attempt>('attempts',attempt.id);validateAttemptSnapshot(restored);assert.equal(target.require<typeof paper>('papers',paper.id).practiceKind,'vocabulary');assert.equal(restored.vocabularyDirection,'meaning_to_word');
  const answers=attemptExportDocument(restored,'answers').markdown;assert.match(answers,/逆向/);assert.match(answers,/əˈbændən/);const blank=attemptExportDocument(restored,'blank').markdown;for(const word of ['abandon','retain','əˈbændən'])assert.equal(blank.includes(word),false);
});

test('vocabulary sampling and exams respect the ordinary 500-item boundary and timing',t=>{
  const{store,q,paper}=fixture(t),snapshot=Array.from({length:501},(_,index)=>({...q,id:'WORD-'+index})),large={...paper,snapshot,questionIds:snapshot.map(row=>row.id),questionCount:501,scoring:undefined};
  assert.throws(()=>createAttempt(store,large,{vocabularyDirection:'meaning_to_word'}),/500/);const session=createAttempt(store,large,{vocabularyDirection:'meaning_to_word',count:100,selection:'random'});assert.equal(session.questions.length,100);assert.equal(new Set(session.questions.map(row=>row.id)).size,100);
  const exam=createAttempt(store,paper,{vocabularyDirection:'meaning_to_word',mode:'exam',durationMinutes:1});assert.equal(exam.practiceMode,'exam');assert.equal(Date.parse(exam.deadlineAt!)-Date.parse(exam.startedAt),60000);validateAttemptSnapshot(exam);
});

test('quick practice is ordinary-only while old reverse quick history remains readable and migratable',t=>{
  const{store,q}=fixture(t),quick=createQuickAttempt(store,{questionId:q.id});assert.equal(quick.vocabularyDirection,undefined);assert.equal(quick.questions[0]!.type,'short_answer');
  const legacy=structuredClone(quick);legacy.questions=[reverseVocabularyQuestion(q)];legacy.paperTitle='看释义想单词';legacy.vocabularyDirection='meaning_to_word';validateAttemptSnapshot(legacy);store.put('attempts',legacy.id,legacy);
  const recipient=new Store(':memory:');t.after(()=>recipient.db.close());importData(recipient,exportData(store));assert.equal(recipient.require<typeof legacy>('attempts',legacy.id).vocabularyDirection,'meaning_to_word');
});

test('HTTP schema removes quick directions and exposes vocabulary set directions in OpenAPI',async t=>{
  const app=await buildApp({databasePath:':memory:',seedPath:'no-vocabulary-http-seed',logger:false});t.after(()=>app.close());assert.equal((await app.inject({method:'POST',url:'/api/quick-practice',payload:{direction:'meaning_to_word'}})).statusCode,400);
  const api=(await app.inject({url:'/api/openapi.json'})).json();assert.ok(api.paths['/api/papers/{id}/attempts'].post.requestBody.content['application/json'].schema.properties.vocabularyDirection);assert.equal(api.paths['/api/quick-practice'].post.requestBody.content['application/json'].schema.properties.direction,undefined);
});
