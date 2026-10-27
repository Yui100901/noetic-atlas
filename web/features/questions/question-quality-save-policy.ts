import {isRetiredQualityRule,type QualityIssueStatus,type QualityRule} from '../../../shared/models/content-quality';

export interface QualitySaveState {id:string;status:QualityIssueStatus;rule:QualityRule}
const active=new Set<QualityIssueStatus>(['open','confirmed','stale']);

/** Only a deliberate status transition counts as triage. A scan turning old
 * evidence stale, or an AI review touching its version, is not a decision. */
export function unchangedActiveQualityIssues(before:readonly QualitySaveState[],current:readonly QualitySaveState[]):QualitySaveState[]{
  const statuses=new Map(before.map(issue=>[issue.id,issue.status]));
  return current.filter(issue=>!isRetiredQualityRule(issue.rule)&&active.has(issue.status)&&
    (!statuses.has(issue.id)||statuses.get(issue.id)===issue.status||issue.status==='stale'));
}
