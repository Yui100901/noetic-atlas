import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { AttemptAnswer, Question } from '../../shared/models/types.js';
import { Store } from '../../server/core/store.js';
import { ApiError, parse, questionSchema } from '../../server/core/validation.js';
import { registerContextLearningRoutes } from '../../server/modules/practice/learning.js';
import { normalizeScoring } from '../../server/modules/practice/scoring.js';
import { flattenQuestions } from '../../server/modules/questions/structure.js';
import { getObjectiveCorrect, isSubjectiveType } from '../../shared/questions/question-utils.js';
import { registerApiDocs } from '../../server/http/openapi.js';

const stamp='2026-01-01T00:00:00.000Z';
const question=(id:string,type:Question['type']='true_false'):Question=>({...parse(questionSchema,{id,title:id,type,stemMarkdown:'原题干 '+id,answerMarkdown:'原答案 '+id,explanationMarkdown:'原解析 '+id,...(type==='true_false'?{correctAnswers:['true']}:{}),status:'published'}),id,createdAt:stamp,updatedAt:stamp});
async function fixture(t:test.TestContext){
  const store=new Store(':memory:'),app=Fastify();
  app.setErrorHandler((error,_request,reply)=>error instanceof ApiError?reply.code(error.status).send({error:{code:error.code,message:error.message}}):reply.code(500).send({error:String(error)}));
  await registerApiDocs(app,{native:true});registerContextLearningRoutes(app,store);
  t.after(async()=>{await app.close();store.db.close();});
  const get=async(path:string,expected=200)=>{const result=await app.inject(path);assert.equal(result.statusCode,expected,result.body);return result.json();};
  return {store,app,get};
}
function paper(store:Store,id:string,questions:Question[]){
  for(const q of questions)store.put('questions',q.id,q);
  store.put('papers',id,{id,title:id,description:'',mode:'manual',questionIds:questions.map(q=>q.id),questionCount:questions.length,snapshot:questions,filters:null,archived:false,version:1,createdAt:stamp,updatedAt:stamp,scoring:normalizeScoring(questions,{enabled:false})});
}
function attempt(store:Store,id:string,paperId:string,roots:Question[],answers:Record<string,AttemptAnswer>,options:{day?:number;status?:'in_progress'|'submitted';scored?:boolean;source?:'quick'|'paper';updatedAt?:string}={}){
  const questions=flattenQuestions(roots),scoring=normalizeScoring(questions,{enabled:!!options.scored}),status=options.status||'submitted',date=`2026-01-${String(options.day||1).padStart(2,'0')}`;
  const value={id,paperId,paperTitle:paperId,paperVersion:1,source:options.source||'paper',status,questions,answers,startedAt:`${date}T00:00:00.000Z`,updatedAt:options.updatedAt||`${date}T00:01:00.000Z`,submittedAt:status==='submitted'?`${date}T00:01:00.000Z`:null,elapsedSeconds:60,scoring,objectiveScore:questions.reduce((n,q)=>n+(status==='submitted'&&!isSubjectiveType(q.type)&&getObjectiveCorrect(q,answers[q.id])?scoring.questionPoints[q.id]!:0),0),objectiveMax:scoring.objectivePoints,subjectiveScore:Object.values(answers).reduce((n,a)=>n+(a.selfScore||0),0),subjectiveMax:scoring.subjectivePoints};
  store.put('attempts',id,value);return value;
}

test('wrong questions are isolated by source, latest submission wins over later regrading timestamps, and global wrongCount is irrelevant',async t=>{
  const {store,get}=await fixture(t),q=question('shared');paper(store,'A',[q]);paper(store,'B',[q]);
  store.put('study',q.id,{questionId:q.id,favorite:false,mastery:null,notes:'共用笔记',nextReviewAt:null,lastReviewedAt:null,wrongCount:999});
  attempt(store,'A-old','A',[q],{shared:{value:'false'}},{day:1,updatedAt:'2026-12-01T00:00:00.000Z'});
  attempt(store,'B-good','B',[q],{shared:{value:'true'}},{day:1});
  assert.equal((await get('/api/learning/summary?source=paper&paperId=A')).counts.wrong,1);
  assert.equal((await get('/api/learning/summary?source=paper&paperId=B')).counts.wrong,0);
  assert.equal((await get('/api/learning/summary?source=quick')).counts.wrong,0);
  let wrong=await get('/api/learning/questions?source=paper&paperId=A&kind=wrong');assert.equal(wrong.items[0].wrongCount,1);assert.equal(wrong.items[0].study.notes,'共用笔记');
  attempt(store,'A-new','A',[q],{shared:{value:'true'}},{day:2});
  assert.equal((await get('/api/learning/summary?source=paper&paperId=A')).counts.wrong,0);
  attempt(store,'A-unanswered','A',[q],{},{day:3});
  wrong=await get('/api/learning/questions?source=paper&paperId=A&kind=wrong');assert.equal(wrong.items[0].attemptId,'A-unanswered');assert.equal(wrong.items[0].answerState,'unanswered');assert.equal(wrong.items[0].wrongCount,2);
});

test('ungraded subjective submissions do not create mistakes or erase older judgments; full grades clear a mistake',async t=>{
  const {store,get}=await fixture(t),q=question('essay','short_answer');paper(store,'subjective',[q]);
  attempt(store,'ungraded','subjective',[q],{essay:{value:'主观回答'}},{scored:true,day:1});
  assert.equal((await get('/api/learning/summary?source=paper&paperId=subjective')).counts.wrong,0);
  attempt(store,'graded-wrong','subjective',[q],{essay:{value:'回答',selfScore:1}},{scored:true,day:2});
  attempt(store,'later-ungraded','subjective',[q],{essay:{value:'等待判定'}},{scored:true,day:3});
  const wrong=await get('/api/learning/questions?source=paper&paperId=subjective&kind=wrong');assert.equal(wrong.total,1);assert.equal(wrong.items[0].attemptId,'graded-wrong');
  const history=await get('/api/learning/attempts?source=paper&paperId=subjective&status=submitted');assert.equal(history.items[0].pendingSubjectiveCount,1);assert.equal(history.items[0].totalScore,null);
  attempt(store,'graded-correct','subjective',[q],{essay:{value:'回答',selfScore:3}},{scored:true,day:4});
  assert.equal((await get('/api/learning/summary?source=paper&paperId=subjective')).counts.wrong,0);
});

test('context judging preserves multiple-choice and ordered blank answer arrays with dotted and Unicode IDs',async t=>{
  const {store,get}=await fixture(t);
  const roots=[
    {...parse(questionSchema,{id:'topic.多选',title:'多选',type:'multiple_choice',stemMarkdown:'选择正确选项。',options:[{key:'A',text:'选项A'},{key:'B',text:'选项B'},{key:'C',text:'选项C'}],correctAnswers:['A','C'],status:'published'}),id:'topic.多选'},
    {...parse(questionSchema,{id:'topic.fill',title:'填空',type:'fill_blank',stemMarkdown:'依次填写两个答案。',blanks:[{id:'one',label:'第一空',answers:['Go','Golang'],caseSensitive:false,trim:true},{id:'two',label:'第二空',answers:['SQLite'],caseSensitive:true,trim:true}],status:'published'}),id:'topic.fill'},
  ] as Question[];
  paper(store,'arrays',roots);
  attempt(store,'arrays-correct','arrays',roots,{'topic.多选':{value:['C','A']},'topic.fill':{value:[' golang ','SQLite']}},{day:1});
  assert.equal((await get('/api/learning/summary?source=paper&paperId=arrays')).counts.wrong,0);
  attempt(store,'arrays-partial','arrays',roots,{'topic.多选':{value:['A']},'topic.fill':{value:['Go','sqlite']}},{day:2});
  const wrong=await get('/api/learning/questions?source=paper&paperId=arrays&kind=wrong');
  assert.deepEqual(new Set(wrong.items.map((item:any)=>item.question.id)),new Set(roots.map(q=>q.id)));
  assert.ok(wrong.items.every((item:any)=>item.answerState==='incorrect'));
  assert.deepEqual(wrong.items.find((item:any)=>item.question.type==='fill_blank').question.blanks[0].answers,['Go','Golang']);
});

test('wrong items keep immutable grouped leaf material after originals change or disappear; shared favorite/review scope remains local',async t=>{
  const {store,get}=await fixture(t);
  const group={...parse(questionSchema,{id:'group',title:'公共材料',type:'group',stemMarkdown:'原有程序材料',parts:[{id:'a',title:'小题A',type:'true_false',stemMarkdown:'小题A题干',correctAnswers:['true']},{id:'b',title:'小题B',type:'true_false',stemMarkdown:'小题B题干',correctAnswers:['true']}],status:'published'}),id:'group'}as Question;
  paper(store,'group-set',[group]);const outside=question('outside');paper(store,'outside-set',[outside]);
  store.put('study','group',{questionId:'group',favorite:true,mastery:1,notes:'公共笔记',nextReviewAt:'2000-01-01T00:00:00Z',lastReviewedAt:null,wrongCount:99});
  for(const part of group.parts!)store.putStudy({...store.study(group.id,part.id),mastery:1,nextReviewAt:'2000-01-01T00:00:00Z'});
  store.put('study','outside',{questionId:'outside',favorite:true,mastery:1,notes:'无关笔记',nextReviewAt:'2000-01-01T00:00:00Z',lastReviewedAt:null,wrongCount:99});
  attempt(store,'group-attempt','group-set',[group],{'group::a':{value:'false'},'group::b':{value:'true'}});
  store.put('questions','group',{...group,stemMarkdown:'后来修改的材料'});
  const summary=await get('/api/learning/summary?source=paper&paperId=group-set');assert.deepEqual(summary.counts,{drafts:0,submitted:1,wrong:1,due:2,favorite:2});
  const wrong=await get('/api/learning/questions?source=paper&paperId=group-set&kind=wrong');assert.equal(wrong.items[0].question.id,'group::a');assert.equal(wrong.items[0].question.groupStemMarkdown,'原有程序材料');assert.equal(wrong.items[0].question.sourceQuestionId,'group');
  const favorite=await get('/api/learning/questions?source=paper&paperId=group-set&kind=favorite');assert.equal(favorite.total,2);assert.ok(favorite.items.every((item:any)=>item.question.id.startsWith('group::')));
  store.remove('questions','group');
  assert.equal((await get('/api/learning/summary?source=paper&paperId=group-set')).counts.favorite,0);
  const kept=await get('/api/learning/questions?source=paper&paperId=group-set&kind=wrong');assert.equal(kept.items[0].question.groupStemMarkdown,'原有程序材料');assert.equal(kept.items[0].study,undefined);
});

test('favorite and due questions can use frozen unpracticed set members, without inventing attempt history',async t=>{
  const {store,get}=await fixture(t),q=question('unpracticed');paper(store,'fresh',[q]);
  store.put('study',q.id,{questionId:q.id,favorite:true,mastery:null,notes:'学习笔记',nextReviewAt:'2000-01-01T00:00:00Z',lastReviewedAt:null,wrongCount:3});
  store.put('questions',q.id,{...q,stemMarkdown:'现题库新题干'});
  const result=await get('/api/learning/questions?source=paper&paperId=fresh&kind=due');assert.equal(result.total,1);assert.equal(result.items[0].attemptId,undefined);assert.equal(result.items[0].question.stemMarkdown,q.stemMarkdown);assert.equal(result.items[0].wrongCount,0);
});

test('deleted-set contexts retain history and snapshots, quick is separate, and invalid/missing contexts fail explicitly',async t=>{
  const {store,get}=await fixture(t),q=question('old');paper(store,'deleted',[q]);paper(store,'existing',[q]);
  attempt(store,'retained','deleted',[q],{old:{value:'false'}});attempt(store,'normal','existing',[q],{old:{value:'false'}});
  const quick=attempt(store,'quick-history','quick-practice',[q],{old:{value:'true'}},{source:'quick'});store.put('attempts',quick.id,{...quick,referenceViewedAt:stamp});store.remove('papers','deleted');
  const summary=await get('/api/learning/summary?source=paper&paperId=deleted');assert.equal(summary.deleted,true);assert.equal(summary.counts.submitted,1);
  const contexts=await get('/api/learning/contexts?page=1&pageSize=10');assert.equal(contexts.total,1);assert.equal(contexts.items[0].paperId,'deleted');
  assert.equal((await get('/api/learning/questions?source=paper&paperId=deleted&kind=wrong')).total,1);
  const history=await get('/api/learning/attempts?source=quick&status=submitted');assert.equal(history.items.length,1);assert.equal(history.items[0].referenceViewedAt,stamp);
  for(const query of ['source=paper','source=quick&paperId=existing','source=invalid','source=paper&paperId=quick-practice'])await get('/api/learning/summary?'+query,400);
  await get('/api/learning/summary?source=paper&paperId=absent',404);await get('/api/learning/attempts?source=paper&paperId=existing',400);
});

test('history pages read only page-local snapshots; summary evaluates compact contextual metadata and never sends body canaries',async t=>{
  const {store,get}=await fixture(t),q={...question('canary'),stemMarkdown:'HUGE_STEM_CANARY'.repeat(100),answerMarkdown:'SECRET_REFERENCE_CANARY'.repeat(100)};paper(store,'paged',[q]);
  for(let index=1;index<=25;index++)attempt(store,`attempt-${index}`,'paged',[q],index%2?{canary:{value:'false'}}:{},{day:index});
  const other=question('other');paper(store,'unrelated',[other]);attempt(store,'unrelated-attempt','unrelated',[{...other,stemMarkdown:'UNRELATED_CANARY'}],{other:{value:'false'}});
  store.database.projections.refreshAll();
  const original=store.database.all.bind(store.database),observed:any[]=[];
  store.database.all=((query:any)=>{const rows=original(query);observed.push(...rows);return rows;})as typeof store.database.all;
  let history=await get('/api/learning/attempts?source=paper&paperId=paged&status=submitted&page=2&pageSize=10');assert.equal(history.total,25);assert.equal(history.items.length,10);assert.equal(history.items[0].id,'attempt-15');
  assert.ok(history.items.every((item:any)=>!('questions'in item)&&!('answers'in item)&&item.questionCount===1));
  assert.equal(observed.filter(row=>typeof row.data==='string'&&row.data.includes('HUGE_STEM_CANARY')).length,10);
  observed.length=0;const summary=await get('/api/learning/summary?source=paper&paperId=paged');assert.equal(summary.counts.wrong,1);assert.ok(!JSON.stringify(observed).includes('HUGE_STEM_CANARY'));assert.ok(!JSON.stringify(observed).includes('SECRET_REFERENCE_CANARY'));assert.ok(!JSON.stringify(observed).includes('UNRELATED_CANARY'));
  history=await get('/api/learning/attempts?source=paper&paperId=paged&status=submitted&page=99&pageSize=10');assert.equal(history.total,25);assert.deepEqual(history.items,[]);
  const spec=await get('/api/openapi.json');assert.ok(spec.paths['/api/learning/questions']);assert.ok(spec.paths['/api/learning/attempts'].get.responses[200].content['application/json'].schema.properties.items.items.properties.answeredCount);
});

test('context routes index source and paper together while retaining legacy attempts without a source',async t=>{
  const {store,get}=await fixture(t),q=question('indexed-question');paper(store,'indexed',[q]);paper(store,'unrelated-indexed',[q]);
  attempt(store,'modern-indexed','indexed',[q],{[q.id]:{value:'true'}},{day:1});
  const {source:_source,...legacy}=attempt(store,'legacy-indexed','indexed',[q],{[q.id]:{value:'false'}},{day:2});
  store.put('attempts',legacy.id,legacy);
  attempt(store,'unrelated-indexed-attempt','unrelated-indexed',[q],{[q.id]:{value:'false'}},{day:3});
  attempt(store,'quick-indexed','quick-practice',[q],{[q.id]:{value:'true'}},{source:'quick',day:4});
  store.database.projections.refreshAll();
  const db=store.database,original=db.all.bind(db),plans:string[][]=[];
  db.all=((query:any)=>{
    const compiled='compile'in query?query.compile():query;
    if(compiled.sql.includes('from "attempts" as "a"'))plans.push(db.explain(query).map(row=>String((row as {detail:string}).detail)));
    return original(query);
  })as typeof db.all;
  const assertIndexed=(paperScoped:boolean)=>{
    assert.ok(plans.length,'expected the route to query contextual attempts');
    for(const plan of plans){
      assert.ok(!plan.some(detail=>/SCAN a(?:\s|$)/.test(detail)),plan.join('\n'));
      const searches=plan.filter(detail=>detail.includes('SEARCH a USING INDEX attempts_source_paper_status_idx'));
      assert.ok(searches.length,plan.join('\n'));
      if(paperScoped)assert.ok(searches.every(detail=>detail.includes('(<expr>=? AND <expr>=?)')),plan.join('\n'));
    }
    plans.length=0;
  };
  const summary=await get('/api/learning/summary?source=paper&paperId=indexed');assert.equal(summary.counts.submitted,2);assert.equal(summary.counts.wrong,1);assertIndexed(true);
  const history=await get('/api/learning/attempts?source=paper&paperId=indexed&status=submitted');assert.deepEqual(history.items.map((item:any)=>[item.id,item.source]),[['legacy-indexed','paper'],['modern-indexed','paper']]);assertIndexed(true);
  const wrong=await get('/api/learning/questions?source=paper&paperId=indexed&kind=wrong');assert.equal(wrong.total,1);assert.equal(wrong.items[0].attemptId,legacy.id);assertIndexed(true);
  const quick=await get('/api/learning/summary?source=quick');assert.equal(quick.counts.submitted,1);assert.equal(quick.counts.wrong,0);assertIndexed(true);
  store.remove('papers','indexed');
  const contexts=await get('/api/learning/contexts');assert.deepEqual(contexts.items.map((item:any)=>item.paperId),['indexed']);assert.equal(contexts.items[0].counts.submitted,2);assertIndexed(false);
});

test('quick learning distinguishes an ordinary ID from another root with the same flattened leaf ID',async t=>{
  const {store,get}=await fixture(t),plain=question('x::a');
  const group={...parse(questionSchema,{id:'x',title:'另一道组合题',type:'group',stemMarkdown:'组合材料',parts:[{id:'a',title:'组合小题A',type:'true_false',stemMarkdown:'小题A',correctAnswers:['true']},{id:'b',title:'组合小题B',type:'true_false',stemMarkdown:'小题B',correctAnswers:['true']}]}),id:'x'}as Question;
  store.put('questions',plain.id,plain);store.put('questions',group.id,group);
  store.put('study',plain.id,{questionId:plain.id,favorite:true,mastery:1,notes:'独立题笔记',nextReviewAt:'2000-01-01T00:00:00Z',lastReviewedAt:null,wrongCount:99});
  store.put('study',group.id,{questionId:group.id,favorite:false,mastery:2,notes:'组合题笔记',nextReviewAt:null,lastReviewedAt:null,wrongCount:99});
  attempt(store,'plain-wrong-1','quick-practice',[plain],{'x::a':{value:'false'}},{source:'quick',day:1});
  attempt(store,'plain-wrong-2','quick-practice',[plain],{'x::a':{value:'false'}},{source:'quick',day:2});
  attempt(store,'group-wrong','quick-practice',[group],{'x::a':{value:'false'},'x::b':{value:'true'}},{source:'quick',day:3});
  attempt(store,'group-correct','quick-practice',[group],{'x::a':{value:'true'},'x::b':{value:'true'}},{source:'quick',day:4});
  let summary=await get('/api/learning/summary?source=quick');assert.deepEqual(summary.counts,{drafts:0,submitted:4,wrong:1,due:1,favorite:1});
  let wrong=await get('/api/learning/questions?source=quick&kind=wrong');assert.equal(wrong.total,1);assert.equal(wrong.items[0].attemptId,'plain-wrong-2');assert.equal(wrong.items[0].question.id,'x::a');assert.equal(wrong.items[0].question.sourceQuestionId,undefined);assert.equal(wrong.items[0].wrongCount,2);assert.equal(wrong.items[0].study.notes,'独立题笔记');
  for(const kind of ['due','favorite']){
    const result=await get(`/api/learning/questions?source=quick&kind=${kind}`);assert.equal(result.total,1);assert.equal(result.items[0].attemptId,'plain-wrong-2');assert.equal(result.items[0].wrongCount,2);
  }
  store.put('study',group.id,{...store.study(group.id),favorite:true,nextReviewAt:'2000-01-02T00:00:00Z'});
  assert.equal((await get('/api/learning/summary?source=quick')).counts.due,1,'old group dates must not schedule every part');
  for(const part of group.parts!)store.putStudy({...store.study(group.id,part.id),mastery:1,notes:'本小题笔记',nextReviewAt:'2000-01-02T00:00:00Z'});
  summary=await get('/api/learning/summary?source=quick');assert.equal(summary.counts.wrong,1);assert.equal(summary.counts.due,3);assert.equal(summary.counts.favorite,3);
  for(const kind of ['due','favorite']){
    const result=await get(`/api/learning/questions?source=quick&kind=${kind}`);assert.equal(result.total,3);
    assert.deepEqual(result.items.map((item:any)=>[item.question.sourceQuestionId||item.question.id,item.question.id,item.wrongCount]).sort(),[['x','x::a',1],['x','x::b',0],['x::a','x::a',2]].sort());
    assert.equal(result.items.filter((item:any)=>item.study.questionId==='x').length,2);
  }
  attempt(store,'plain-correct','quick-practice',[plain],{'x::a':{value:'true'}},{source:'quick',day:5});
  assert.equal((await get('/api/learning/summary?source=quick')).counts.wrong,0);
  attempt(store,'group-wrong-again','quick-practice',[group],{'x::a':{value:'false'},'x::b':{value:'true'}},{source:'quick',day:6});
  wrong=await get('/api/learning/questions?source=quick&kind=wrong');assert.equal(wrong.total,1);assert.equal(wrong.items[0].attemptId,'group-wrong-again');assert.equal(wrong.items[0].question.sourceQuestionId,'x');assert.equal(wrong.items[0].wrongCount,2);assert.equal(wrong.items[0].study.notes,'本小题笔记');
});
