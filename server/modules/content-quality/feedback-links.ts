import {createHash} from 'node:crypto';
import type {Store} from '../../core/store.js';
import {fail} from '../../core/validation.js';
import type {Question} from '../../../shared/models/types.js';
import type {QuestionFeedback,QuestionFeedbackStatus,QuestionFeedbackView} from '../../../shared/models/question-feedback.js';
import {QUALITY_RULE_VERSION,type QualityIssue,type QualityIssueStatus} from '../../../shared/models/content-quality.js';
import {qualityContentFingerprint} from './rules.js';
import {feedbackFingerprint} from '../quality-feedback/fingerprint.js';

const stamp=(previous?:string)=>new Date(Math.max(Date.now(),previous?Date.parse(previous)+1:0)).toISOString();
export const feedbackIssueId=(id:string)=>'quality-feedback-'+createHash('sha256').update(id).digest('hex');
export const qualityStatusForFeedback=(status:QuestionFeedbackStatus):QualityIssueStatus=>status==='pending'?'open':status;
export const feedbackStatusForQuality=(status:QualityIssueStatus):QuestionFeedbackStatus=>status==='open'||status==='stale'?'pending':status;
// Feedback has no separate stale state. A newer mirrored pending record (or
// AI failure) must not be mistaken for an explicit decision to reopen a case.
const reconciledStatus=(quality:QualityIssueStatus,feedback:QuestionFeedbackStatus):QualityIssueStatus=>feedbackStatusForQuality(quality)===feedback?quality:qualityStatusForFeedback(feedback);
export function currentFeedbackView(store:Store,feedback:QuestionFeedback):QuestionFeedbackView{
 const question=store.get<Question>('questions',feedback.questionId),part=feedback.partId?question?.parts?.find(p=>p.id===feedback.partId):undefined;
 const source=question&&(!feedback.partId||part)?{question,...(part?{part}:{})}:undefined;
 return{...feedback,sourceAvailable:!!source,sourceChanged:!source||feedbackFingerprint(source)!==feedback.contentFingerprint};
}
function assertSameSource(issue:QualityIssue,feedback:QuestionFeedback){
 if(issue.questionId!==feedback.questionId||(issue.partId||null)!==(feedback.partId||null))fail(400,'QUALITY_FEEDBACK_REFERENCE_CONFLICT','质量问题与关联反馈不属于同一题目或小题');
 if(feedback.qualityIssueId&&feedback.qualityIssueId!==issue.id)fail(409,'QUALITY_FEEDBACK_REFERENCE_CONFLICT','反馈已经关联到另一条质量问题，不能重新指向');
}
function linkedIssue(store:Store,feedback:QuestionFeedback):QualityIssue|undefined{
 if(feedback.qualityIssueId){const value=store.database.getRecord<QualityIssue>('quality_issues',feedback.qualityIssueId)||fail(400,'QUALITY_FEEDBACK_REFERENCE_MISSING','反馈关联的质量问题不存在');assertSameSource(value,feedback);return value;}
 const d=store.database,x=d.expressions,rows=d.all(d.query.selectFrom('quality_issues').select('data').where(x.arrayAny('data','feedbackIds',[feedback.id])).limit(2));
 if(rows.length>1)fail(409,'QUALITY_FEEDBACK_REFERENCE_CONFLICT','同一反馈不能同时属于多条质量问题');
 if(rows[0]){const value=JSON.parse(rows[0].data) as QualityIssue;assertSameSource(value,feedback);return value;}
 return undefined;
}
export function ensureFeedbackQualityIssue(store:Store,feedback:QuestionFeedback):{issue:QualityIssue;feedback:QuestionFeedback;changed:boolean}{
 let issue=linkedIssue(store,feedback),changed=false;
 if(!issue){
  if(feedback.origin==='quality')fail(400,'QUALITY_FEEDBACK_REFERENCE_MISSING','系统复核上下文缺少原质量问题');
  const question=store.get<Question>('questions',feedback.questionId),d=store.database,x=d.expressions;
  const domains=question?.categoryIds.length?d.all(d.query.selectFrom('categories').select(x.field<string>('data','domainId').as('domainId')).where(x.idInJson('id',question.categoryIds))).map(r=>r.domainId):[];
  const id=feedbackIssueId(feedback.id);if(d.getRecord('quality_issues',id))fail(409,'QUALITY_FEEDBACK_REFERENCE_CONFLICT','用户反馈的质量问题标识已被占用');
  issue={id,origin:'feedback',feedbackIds:[feedback.id],questionId:feedback.questionId,...(feedback.partId?{partId:feedback.partId}:{}),questionTitle:feedback.questionTitle,domainIds:[...new Set(domains)],contentFingerprint:question?qualityContentFingerprint(question):feedback.contentFingerprint,ruleVersion:QUALITY_RULE_VERSION,rule:'user_feedback',severity:'warning',status:qualityStatusForFeedback(feedback.status),message:'用户反馈：'+feedback.description.slice(0,1850),evidence:feedback.description.slice(0,4000),suggestion:'结合原题、参考答案与反馈说明核查；可使用站内对比和AI复核，填写依据后确认、解决或忽略。',relatedQuestions:[],createdAt:feedback.createdAt,updatedAt:feedback.updatedAt,lastDetectedAt:feedback.createdAt,note:feedback.note};
  d.putRecord('quality_issues',id,issue);changed=true;
 }else if(!issue.feedbackIds?.includes(feedback.id)){issue={...issue,feedbackIds:[...(issue.feedbackIds||[]),feedback.id],updatedAt:stamp(issue.updatedAt)};store.database.putRecord('quality_issues',issue.id,issue);changed=true;}
 const linked={...feedback,origin:feedback.origin||'user' as const,qualityIssueId:issue.id};
 if(JSON.stringify(linked)!==JSON.stringify(feedback)){store.database.putRecord('question_feedback',feedback.id,linked);changed=true;}
 return{issue,feedback:linked,changed};
}
/** A feedback AI result lives only in question_feedback. Touching its case's
 * version prevents stale human forms from replacing a newer review outcome. */
export function syncQualityIssueFromFeedback(store:Store,feedback:QuestionFeedback):QualityIssue{
 const linked=ensureFeedbackQualityIssue(store,feedback),issue={...linked.issue,status:reconciledStatus(linked.issue.status,feedback.status),note:feedback.note,updatedAt:stamp(linked.issue.updatedAt)};
 store.database.putRecord('quality_issues',issue.id,issue);syncFeedbacksFromQualityIssue(store,issue);return issue;
}
export function syncFeedbacksFromQualityIssue(store:Store,issue:QualityIssue){
 for(const id of issue.feedbackIds||[]){const feedback=store.database.getRecord<QuestionFeedback>('question_feedback',id)||fail(400,'QUALITY_FEEDBACK_REFERENCE_MISSING','质量问题关联的反馈不存在');assertSameSource(issue,feedback);
  const status=feedbackStatusForQuality(issue.status);if(feedback.status!==status||feedback.note!==issue.note||feedback.qualityIssueId!==issue.id)store.database.putRecord('question_feedback',id,{...feedback,qualityIssueId:issue.id,status,note:issue.note,updatedAt:stamp(feedback.updatedAt)});
 }
}
/** Explicit upgrade only. Never called by a GET/list request. */
export function migrateFeedbackQualityIssues(store:Store):number{
 return store.transaction(()=>{
  let changed=0;const d=store.database,associations=new Map<string,string>();
  for(const issue of d.records<QualityIssue>('quality_issues'))for(const id of issue.feedbackIds||[]){
   if(associations.has(id)&&associations.get(id)!==issue.id)fail(409,'QUALITY_FEEDBACK_REFERENCE_CONFLICT','同一反馈不能归属多条质量问题');associations.set(id,issue.id);
   const feedback=d.getRecord<QuestionFeedback>('question_feedback',id)||fail(400,'QUALITY_FEEDBACK_REFERENCE_MISSING','质量问题关联的反馈不存在');assertSameSource(issue,feedback);
  }
  // Select the authoritative human state using the original versions. Adding
  // missing links touches case versions, but must not make an older state win.
  const originalCases=new Map(d.records<QualityIssue>('quality_issues').map(issue=>[issue.id,issue]));
  const states=new Map<string,{updatedAt:string;status:QualityIssueStatus;note:string}>();
  for(const feedback of d.records<QuestionFeedback>('question_feedback')){
   const linked=ensureFeedbackQualityIssue(store,feedback);if(linked.changed)changed++;
   const previous=states.get(linked.issue.id)||originalCases.get(linked.issue.id)||linked.issue;
   states.set(linked.issue.id,feedback.updatedAt>previous.updatedAt?{updatedAt:feedback.updatedAt,status:reconciledStatus(previous.status,feedback.status),note:feedback.note}:{updatedAt:previous.updatedAt,status:previous.status,note:previous.note});
  }
  for(const [id,state]of states){
   const issue=d.getRecord<QualityIssue>('quality_issues',id)!;
   if(issue.status!==state.status||issue.note!==state.note){const next={...issue,status:state.status,note:state.note,updatedAt:stamp(issue.updatedAt)};d.putRecord('quality_issues',id,next);changed++;}
   const current=d.getRecord<QualityIssue>('quality_issues',id)!;
   const needsSync=(current.feedbackIds||[]).some(id=>{const feedback=d.getRecord<QuestionFeedback>('question_feedback',id)!;return feedback.status!==feedbackStatusForQuality(current.status)||feedback.note!==current.note||feedback.qualityIssueId!==current.id;});
   if(needsSync){syncFeedbacksFromQualityIssue(store,current);changed++;}
  }
  return changed;
 });
}
