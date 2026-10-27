import type {Store} from '../../core/store.js';
import {makeId,now,nextStamp} from '../../core/store.js';
import {fail} from '../../core/validation.js';
import type {QuestionFeedback} from '../../../shared/models/question-feedback.js';
import {currentFeedbackView,feedbackStatusForQuality} from './feedback-links.js';
import {requireQualityIssue,qualityIssueDetail,qualityIssueView} from './service.js';
import {feedbackFingerprint} from '../quality-feedback/fingerprint.js';
import {isRetiredQualityRule,qualityIssueOrigin} from '../../../shared/models/content-quality.js';

/** AI's storage/context is linked to the existing case; this is not a second
 * user report and never creates another quality queue item. */
export function prepareQualityReviewContext(store:Store,id:string,expectedUpdatedAt:string){
 return store.transaction(()=>{
  const issue=requireQualityIssue(store,id);if(issue.updatedAt!==expectedUpdatedAt)fail(409,'QUALITY_ISSUE_VERSION_CONFLICT','问题状态已变化，请刷新后复核');
  if(isRetiredQualityRule(issue.rule))fail(409,'QUALITY_RULE_RETIRED','该自动检查已停用，仅保留历史证据；如仍有具体内容问题，请提交新的反馈。');
  if(!['open','confirmed'].includes(issue.status))fail(409,'QUALITY_ISSUE_NOT_OPEN','只有待核查或已确认问题可进行AI复核');
  const detail=qualityIssueDetail(store,id);if(!detail.question||detail.issue.sourceChanged||detail.issue.relatedChanged)fail(409,'QUALITY_SOURCE_CHANGED','原题或对比候选已变化，请先重新检查当前内容');
  const existing=detail.feedbacks.find(feedback=>qualityIssueOrigin(issue)==='feedback'||feedback.origin==='quality');
  if(existing)return{issue:detail.issue,feedback:existing};
  const question=detail.question||fail(409,'QUALITY_SOURCE_CHANGED','原题已移除'),part=issue.partId?question.parts?.find(p=>p.id===issue.partId):undefined;
  if(issue.partId&&!part)fail(409,'QUALITY_SOURCE_CHANGED','原小题已移除，请重新检查');
  const timestamp=now(),feedback:QuestionFeedback={id:makeId('qualitycontext'),origin:'quality',qualityIssueId:issue.id,questionId:issue.questionId,...(issue.partId?{partId:issue.partId}:{}),questionTitle:(part||question).title,
   kind:issue.rule==='exact_duplicate'||issue.rule==='conflicting_answers'?'duplicate':issue.rule==='answer_explanation_conflict'?'answer':'other',description:`系统质量复核上下文（非用户反馈）\n${issue.message}\n证据：${issue.evidence}\n建议：${issue.suggestion}`.slice(0,5000),status:feedbackStatusForQuality(issue.status),baseUpdatedAt:question.updatedAt||question.createdAt||'',contentFingerprint:feedbackFingerprint({question,...(part?{part}:{})}),createdAt:timestamp,updatedAt:timestamp,note:issue.note};
  store.database.putRecord('question_feedback',feedback.id,feedback);
  const next={...issue,feedbackIds:[...(issue.feedbackIds||[]),feedback.id],updatedAt:nextStamp(issue.updatedAt)};store.database.putRecord('quality_issues',next.id,next);
  return{issue:qualityIssueView(store,next),feedback:currentFeedbackView(store,feedback)};
 });
}
