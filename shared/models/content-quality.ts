import type { QuestionFeedbackView } from './question-feedback.js';
import type { Question } from './types.js';

export const QUALITY_RULE_VERSION = '2026-10-27.2';
// Kept in the rule vocabulary for historical evidence, never emitted anew.
export const RETIRED_QUALITY_RULES = ['missing_source', 'missing_explanation'] as const;
export const isRetiredQualityRule = (rule: string) => (RETIRED_QUALITY_RULES as readonly string[]).includes(rule);
export const QUALITY_RULE_LABELS = {
  structure: '结构与答案引用', empty_stem: '题干为空', missing_explanation: '缺少解析', missing_source: '缺少参考来源',
  duplicate_options: '选项正文重复', template_placeholder: '填空模板占位符', concept_prompt_leak: '反向定义泄露答案',
  reference_placeholder: '来源为占位地址', redundant_stem: '题干含冗余说明', answer_explanation_conflict: '答案结论疑似不一致',
  exact_duplicate: '完整内容重复候选', conflicting_answers: '同题不同答案候选', user_feedback:'用户反馈',
} as const;
export type QualityRule = keyof typeof QUALITY_RULE_LABELS;
export type QualitySeverity = 'error' | 'warning' | 'notice';
export type QualityIssueStatus = 'open' | 'confirmed' | 'resolved' | 'dismissed' | 'stale';
export const QUALITY_STATUS_LABELS: Record<QualityIssueStatus,string> = { open:'待核查', confirmed:'已确认问题', resolved:'已解决', dismissed:'已忽略', stale:'需重新检查' };
export const QUALITY_SEVERITY_LABELS: Record<QualitySeverity,string> = {error:'结构错误',warning:'需重点核查',notice:'编辑提示'};
export interface QualityFilters { questionId?:string; domainId?:string; categoryId?:string; tagIds?:string[]; type?:Question['type']; status?:Question['status']|'all' }
export interface QualityScan {
  id:string; ruleVersion:string; status:'ready'|'completed'|'cancelled'|'failed'; filters:QualityFilters;
  createdAt:string; updatedAt:string; finishedAt:string|null; cursor:string|null; upperId:string|null;
  plannedTotal:number; processed:number; findings:number; newIssues:number; changedSources:number;
  severityCounts:Record<QualitySeverity,number>; ruleCounts:Partial<Record<QualityRule,number>>;
  lastFailure?:{code:string;message:string};
}
export interface QualityIssue {
  id:string; questionId:string; partId?:string; questionTitle:string; domainIds:string[];
  contentFingerprint:string; ruleVersion:string; rule:QualityRule; severity:QualitySeverity; status:QualityIssueStatus;
  message:string; evidence:string; suggestion:string; relatedQuestions:Array<{questionId:string;title:string;contentFingerprint:string}>;
  createdAt:string; updatedAt:string; lastDetectedAt:string; scanId?:string; note:string;
  origin?:'scan'|'feedback'; feedbackIds?:string[];
}
/** Older feedback findings may not have an explicit origin field. */
export const qualityIssueOrigin=(issue:Pick<QualityIssue,'origin'|'rule'>):'scan'|'feedback'=>issue.origin==='feedback'||issue.rule==='user_feedback'?'feedback':'scan';
export interface QualityIssueView extends QualityIssue { sourceAvailable:boolean; sourceChanged:boolean; relatedChanged:boolean }
export interface QualityIssueDetail { issue:QualityIssueView; question:Question|null; relatedQuestions:Question[]; feedbacks:QuestionFeedbackView[] }
/** One queue row per root question. Issue statuses remain independent. */
export interface QualityQuestionGroup {
  questionId:string; questionTitle:string; sourceAvailable:boolean;
  issueCount:number; matchedIssueCount:number; activeIssueCount:number;
  counts:Record<QualityIssueStatus,number>; origins:Array<'scan'|'feedback'>;
  severity:QualitySeverity; updatedAt:string;
}
export interface QualityFingerprint {
  id:string; contentFingerprint:string; promptHash:string; fullHash:string; answerHash:string; sourceStamp:string;
  title:string; type:Question['type']; domainIds:string[]; indexedAt:string; ruleVersion:string;
}
export interface QualityOverview {
  counts:Record<QualityIssueStatus,number>; severity:Record<QualitySeverity,number>; totalIssues:number;
  totalQuestions:number; activeQuestions:number;
  latestScan:QualityScan|null; ruleVersion:string; coverage:{deterministic:true;semanticVerification:'not_performed';sourceReachability:'not_checked';message:string};
}
