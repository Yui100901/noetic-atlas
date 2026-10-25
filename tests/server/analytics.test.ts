import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../../server/core/store.js';
import {questionSchema} from '../../server/core/validation.js';
import {DEFAULT_SETTINGS} from '../../shared/models/settings.js';
import {buildPaper,createAttempt,submitAttempt,reviewAttempt,saveAttempt,type StoredPaper,type StoredAttempt} from '../../server/modules/practice/service.js';
import {preserveLearningResults} from '../../server/modules/practice/learning-results.js';
import {learningAnalytics,weeklyReport} from '../../server/modules/analytics/service.js';
import {analyticsQuerySchema,weeklyQuerySchema} from '../../server/modules/analytics/schema.js';
import {calendar} from '../../server/modules/analytics/calendar.js';
import {learningResetPreview,resetLearningProgress} from '../../server/modules/study/reset.js';
import {exportData,importData} from '../../server/modules/transfer/migration.js';

const now=new Date('2026-10-25T04:00:00.000Z');
const range={from:'2026-10-19',to:'2026-10-25',timeZone:'Asia/Shanghai'};
function fixture(t:test.TestContext){
  const store=new Store(':memory:');t.after(()=>store.db.close());
  store.put('settings','system',structuredClone(DEFAULT_SETTINGS));
  for(const id of ['one','two']){store.put('domains',id,{id,name:id==='one'?'计算机':'语言',description:'',sortOrder:0});store.put('categories','cat-'+id,{id:'cat-'+id,domainId:id,parentId:null,name:'分类'+id,description:'',sortOrder:0});}
  const questions=[
    questionSchema.parse({id:'tf',title:'判断',type:'true_false',stemMarkdown:'QUESTION_PRIVATE_CANARY',answerMarkdown:'REFERENCE_PRIVATE_CANARY',correctAnswers:['true'],categoryIds:['cat-one'],status:'published'}),
    questionSchema.parse({id:'short',title:'简答',type:'short_answer',stemMarkdown:'QUESTION_PRIVATE_CANARY',answerMarkdown:'REFERENCE_PRIVATE_CANARY',categoryIds:['cat-one'],status:'published'}),
    questionSchema.parse({id:'group',title:'组合',type:'group',stemMarkdown:'MATERIAL_PRIVATE_CANARY',categoryIds:['cat-one'],status:'published',parts:[{id:'a',title:'判断小题',type:'true_false',stemMarkdown:'判断',correctAnswers:['true']},{id:'b',title:'简答小题',type:'short_answer',stemMarkdown:'简答',answerMarkdown:'REFERENCE_PRIVATE_CANARY'}]}),
  ];
  for(const q of questions)store.put('questions',q.id,q);
  const paper=buildPaper(store,{id:'paper',title:'统计隔离题集',description:'',mode:'manual',organization:'domain',domainId:'one',questionIds:questions.map(q=>q.id),scoring:{enabled:true,totalPoints:12,questionPoints:{tf:2,short:4,group:6}}});store.put('papers',paper.id,paper);
  const full={tf:{value:['true']},short:{value:'STUDENT_PRIVATE_CANARY'},'group::a':{value:['false']},'group::b':{value:'STUDENT_PRIVATE_CANARY'}};
  return {store,paper,full,stats:()=>learningAnalytics(store,range,now)};
}
function submitted(store:Store,paper:StoredPaper,answers:Parameters<typeof submitAttempt>[2],at:string,elapsedSeconds?:number){
  const attempt=submitAttempt(store,createAttempt(store,paper),answers);attempt.startedAt=new Date(Date.parse(at)-60000).toISOString();attempt.submittedAt=at;attempt.updatedAt=at;
  if(elapsedSeconds===undefined)delete attempt.elapsedSeconds;else attempt.elapsedSeconds=elapsedSeconds;
  store.put('attempts',attempt.id,attempt);preserveLearningResults(store,attempt);return attempt;
}

test('analytics counts actual answers, omissions and pending grades independently; accuracy excludes partial and pending from numerator',t=>{
  const {store,paper,full,stats}=fixture(t);const draft=createAttempt(store,paper);saveAttempt(store,draft,full);assert.equal(stats().summary.sessions,0);
  const attempt=submitted(store,paper,full,'2026-10-21T02:00:00.000Z',90);let result=stats();
  assert.equal(result.summary.sessions,1);assert.equal(result.summary.answers,4);assert.equal(result.summary.uniqueItems,4);assert.equal(result.summary.uniqueQuestions,3);
  assert.equal(result.summary.correct,1);assert.equal(result.summary.incorrect,1);assert.equal(result.summary.ungraded,2);assert.equal(result.summary.accuracy,50);assert.equal(result.summary.elapsedSeconds,90);assert.equal(result.summary.activeDays,1);
  reviewAttempt(store,attempt,{short:2,'group::b':0});result=stats();assert.equal(result.summary.partial,1);assert.equal(result.summary.incorrect,2);assert.equal(result.summary.ungraded,0);assert.equal(result.summary.accuracy,25);
  const again=submitted(store,paper,{tf:{value:['true']}},'2026-10-22T02:00:00.000Z',30);assert.ok(again.id!==attempt.id);result=stats();
  assert.equal(result.summary.answers,5);assert.equal(result.summary.uniqueItems,4);assert.equal(result.summary.omitted,3);assert.equal(result.summary.sessions,2);assert.equal(result.summary.activeDays,2);assert.equal(result.summary.elapsedSeconds,120);
  assert.equal(result.types.find(row=>row.id==='true_false')!.answers,3);assert.equal(result.types.find(row=>row.id==='short_answer')!.answers,2);
});

test('empty submissions do not create active days or duration; manual and attempt review events remain separate',t=>{
  const {store,paper,stats}=fixture(t);submitted(store,paper,{},'2026-10-20T03:00:00.000Z',800);
  store.put('reviews','manual-review',{id:'manual-review',questionId:'tf',mastery:2,reviewedAt:'2026-10-23T10:00:00.000Z',source:'manual'});
  store.put('reviews','attempt-review',{id:'attempt-review',questionId:'group',partId:'a',mastery:1,reviewedAt:'2026-10-24T10:00:00.000Z',source:'attempt',attemptId:'old'});
  const result=stats();assert.equal(result.summary.sessions,1);assert.equal(result.summary.answeredSessions,0);assert.equal(result.summary.omitted,4);assert.equal(result.summary.elapsedSeconds,0);assert.equal(result.summary.timedSessions,0);assert.equal(result.summary.reviewEvents,2);assert.equal(result.summary.answers,0);assert.equal(result.summary.activeDays,2);assert.equal(result.summary.accuracy,null);
});

test('compact metadata survives whole-history pruning, question deletion and complete migration without duplicate counting',t=>{
  const {store,paper,full,stats}=fixture(t);store.put('settings','system',{...structuredClone(DEFAULT_SETTINGS),maxHistoryPerPaper:1});
  const original=submitted(store,paper,full,'2026-10-21T02:00:00.000Z',65);submitted(store,paper,{},'2026-10-22T02:00:00.000Z',999);
  assert.equal(store.get('attempts',original.id),undefined);
  const result=stats();assert.equal(result.summary.answers,4);assert.equal(result.summary.sessions,2);assert.equal(result.summary.elapsedSeconds,65);assert.equal(result.summary.omitted,4);assert.equal(result.summary.timedSessions,1);assert.equal(result.summary.ungraded,2);assert.equal(result.types.length,2);assert.equal(result.domains[0]!.answers,4);
  const target=new Store(':memory:');t.after(()=>target.db.close());importData(target,exportData(store));assert.deepEqual(learningAnalytics(target,range,now),result);
  for(const id of ['tf','short','group'])store.remove('questions',id);assert.deepEqual(stats(),result);
});

test('reset markers exclude retained historical sheets and erased compact evidence cannot reseed statistics',t=>{
  const {store,paper,full,stats}=fixture(t);const original=submitted(store,paper,full,'2026-10-21T02:00:00.000Z',65);
  resetLearningProgress(store,learningResetPreview(store).fingerprint);let result=stats();assert.equal(result.summary.sessions,0);assert.equal(result.summary.answers,0);assert.equal(result.quality.resetExcludedSessions,1);assert.ok(store.get('attempts',original.id));
  submitted(store,paper,{tf:{value:['true']}},'2026-10-24T02:00:00.000Z',15);result=stats();assert.equal(result.summary.sessions,1);assert.equal(result.summary.answers,1);assert.equal(result.summary.elapsedSeconds,15);
});

test('old compact metadata recovers from retained projections but missing pruned fields remain explicitly unknown',t=>{
  const {store,paper,full,stats}=fixture(t);const original=submitted(store,paper,full,'2026-10-21T02:00:00.000Z',65);
  const legacy=store.require<any>('learning_results',original.id);delete legacy.elapsedSeconds;for(const item of legacy.items){delete item.answered;delete item.type;delete item.categoryIds;delete item.tagIds;delete item.difficulty;}
  store.put('learning_results',original.id,legacy);assert.equal(stats().summary.answers,4);assert.equal(stats().summary.elapsedSeconds,65);assert.equal(stats().quality.missingTypeAnswers,0);
  store.remove('attempts',original.id);store.database.run(store.database.query.deleteFrom('question_history'));let result=stats();assert.equal(result.summary.answers,0);assert.equal(result.summary.unknown,4);assert.equal(result.summary.accuracy,null);assert.equal(result.quality.unknownAnswerItems,4);
  legacy.items[0].answered=true;store.put('learning_results',original.id,legacy);result=stats();assert.equal(result.summary.answers,1);assert.equal(result.summary.missingTimeSessions,1);assert.equal(result.summary.elapsedSeconds,0);assert.equal(result.quality.missingTypeAnswers,1);assert.equal(result.domains[0]!.id,'[unclassified]');
});

test('same attempt appears once and domain overlap is explicit rather than silently changing the overall denominator',t=>{
  const {store,paper,full,stats}=fixture(t);paper.snapshot[0]!.categoryIds=['cat-one','cat-two'];store.put('papers',paper.id,paper);
  const attempt=submitted(store,paper,full,'2026-10-21T02:00:00.000Z',65);const original=stats();assert.equal(original.summary.sessions,1);assert.equal(original.summary.answers,4);assert.equal(original.domains.find(row=>row.id==='one')!.answers,4);assert.equal(original.domains.find(row=>row.id==='two')!.answers,1);assert.ok(original.quality.warnings.some(value=>value.includes('不能相加')));
  preserveLearningResults(store,attempt);assert.deepEqual(stats(),original);
});

test('a real domain named unknown never absorbs the unclassified sentinel',t=>{
  const {store,paper,full,stats}=fixture(t);store.put('domains','unknown',{id:'unknown',name:'真实unknown领域',description:'',sortOrder:0});store.put('categories','cat-unknown',{id:'cat-unknown',domainId:'unknown',parentId:null,name:'真实分类',description:'',sortOrder:0});
  paper.snapshot[0]!.categoryIds=['cat-unknown'];paper.snapshot[1]!.categoryIds=[];store.put('papers',paper.id,paper);submitted(store,paper,full,'2026-10-21T02:00:00.000Z',20);
  const result=stats();assert.equal(result.domains.find(row=>row.id==='unknown')!.label,'真实unknown领域');assert.equal(result.domains.find(row=>row.id==='unknown')!.answers,1);assert.equal(result.domains.find(row=>row.id==='[unclassified]')!.answers,1);
});

test('time-zone boundaries, offset timestamps and partial current weeks compare the same elapsed span',t=>{
  const {store,paper}=fixture(t);
  submitted(store,paper,{tf:{value:['true']}},'2026-10-18T16:00:00.000Z',10); // Monday in Shanghai.
  submitted(store,paper,{tf:{value:['true']}},'2026-10-18T23:59:59+08:00',10); // Sunday, excluded.
  submitted(store,paper,{tf:{value:['true']}},'2026-10-12T04:00:00.000Z',10);
  submitted(store,paper,{tf:{value:['true']}},'2026-10-18T10:00:00.000Z',10); // Later than matched Sunday noon.
  assert.equal(learningAnalytics(store,{from:'2026-10-19',to:'2026-10-19',timeZone:'Asia/Shanghai'},now).summary.sessions,1);
  assert.equal(learningAnalytics(store,{from:'2026-10-19',to:'2026-10-19',timeZone:'UTC'},now).summary.sessions,0);
  const weekly=weeklyReport(store,{week:'2026-10-25',timeZone:'Asia/Shanghai'},now);assert.equal(weekly.weekStart,'2026-10-19');assert.equal(weekly.weekEnd,'2026-10-25');assert.equal(weekly.isCurrentWeek,true);assert.equal(weekly.comparison.mode,'matched_elapsed');assert.equal(weekly.comparison.summary.sessions,1);assert.equal(weekly.current.summary.sessions,1);
  const old=weeklyReport(store,{week:'2026-10-15',timeZone:'Asia/Shanghai'},now);assert.equal(old.comparison.mode,'full_week');assert.equal(old.current.summary.sessions,3);
  const dst=calendar('America/New_York');assert.equal(dst.start('2026-03-09')-dst.start('2026-03-08'),23*3600000);assert.equal(dst.start('2026-11-02')-dst.start('2026-11-01'),25*3600000);
});

test('analytics validation bounds dates and time zones and reports empty accuracy as null',t=>{
  const {store,stats}=fixture(t);assert.equal(stats().summary.accuracy,null);assert.equal(stats().daily.length,7);assert.ok(stats().recommendations.some(value=>value.id==='start'));
  assert.throws(()=>analyticsQuerySchema.parse({from:'2026-02-30'}));assert.throws(()=>analyticsQuerySchema.parse({timeZone:'Invalid/Zone'}));assert.throws(()=>weeklyQuerySchema.parse({extra:true}));
  assert.throws(()=>learningAnalytics(store,{from:'2025-01-01',to:'2026-10-25'},now));assert.throws(()=>learningAnalytics(store,{from:'2026-10-22',to:'2026-10-21'},now));assert.throws(()=>learningAnalytics(store,{from:'2026-10-25',to:'2026-10-26'},now));assert.throws(()=>weeklyReport(store,{week:'2026-11-02'},now));
});

test('current-week comparison matches real elapsed seconds across a daylight-saving transition',t=>{
  const {store,paper}=fixture(t);
  const changedNow=new Date('2026-03-08T16:00:00.000Z'); // Sunday noon after the New York spring shift.
  submitted(store,paper,{tf:{value:['true']}},'2026-03-08T15:00:00.000Z',10);
  submitted(store,paper,{tf:{value:['true']}},'2026-03-01T15:59:59.000Z',10);
  submitted(store,paper,{tf:{value:['true']}},'2026-03-01T16:30:00.000Z',10);
  const result=weeklyReport(store,{week:'2026-03-08',timeZone:'America/New_York'},changedNow);
  assert.equal(result.comparison.mode,'matched_elapsed');assert.equal(result.current.summary.answers,1);
  assert.equal(result.comparison.summary.answers,1,'previous Sunday stops at 11:00 local, the same real elapsed duration, not 12:00 local');
});

test('analytics and weekly reads never materialize question bodies, notes, answers or dirty caches and never write',t=>{
  const {store,paper,full,stats}=fixture(t);submitted(store,paper,full,'2026-10-21T02:00:00.000Z',65);
  const read=store.database.all.bind(store.database);let calls=0;
  store.database.all=((query:any)=>{calls++;const rows=read(query);assert.doesNotMatch(JSON.stringify(rows),/QUESTION_PRIVATE_CANARY|REFERENCE_PRIVATE_CANARY|MATERIAL_PRIVATE_CANARY|STUDENT_PRIVATE_CANARY/);return rows;}) as typeof store.database.all;
  const get=store.get.bind(store);store.get=((table:any,id:string)=>{assert.ok(!['questions','attempts','papers','study','study_parts','learning_results','question_history'].includes(table));return get(table,id);}) as typeof store.get;
  store.all=()=>{throw new Error('must not read a full table');};store.database.run=()=>{throw new Error('GET must never write');};
  assert.equal(stats().summary.answers,4);assert.ok(calls<12);calls=0;assert.equal(weeklyReport(store,{week:'2026-10-25'},now).current.summary.answers,4);assert.ok(calls<20);
});
