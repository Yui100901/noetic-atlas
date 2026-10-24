import test from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../../server/index.js';
import {learningSeed,fixtureQuestion} from '../fixtures/learning-seed.js';
import type {Question} from '../../shared/models/types.js';
import {normalizeScoring} from '../../server/modules/practice/scoring.js';
import {DEFAULT_SETTINGS} from '../../shared/models/settings.js';

function result(response:any,status=200):any {assert.equal(response.statusCode,status,response.body);return response.json();}
async function fixture(t:test.TestContext) {
  const app=await buildApp({databasePath:':memory:',seedPath:'no-question-set-test-seed',staticRoot:'no-question-set-test-web'});
  t.after(()=>app.close());
  result(await app.inject({method:'POST',url:'/api/import',payload:{mode:'merge',data:learningSeed()}}));
  return app;
}
test('question set browsing uses its saved answer snapshot after the source changes and enforces membership',async t=>{
  const app=await fixture(t);
  const source=result(await app.inject('/api/questions/FIXTURE-SHORT-1'));
  const paper=result(await app.inject({method:'POST',url:'/api/papers',payload:{title:'快照题集',mode:'manual',questionIds:[source.id],scoring:{enabled:false}}}),201);
  result(await app.inject({method:'PUT',url:`/api/questions/${source.id}`,payload:{...source,answerMarkdown:'原题的新答案',explanationMarkdown:'原题的新解析'}}));
  const saved=result(await app.inject(`/api/papers/${paper.id}/questions/${source.id}`));
  assert.equal(saved.answerMarkdown,source.answerMarkdown);assert.equal(saved.explanationMarkdown,source.explanationMarkdown);
  result(await app.inject(`/api/papers/${paper.id}/questions/FIXTURE-SHORT-2`),404);
  result(await app.inject({method:'DELETE',url:`/api/papers/${paper.id}`}));
  assert.equal(result(await app.inject(`/api/papers/${paper.id}/questions/${source.id}`)).answerMarkdown,source.answerMarkdown);
});
test('large question sets remain intact for browsing and require explicit bounded practice selection',async t=>{
  const app=await fixture(t);
  const questions=Array.from({length:501},(_,index)=>fixtureQuestion(`SET-${index}`,'true_false'));
  result(await app.inject({method:'POST',url:'/api/import',payload:{mode:'merge',data:{...learningSeed(),questions,papers:[{id:'large-set',title:'完整大型题集',description:'',mode:'manual',questionIds:questions.map(q=>q.id),filters:null,scoring:normalizeScoring(questions,{enabled:false})}]}}}));
  const paper=result(await app.inject('/api/papers/large-set'));assert.equal(paper.questionCount,501);
  assert.equal(result(await app.inject('/api/papers/large-set/questions/SET-500')).id,'SET-500');
  result(await app.inject({method:'POST',url:'/api/papers/large-set/attempts'}),422);
  const attempt=result(await app.inject({method:'POST',url:'/api/papers/large-set/attempts',payload:{count:20,selection:'ordered'}}),201);
  assert.deepEqual(attempt.questions.map((q:any)=>q.id),questions.slice(0,20).map(q=>q.id));
  assert.equal(result(await app.inject('/api/papers/large-set')).questionCount,501);
  const random=result(await app.inject({method:'POST',url:'/api/papers/large-set/attempts',payload:{count:30,selection:'random'}}),201);
  assert.equal(random.questions.length,30);assert.equal(new Set(random.questions.map((q:any)=>q.id)).size,30);
  result(await app.inject({method:'POST',url:'/api/papers/large-set/attempts',payload:{count:501}}),400);
  assert.match((await app.inject('/api/papers/large-set/export?answers=true')).body,/SET-500/);
  const questionIds=questions.map(question=>question.id);
  const edited=result(await app.inject({method:'PUT',url:'/api/papers/large-set',payload:{title:'编辑后仍完整',mode:'manual',questionIds,scoring:{enabled:false}}}));
  assert.equal(edited.questionCount,501);assert.deepEqual(edited.questionIds,questionIds);
  const state={title:edited.title,description:'',mode:'manual',organization:'other',domainId:'',questionIds,filters:{},random:{},count:20,enabled:false,total:100,objectivePercent:60,pointsByType:{...DEFAULT_SETTINGS.pointsByType},overrides:{},autoTotal:true};
  const draft=result(await app.inject({method:'POST',url:'/api/paper-drafts',payload:{context:edited.id,state}}),201);
  assert.deepEqual(draft.state.questionIds,questionIds);
  assert.deepEqual(result(await app.inject(`/api/paper-drafts?context=${edited.id}`))[0].state.questionIds,questionIds);
});
test('selecting a subset recalculates session scores without changing the original set and exam guard blocks answer browsing',async t=>{
  const app=await fixture(t),ids=['FIXTURE-CHOICE-1','FIXTURE-CHOICE-2','FIXTURE-BOOL'];
  const paper=result(await app.inject({method:'POST',url:'/api/papers',payload:{title:'计分题集',mode:'manual',questionIds:ids,scoring:{enabled:true,totalPoints:6,questionPoints:Object.fromEntries(ids.map(id=>[id,2]))}}}),201);
  const attempt=result(await app.inject({method:'POST',url:`/api/papers/${paper.id}/attempts`,payload:{count:2,selection:'ordered',mode:'exam',durationMinutes:1}}),201);
  assert.equal(attempt.scoring.totalPoints,4);assert.equal(attempt.questions.length,2);
  result(await app.inject(`/api/papers/${paper.id}/questions/${ids[0]}`),409);
  result(await app.inject({method:'POST',url:`/api/attempts/${attempt.id}/submit`,payload:{answers:{}}}));
  assert.equal(result(await app.inject(`/api/papers/${paper.id}`)).scoring.totalPoints,6);
});
