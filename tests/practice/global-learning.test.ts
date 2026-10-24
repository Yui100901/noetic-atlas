import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { AttemptAnswer, Question } from '../../shared/models/types.js';
import { Store } from '../../server/core/store.js';
import { ApiError, parse, questionSchema } from '../../server/core/validation.js';
import { registerGlobalLearningRoutes } from '../../server/modules/practice/global-learning.js';
import { registerContextLearningRoutes } from '../../server/modules/practice/learning.js';
import { normalizeScoring } from '../../server/modules/practice/scoring.js';
import { flattenQuestions } from '../../server/modules/questions/structure.js';
import { getObjectiveCorrect, isSubjectiveType } from '../../shared/questions/question-utils.js';
import { registerApiDocs } from '../../server/http/openapi.js';

const stamp='2026-01-01T00:00:00.000Z';
const question=(id:string,type:Question['type']='true_false'):Question=>({...parse(questionSchema,{id,title:id,type,stemMarkdown:'当前原题 '+id,answerMarkdown:'答案 '+id,...(type==='true_false'?{correctAnswers:['true']}:{}),status:'published'}),id,createdAt:stamp,updatedAt:stamp});
const group=(id:string):Question=>({...parse(questionSchema,{id,title:id,type:'group',stemMarkdown:'公共材料',parts:[{id:'a',title:'子题A',type:'true_false',stemMarkdown:'A',correctAnswers:['true']},{id:'b',title:'子题B',type:'true_false',stemMarkdown:'B',correctAnswers:['true']}]}),id,createdAt:stamp,updatedAt:stamp});
async function fixture(t:test.TestContext){
  const store=new Store(':memory:'),app=Fastify();
  app.setErrorHandler((error,_request,reply)=>error instanceof ApiError?reply.code(error.status).send({error:{code:error.code,message:error.message}}):reply.code(500).send({error:String(error)}));
  await registerApiDocs(app,{native:true});registerGlobalLearningRoutes(app,store);registerContextLearningRoutes(app,store);
  t.after(async()=>{await app.close();store.db.close();});
  const get=async(path:string,expected=200)=>{const response=await app.inject(path);assert.equal(response.statusCode,expected,response.body);return response.json();};
  const cards=async(paperIds:string[],expected=200)=>{const response=await app.inject({method:'POST',url:'/api/learning/card-summaries',payload:{paperIds}});assert.equal(response.statusCode,expected,response.body);return response.json();};
  return {store,app,get,cards};
}
function paper(store:Store,id:string,roots:Question[]){
  for(const q of roots)store.put('questions',q.id,q);
  store.put('papers',id,{id,title:'题集 '+id,description:'',mode:'manual',questionIds:roots.map(q=>q.id),questionCount:roots.length,snapshot:roots,filters:null,archived:false,version:1,createdAt:stamp,updatedAt:stamp,scoring:normalizeScoring(roots,{enabled:false})});
}
function study(store:Store,id:string,favorite=true,nextReviewAt:string|null='2000-01-01T00:00:00Z'){
  store.put('study',id,{questionId:id,favorite,mastery:1,notes:'共享笔记 '+id,nextReviewAt,lastReviewedAt:null,wrongCount:999});
}
function attempt(store:Store,id:string,paperId:string,roots:Question[],answers:Record<string,AttemptAnswer>,options:{day?:number;source?:'paper'|'quick';status?:'in_progress'|'submitted';scored?:boolean;version?:number;updatedAt?:string}={}){
  const questions=flattenQuestions(roots),scoring=normalizeScoring(questions,{enabled:!!options.scored}),status=options.status||'submitted',date=`2026-01-${String(options.day||1).padStart(2,'0')}`,source=options.source||'paper';
  const value={id,source,paperId,paperTitle:source==='quick'?'随机练习':'历史题集 '+paperId,paperVersion:options.version||1,status,questions,answers,startedAt:`${date}T00:00:00.000Z`,submittedAt:status==='submitted'?`${date}T00:01:00.000Z`:null,updatedAt:options.updatedAt||`${date}T00:01:00.000Z`,elapsedSeconds:60,scoring,objectiveScore:questions.reduce((n,q)=>n+(status==='submitted'&&!isSubjectiveType(q.type)&&getObjectiveCorrect(q,answers[q.id])?scoring.questionPoints[q.id]!:0),0),objectiveMax:scoring.objectivePoints,subjectiveScore:Object.values(answers).reduce((n,a)=>n+(a.selfScore||0),0),subjectiveMax:scoring.subjectivePoints};
  store.put('attempts',id,value);return value;
}

test('global mistakes merge still-wrong contexts with complete provenance, frozen latest error, quick and deleted sources',async t=>{
  const {store,get}=await fixture(t),q=question('shared');for(const name of ['A','B','deleted'])paper(store,name,[q]);study(store,q.id);
  attempt(store,'A-wrong','A',[{...q,stemMarkdown:'A错误快照'}],{shared:{value:'false'}},{day:1,updatedAt:'2026-12-01T00:00:00Z'});
  attempt(store,'B-wrong','B',[{...q,stemMarkdown:'B错误快照'}],{shared:{value:'false'}},{day:2,version:2});
  attempt(store,'quick-wrong','quick-practice',[{...q,stemMarkdown:'随机错误快照'}],{},{source:'quick',day:3});
  attempt(store,'deleted-wrong','deleted',[{...q,stemMarkdown:'已删除来源快照'}],{shared:{value:'false'}},{day:4,version:3});
  attempt(store,'A-correct','A',[q],{shared:{value:'true'}},{day:5});
  store.remove('papers','deleted');store.put('questions',q.id,{...q,stemMarkdown:'后来编辑的新原题'});
  const result=await get('/api/learning/global/questions?kind=wrong');assert.equal(result.total,1);const item=result.items[0];
  assert.equal(item.key,JSON.stringify(['shared','shared']));assert.equal(item.question.stemMarkdown,'已删除来源快照');assert.equal(item.snapshotSource,'attempt');assert.equal(item.attemptId,'deleted-wrong');assert.equal(item.wrongCount,3);assert.equal(item.study.notes,'共享笔记 shared');
  assert.deepEqual(item.origins.map((origin:any)=>origin.attemptId),['deleted-wrong','quick-wrong','B-wrong']);
  assert.equal(item.origins[0].deleted,true);assert.equal(item.origins[0].paperId,'deleted');assert.equal(item.origins[0].paperVersion,3);assert.equal(item.origins[0].submittedAt,'2026-01-04T00:01:00.000Z');
  assert.equal(item.origins[1].source,'quick');assert.equal(item.origins[1].answerState,'unanswered');assert.equal(item.origins[2].answerState,'incorrect');assert.equal(item.origins[2].wrongCount,1);
  assert.deepEqual((await get('/api/learning/global/summary')).counts,{wrong:1,favorite:1,due:1});
  store.remove('questions',q.id);const kept=await get('/api/learning/global/questions?kind=wrong');assert.equal(kept.items[0].question.stemMarkdown,'已删除来源快照');assert.equal(kept.items[0].study,undefined);
  assert.deepEqual((await get('/api/learning/global/summary')).counts,{wrong:1,favorite:0,due:0});
});

test('global favorites and review include untouched library originals, current leaves and all memberships/retained latest attempts',async t=>{
  const {store,get}=await fixture(t),untouched=question('untouched'),g=group('group');store.put('questions',untouched.id,untouched);study(store,untouched.id);paper(store,'members',[g]);study(store,g.id);
  attempt(store,'group-history','members',[{...g,stemMarkdown:'旧公共材料'}],{'group::a':{value:'false'},'group::b':{value:'true'}},{day:1});
  store.put('questions',g.id,{...g,stemMarkdown:'当前公共材料'});
  for(const kind of ['favorite','due']){
    const result=await get(`/api/learning/global/questions?kind=${kind}`);assert.equal(result.total,3);
    const plain=result.items.find((item:any)=>item.question.id==='untouched');assert.equal(plain.snapshotSource,'library');assert.equal(plain.attemptId,undefined);assert.deepEqual(plain.origins,[{source:'library',paperTitle:'知识题库',questionId:'untouched'}]);
    const leaf=result.items.find((item:any)=>item.question.id==='group::a');assert.equal(leaf.question.groupStemMarkdown,'当前公共材料');assert.equal(leaf.snapshotSource,'library');assert.equal(leaf.attemptId,undefined);assert.equal(leaf.wrongCount,1);assert.equal(leaf.origins.length,2);assert.ok(leaf.origins.some((origin:any)=>origin.paperId==='members'&&!origin.attemptId));assert.ok(leaf.origins.some((origin:any)=>origin.attemptId==='group-history'));
  }
  store.remove('papers','members');const favorite=await get('/api/learning/global/questions?kind=favorite');const leaf=favorite.items.find((item:any)=>item.question.id==='group::a');assert.equal(leaf.origins.length,1);assert.equal(leaf.origins[0].deleted,true);assert.equal(leaf.origins[0].attemptId,'group-history');
});

test('batch card counts match source summaries in one indexed metadata batch, including drafts, missing source and deleted sets',async t=>{
  const {store,get,cards}=await fixture(t),q=question('card-shared');for(let index=0;index<20;index++)paper(store,`card-${index}`,[q]);study(store,q.id);
  const {source:_source,...legacy}=attempt(store,'legacy-card','card-0',[q],{[q.id]:{value:'false'}});store.put('attempts',legacy.id,legacy);
  attempt(store,'draft-card','card-0',[q],{},{day:2,status:'in_progress'});attempt(store,'correct-card','card-1',[q],{[q.id]:{value:'true'}},{day:3});store.remove('papers','card-1');
  store.database.projections.refreshAll();
  const db=store.database,original=db.all.bind(db),queries:any[]=[];
  db.all=((query:any)=>{queries.push(query);return original(query);})as typeof db.all;
  const ids=['card-1','card-0',...Array.from({length:18},(_,index)=>`card-${index+2}`),'missing'],batch=await cards(ids);
  assert.deepEqual(batch.items.map((item:any)=>item.paperId),ids);assert.equal(queries.length,3,'attempts, paper metadata and shared state should each use one batch');
  const attemptQuery=queries.find(query=>query.compile().sql.includes('from "attempts" as "a"'));assert.ok(attemptQuery);const plan=db.explain(attemptQuery).map(row=>String((row as any).detail));assert.ok(!plan.some(detail=>/SCAN a(?:\s|$)/.test(detail)),plan.join('\n'));assert.ok(plan.some(detail=>detail.includes('attempts_source_paper_status_idx')&&detail.includes('(<expr>=? AND <expr>=?)')),plan.join('\n'));
  for(const item of batch.items.filter((item:any)=>item.paperId!=='missing'))assert.deepEqual(item.counts,(await get(`/api/learning/summary?source=paper&paperId=${item.paperId}`)).counts);
  assert.deepEqual(batch.items.at(-1).counts,{drafts:0,submitted:0,wrong:0,favorite:0,due:0});
  await cards([],400);await cards(['card-0','card-0'],400);await cards(Array.from({length:101},(_,i)=>`id-${i}`),400);await cards(['invalid id'],400);
});

test('global pages hydrate only selected snapshots; summaries/cards exclude bodies and notes and never write even with dirty projections',async t=>{
  const {store,get,cards}=await fixture(t),roots=Array.from({length:25},(_,i)=>({...question(`page-${i+1}`),stemMarkdown:'HUGE_BODY_CANARY'.repeat(100),answerMarkdown:'REFERENCE_CANARY'.repeat(100)}));paper(store,'paged',roots);
  roots.forEach((q,index)=>attempt(store,`attempt-${index+1}`,'paged',[q],{[q.id]:{value:'false'}},{day:index+1}));study(store,roots[0]!.id);store.put('study',roots[0]!.id,{...store.study(roots[0]!.id),notes:'PRIVATE_NOTE_CANARY'});
  const subjective=question('subjective','short_answer');paper(store,'other',[subjective]);attempt(store,'private-answer','other',[subjective],{subjective:{value:'PRIVATE_ANSWER_CANARY'}},{scored:true});
  const db=store.database,originalAll=db.all.bind(db),originalOne=db.one.bind(db),observed:any[]=[];
  db.all=((query:any)=>{const rows=originalAll(query);observed.push(...rows);return rows;})as typeof db.all;
  db.one=((query:any)=>{const row=originalOne(query);if(row)observed.push(row);return row;})as typeof db.one;
  const changes=()=>Number((db.prepare('select total_changes() as count').get() as any).count),before=changes();
  const summary=await get('/api/learning/global/summary');assert.deepEqual(summary.counts,{wrong:25,favorite:1,due:1});await cards(['paged','other']);
  assert.ok(!JSON.stringify(observed).includes('HUGE_BODY_CANARY'));assert.ok(!JSON.stringify(observed).includes('REFERENCE_CANARY'));assert.ok(!JSON.stringify(observed).includes('PRIVATE_NOTE_CANARY'));assert.ok(!JSON.stringify(observed).includes('PRIVATE_ANSWER_CANARY'));
  observed.length=0;const page=await get('/api/learning/global/questions?kind=wrong&page=2&pageSize=10');assert.equal(page.total,25);assert.equal(page.items.length,10);assert.equal(page.items[0].attemptId,'attempt-15');
  assert.equal(observed.filter(row=>typeof row.data==='string'&&row.data.includes('HUGE_BODY_CANARY')).length,10);assert.equal(changes(),before,'global/card reads must not update even dirty derived projections');
  const empty=await get('/api/learning/global/questions?kind=wrong&page=99&pageSize=10');assert.equal(empty.total,25);assert.deepEqual(empty.items,[]);
  for(const query of ['','kind=other','kind=wrong&page=0','kind=wrong&pageSize=11','kind=wrong&paperId=paged'])await get('/api/learning/global/questions?'+query,400);
  await get('/api/learning/global/summary?source=quick',400);
  const spec=await get('/api/openapi.json');assert.ok(spec.paths['/api/learning/global/questions'].get.responses[200].content['application/json'].schema.properties.items.items.properties.origins.items.properties.attemptId);assert.equal(spec.paths['/api/learning/card-summaries'].post.requestBody.content['application/json'].schema.properties.paperIds.maxItems,100);
});

test('global and card identities keep ordinary delimiter IDs separate from same-named group leaves',async t=>{
  const {store,get,cards}=await fixture(t),plain=question('x::a'),g=group('x');paper(store,'changed',[plain]);study(store,plain.id);store.put('questions',g.id,g);study(store,g.id);
  attempt(store,'plain-wrong','changed',[plain],{'x::a':{value:'false'}},{day:1});paper(store,'changed',[g]);attempt(store,'group-correct','changed',[g],{'x::a':{value:'true'},'x::b':{value:'true'}},{day:2});
  const wrong=await get('/api/learning/global/questions?kind=wrong');assert.equal(wrong.total,1);assert.equal(wrong.items[0].key,JSON.stringify(['x::a','x::a']));assert.equal(wrong.items[0].attemptId,'plain-wrong');assert.equal(wrong.items[0].wrongCount,1);
  const favorites=await get('/api/learning/global/questions?kind=favorite');assert.equal(favorites.total,3);assert.equal(new Set(favorites.items.map((item:any)=>item.key)).size,3);assert.equal(favorites.items.find((item:any)=>item.key===JSON.stringify(['x','x::a'])).wrongCount,0);
  assert.deepEqual((await cards(['changed'])).items[0].counts,{drafts:0,submitted:2,wrong:1,favorite:3,due:3});
});

test('global subjective judgments preserve older mistakes through ungraded attempts without cross-context clearing',async t=>{
  const {store,get,cards}=await fixture(t),q=question('essay','short_answer');paper(store,'A',[q]);paper(store,'B',[q]);
  attempt(store,'A-graded','A',[q],{essay:{value:'graded',selfScore:1}},{scored:true,day:1,updatedAt:'2026-12-01T00:00:00Z'});
  attempt(store,'A-ungraded','A',[q],{essay:{value:'pending'}},{scored:true,day:2});attempt(store,'B-full','B',[q],{essay:{value:'full',selfScore:3}},{scored:true,day:3});
  const wrong=await get('/api/learning/global/questions?kind=wrong');assert.equal(wrong.total,1);assert.equal(wrong.items[0].attemptId,'A-graded');assert.equal(wrong.items[0].origins.length,1);assert.equal(wrong.items[0].origins[0].paperId,'A');
  assert.deepEqual((await cards(['A','B'])).items.map((item:any)=>item.counts.wrong),[1,0]);
});

test('global provenance retains every still-wrong source without an implicit limit',async t=>{
  const {store,get}=await fixture(t),q=question('many-sources');store.put('questions',q.id,q);
  for(let index=0;index<125;index++)attempt(store,`source-${index}`,`deleted-${index}`,[q],{[q.id]:{value:'false'}});
  const result=await get('/api/learning/global/questions?kind=wrong&pageSize=10');assert.equal(result.total,1);assert.equal(result.items[0].origins.length,125);assert.equal(result.items[0].wrongCount,125);assert.ok(result.items[0].origins.every((origin:any)=>origin.deleted));
});

test('read-only card/provenance queries use current members when a persisted paper projection becomes dirty',async t=>{
  const {store,get,cards}=await fixture(t),old=question('old-member'),next=question('new-member');paper(store,'edited',[old]);study(store,old.id);store.database.projections.refreshAll();
  store.put('questions',next.id,next);study(store,next.id);
  const saved=store.require<any>('papers','edited');store.put('papers','edited',{...saved,version:2,title:'编辑后的题集',questionIds:[next.id],snapshot:[next],updatedAt:'2026-02-01T00:00:00Z'});
  const changes=()=>Number((store.db.prepare('select total_changes() as count').get() as any).count),before=changes();
  assert.deepEqual((await cards(['edited'])).items[0].counts,{drafts:0,submitted:0,wrong:0,favorite:1,due:1});
  const favorites=await get('/api/learning/global/questions?kind=favorite'),newItem=favorites.items.find((item:any)=>item.question.id===next.id),oldItem=favorites.items.find((item:any)=>item.question.id===old.id);
  assert.deepEqual(oldItem.origins,[{source:'library',paperTitle:'知识题库',questionId:old.id}]);assert.equal(newItem.origins.length,1);assert.equal(newItem.origins[0].paperTitle,'编辑后的题集');assert.equal(newItem.origins[0].paperVersion,2);assert.equal(changes(),before);
});
