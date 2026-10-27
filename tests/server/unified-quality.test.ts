import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {Store,now,nextStamp} from '../../server/core/store.js';
import {ApiError,questionSchema} from '../../server/core/validation.js';
import type {Question} from '../../shared/models/types.js';
import type {QualityIssue} from '../../shared/models/content-quality.js';
import type {QuestionFeedback} from '../../shared/models/question-feedback.js';
import {createQuestionFeedback,resolveQuestionFeedback,enrichQuestionsWithFeedback} from '../../server/modules/quality-feedback/service.js';
import {createQualityScan,processQualityScan,qualityIssueDetail,resolveQualityIssue} from '../../server/modules/content-quality/service.js';
import {prepareQualityReviewContext} from '../../server/modules/content-quality/review-context.js';
import {migrateFeedbackQualityIssues,syncQualityIssueFromFeedback} from '../../server/modules/content-quality/feedback-links.js';
import {exportData,importData} from '../../server/modules/transfer/migration.js';
import {registerContentQualityRoutes} from '../../server/modules/content-quality/routes.js';

function fixture(t:test.TestContext){
 const store=new Store(':memory:');t.after(()=>store.db.close());
 for(const id of ['Q1','Q2'])store.put('questions',id,questionSchema.parse({id,title:'基础概念'+id,type:'short_answer',stemMarkdown:'说明一个独立概念'+id,answerMarkdown:'独立概念的含义。',explanationMarkdown:'',sourceRefs:[{label:'待补充的占位来源',url:'https://example.org/placeholder'}],status:'published',createdAt:now(),updatedAt:now()}));
 const report=(description='内容可能存在错误',questionId='Q1')=>createQuestionFeedback(store,{questionId,kind:'answer',description});
 const scan=()=>{let run=createQualityScan(store,{});while(run.status==='ready')run=processQualityScan(store,run.id,100);return run;};
 return{store,report,scan};
}

test('multiple reports create independent quality cases and synchronized resolutions do not close siblings',t=>{
 const {store,report}=fixture(t),questionBefore=store.get('questions','Q1'),a=report('第一条反馈'),b=report('第二条反馈');
 assert.notEqual(a.qualityIssueId,b.qualityIssueId);assert.equal(store.all('quality_issues').length,2);
 const issue=qualityIssueDetail(store,a.qualityIssueId!).issue;
 resolveQualityIssue(store,issue.id,{status:'resolved',note:'核对后已修订',expectedUpdatedAt:issue.updatedAt});
 assert.equal(store.require<QuestionFeedback>('question_feedback',a.id).status,'resolved');
 assert.equal(store.require<QuestionFeedback>('question_feedback',b.id).status,'pending');
 assert.equal(enrichQuestionsWithFeedback(store,[{id:'Q1'}])[0]!.feedbackSummary.openCount,1);
 const current=store.require<QuestionFeedback>('question_feedback',b.id);
 resolveQuestionFeedback(store,current,{status:'dismissed',note:'核对后忽略',expectedUpdatedAt:current.updatedAt});
 assert.equal(qualityIssueDetail(store,b.qualityIssueId!).issue.status,'dismissed');
 assert.equal(enrichQuestionsWithFeedback(store,[{id:'Q1'}])[0]!.feedbackSummary.openCount,0);
 assert.deepEqual(store.get('questions','Q1'),questionBefore);
});

test('scan AI context is idempotent, survives rescan, and does not create user suspicion',t=>{
 const {store,scan}=fixture(t);scan();const issue=store.all<QualityIssue>('quality_issues').find(i=>i.questionId==='Q1')!,count=store.all('quality_issues').length;
 const prepared=prepareQualityReviewContext(store,issue.id,issue.updatedAt);
 const again=prepareQualityReviewContext(store,issue.id,prepared.issue.updatedAt);
 assert.equal(again.feedback.id,prepared.feedback.id);assert.equal(store.all('quality_issues').length,count);
 assert.equal(prepared.feedback.origin,'quality');assert.equal(enrichQuestionsWithFeedback(store,[{id:'Q1'}])[0]!.feedbackSummary.openCount,0);
 const confirmed=resolveQualityIssue(store,issue.id,{status:'confirmed',note:'已核对，等待修正占位来源',expectedUpdatedAt:prepared.issue.updatedAt});
 scan();const detail=qualityIssueDetail(store,issue.id);
 assert.deepEqual(detail.issue.feedbackIds,[prepared.feedback.id]);assert.equal(detail.feedbacks.length,1);
 assert.equal(detail.feedbacks[0]!.status,'confirmed');assert.equal(detail.feedbacks[0]!.note,confirmed.note);
 const context=prepareQualityReviewContext(store,issue.id,detail.issue.updatedAt);assert.equal(context.feedback.id,prepared.feedback.id);
 assert.equal(store.all('quality_issues').length,count);assert.equal(store.all('question_feedback').length,1);
});

test('scan staling synchronizes linked context, and startup reconciliation is a true no-op',t=>{
 const {store,scan}=fixture(t);scan();const issue=store.all<QualityIssue>('quality_issues').find(i=>i.questionId==='Q1')!;
 const prepared=prepareQualityReviewContext(store,issue.id,issue.updatedAt);
 resolveQualityIssue(store,issue.id,{status:'confirmed',note:'等待修正占位来源',expectedUpdatedAt:prepared.issue.updatedAt});
 const q=store.require<Question>('questions','Q1');store.put('questions',q.id,{...q,explanationMarkdown:'答案本身可带解释。',sourceRefs:[],updatedAt:nextStamp(q.updatedAt)});scan();
 assert.equal(qualityIssueDetail(store,issue.id).issue.status,'stale');assert.equal(store.require<QuestionFeedback>('question_feedback',prepared.feedback.id).status,'pending');
 const stale=store.require<QualityIssue>('quality_issues',issue.id),feedback=store.require<QuestionFeedback>('question_feedback',prepared.feedback.id);
 store.put('question_feedback',feedback.id,{...feedback,updatedAt:new Date(Date.parse(stale.updatedAt)+5).toISOString()});
 const before=[store.all('quality_issues'),store.all('question_feedback')];assert.equal(migrateFeedbackQualityIssues(store),0);assert.equal(migrateFeedbackQualityIssues(store),0);assert.deepEqual([store.all('quality_issues'),store.all('question_feedback')],before);
 // AI outcome/failure metadata also cannot turn mirrored pending into reopen.
 syncQualityIssueFromFeedback(store,store.require<QuestionFeedback>('question_feedback',feedback.id));assert.equal(qualityIssueDetail(store,issue.id).issue.status,'stale');
});

test('repairing a missing reverse link preserves the newest human status and notes',t=>{
 const {store,report}=fixture(t),reportA=report();
 const issue=store.require<QualityIssue>('quality_issues',reportA.qualityIssueId!);
 const {feedbackIds:_ids,...withoutLink}=issue;store.put('quality_issues',issue.id,{...withoutLink,updatedAt:'2026-01-01T00:00:00.000Z'});
 store.put('question_feedback',reportA.id,{...reportA,status:'resolved',note:'较新的人工解决结论',updatedAt:'2026-10-27T01:00:00.000Z'});
 assert.ok(migrateFeedbackQualityIssues(store)>0);
 const fixed=qualityIssueDetail(store,issue.id);assert.equal(fixed.issue.status,'resolved');assert.equal(fixed.issue.note,'较新的人工解决结论');assert.deepEqual(fixed.issue.feedbackIds,[reportA.id]);assert.equal(fixed.feedbacks[0]!.note,'较新的人工解决结论');
 assert.equal(migrateFeedbackQualityIssues(store),0);
});

test('trusted JSON migration keeps linked evidence and human decisions without duplicating cases',t=>{
 const {store,report,scan}=fixture(t),feedback=report();scan();
 const scanIssue=store.all<QualityIssue>('quality_issues').find(i=>i.origin==='scan'&&i.questionId==='Q2')!;
 const context=prepareQualityReviewContext(store,scanIssue.id,scanIssue.updatedAt);
 resolveQualityIssue(store,context.issue.id,{status:'dismissed',note:'保留隔离占位来源验收题',expectedUpdatedAt:context.issue.updatedAt});
 const reportIssue=qualityIssueDetail(store,feedback.qualityIssueId!).issue;
 resolveQualityIssue(store,reportIssue.id,{status:'resolved',note:'人工核实反馈并修正',expectedUpdatedAt:reportIssue.updatedAt});
 const snapshot=exportData(store),target=new Store(':memory:');t.after(()=>target.db.close());importData(target,snapshot);
 assert.deepEqual(target.all('quality_issues'),store.all('quality_issues'));assert.deepEqual(target.all('question_feedback'),store.all('question_feedback'));
 importData(target,snapshot);assert.deepEqual(target.all('quality_issues'),store.all('quality_issues'));assert.deepEqual(target.all('question_feedback'),store.all('question_feedback'));
 assert.equal(enrichQuestionsWithFeedback(target,[{id:'Q1'},{id:'Q2'}]).reduce((n,q)=>n+q.feedbackSummary.openCount,0),0);
});

test('forged cross-question references and duplicate case ownership fail trusted import atomically',t=>{
 const {store,report}=fixture(t),feedback=report();const snapshot=exportData(store) as any;
 for(const mutate of [
  (copy:any)=>{copy.qualityIssues[0].questionId='Q2';},
  (copy:any)=>{copy.qualityIssues.push({...copy.qualityIssues[0],id:'second-owner'});},
  (copy:any)=>{copy.questionFeedback[0].qualityIssueId='missing-case';},
 ]){
  const target=new Store(':memory:');t.after(()=>target.db.close());const copy=structuredClone(snapshot);mutate(copy);
  assert.throws(()=>importData(target,copy),/质量问题|反馈/);assert.equal(target.all('questions').length,0);assert.equal(target.all('question_feedback').length,0);assert.equal(target.all('quality_issues').length,0);
 }
 assert.equal(store.require<QuestionFeedback>('question_feedback',feedback.id).status,'pending');
});

test('a stale question cannot acquire a fresh AI context or close feedback until the current question is scanned',t=>{
 const {store,report,scan}=fixture(t),feedback=report();let issue=qualityIssueDetail(store,feedback.qualityIssueId!).issue;
 const q=store.require<Question>('questions','Q1');store.put('questions',q.id,{...q,answerMarkdown:'修订后的参考答案',updatedAt:nextStamp(q.updatedAt)});
 assert.throws(()=>prepareQualityReviewContext(store,issue.id,issue.updatedAt),/原题|变化/);
 assert.throws(()=>resolveQualityIssue(store,issue.id,{status:'resolved',note:'尚未重查',expectedUpdatedAt:issue.updatedAt}),/重新扫描/);
 scan();issue=qualityIssueDetail(store,issue.id).issue;
 assert.equal(resolveQualityIssue(store,issue.id,{status:'resolved',note:'已经核对保存后的新内容',expectedUpdatedAt:issue.updatedAt}).status,'resolved');
 assert.equal(store.require<QuestionFeedback>('question_feedback',feedback.id).status,'resolved');
});

test('batch context preparation is atomic and stale issue forms cannot overwrite newer decisions',async t=>{
 const {store,scan}=fixture(t);scan();const issues=store.all<QualityIssue>('quality_issues');
 const app=Fastify();t.after(()=>app.close());app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof ApiError?error.status:500).send({error:{message:error.message}}));registerContentQualityRoutes(app,store);
 const response=await app.inject({method:'POST',url:'/api/content-quality/review-contexts',payload:{ids:issues.map(i=>i.id),expectedUpdatedAt:{[issues[0]!.id]:issues[0]!.updatedAt,[issues[1]!.id]:'2000-01-01T00:00:00.000Z'}}});
 assert.equal(response.statusCode,409);assert.equal(store.all('question_feedback').length,0);assert.deepEqual(store.all('quality_issues'),issues);
 const linked=prepareQualityReviewContext(store,issues[0]!.id,issues[0]!.updatedAt);
 assert.throws(()=>resolveQualityIssue(store,issues[0]!.id,{status:'resolved',note:'旧表单',expectedUpdatedAt:issues[0]!.updatedAt}),/更新|变化/);
 assert.equal(qualityIssueDetail(store,issues[0]!.id).issue.status,'open');assert.equal(store.all('question_feedback').length,1);
 assert.equal(prepareQualityReviewContext(store,linked.issue.id,linked.issue.updatedAt).feedback.id,linked.feedback.id);
});

test('reconciliation selects the newest original decision across multiple contexts before repairing reverse links',t=>{
 const {store,scan}=fixture(t);scan();const issue=store.all<QualityIssue>('quality_issues')[0]!,prepared=prepareQualityReviewContext(store,issue.id,issue.updatedAt);
 const caseBefore=store.require<QualityIssue>('quality_issues',issue.id);store.put('quality_issues',caseBefore.id,{...caseBefore,updatedAt:'2026-01-01T00:00:00.000Z'});
 store.put('question_feedback',prepared.feedback.id,{...prepared.feedback,status:'confirmed',note:'旧核查结论',updatedAt:'2026-02-01T00:00:00.000Z'});
 store.put('question_feedback','newest-context',{...prepared.feedback,id:'newest-context',status:'resolved',note:'最新核查结论',updatedAt:'2026-03-01T00:00:00.000Z'});
 migrateFeedbackQualityIssues(store);const detail=qualityIssueDetail(store,issue.id);
 assert.equal(detail.issue.status,'resolved');assert.equal(detail.issue.note,'最新核查结论');assert.equal(detail.feedbacks.length,2);assert.ok(detail.feedbacks.every(f=>f.status==='resolved'&&f.note==='最新核查结论'));
 assert.equal(migrateFeedbackQualityIssues(store),0);
});
