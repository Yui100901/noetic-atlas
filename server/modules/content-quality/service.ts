import type {QuestionFeedback} from '../../../shared/models/question-feedback.js';
import {currentFeedbackView,syncFeedbacksFromQualityIssue} from './feedback-links.js';
import {feedbackFingerprint} from '../quality-feedback/fingerprint.js';
import { createHash } from 'node:crypto';
import type { Question, Category } from '../../../shared/models/types.js';
import { QUALITY_RULE_VERSION, RETIRED_QUALITY_RULES, qualityIssueOrigin, type QualityScan, type QualityFilters, type QualityIssue, type QualityIssueView, type QualityIssueDetail, type QualityFingerprint, type QualityOverview, type QualitySeverity, type QualityRule } from '../../../shared/models/content-quality.js';
import { Store, makeId, now, nextStamp } from '../../core/store.js';
import { ApiError, fail } from '../../core/validation.js';
import { qualityIssueQuerySchema, qualityResolveSchema } from './schema.js';
import { inspectQuestionQuality, qualityContentFingerprint, qualitySignatures, type QualityFinding } from './rules.js';
import type { z } from 'zod';
import { validateAssetReferences } from '../assets/routes.js';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scanning=new WeakMap<Store,Set<string>>();
function selectedQuestions(store:Store,filters:QualityFilters){
  const d=store.database,x=d.expressions;d.projections.ensure(['questions']);
  let query=d.query.selectFrom('question_read_model as q').select('q.id');
  if(filters.questionId)query=query.where('q.id','=',filters.questionId);
  if(filters.status&&filters.status!=='all')query=query.where(x.field('q.data','status'),'=',filters.status);
  if(filters.type)query=query.where(x.field('q.data','type'),'=',filters.type);
  if(filters.domainId){const ids=d.all(d.query.selectFrom('categories').select('id').where(x.field('data','domainId'),'=',filters.domainId)).map(row=>row.id);query=query.where(x.arrayAny('q.data','categoryIds',ids));}
  if(filters.categoryId){const all=store.all<Category>('categories'),ids=new Set([filters.categoryId]);let changed=true;while(changed){changed=false;for(const item of all)if(item.parentId&&ids.has(item.parentId)&&!ids.has(item.id)){ids.add(item.id);changed=true;}}query=query.where(x.arrayAny('q.data','categoryIds',[...ids]));}
  if(filters.tagIds?.length)query=query.where(x.arrayAll('q.data','tagIds',filters.tagIds));
  return query;
}
export function createQualityScan(store:Store,filters:QualityFilters):QualityScan{
  if(filters.questionId)store.require('questions',filters.questionId);if(filters.domainId)store.require('domains',filters.domainId);if(filters.categoryId)store.require('categories',filters.categoryId);for(const id of filters.tagIds||[])store.require('tags',id);
  const selection=selectedQuestions(store,filters),d=store.database;
  const plannedTotal=Number(d.one(selection.clearSelect().select(eb=>eb.fn.countAll<number>().as('count')))?.count||0);
  const upperId=d.one(selection.orderBy('q.id','desc').limit(1))?.id||null,timestamp=now();
  const run:QualityScan={id:makeId('qualityscan'),ruleVersion:QUALITY_RULE_VERSION,status:plannedTotal?'ready':'completed',filters,createdAt:timestamp,updatedAt:timestamp,finishedAt:plannedTotal?null:timestamp,cursor:null,upperId,plannedTotal,processed:0,findings:0,newIssues:0,changedSources:0,severityCounts:{error:0,warning:0,notice:0},ruleCounts:{}};
  d.putRecord('quality_scans',run.id,run);return run;
}
export function requireQualityScan(store:Store,id:string){return store.database.getRecord<QualityScan>('quality_scans',id)||fail(404,'QUALITY_SCAN_NOT_FOUND','质量扫描不存在');}
export function requireQualityIssue(store:Store,id:string){return store.database.getRecord<QualityIssue>('quality_issues',id)||fail(404,'QUALITY_ISSUE_NOT_FOUND','质量问题不存在');}
function sourceMap(store:Store,ids:string[]){const d=store.database;return new Map(ids.length?d.all(d.query.selectFrom('questions').select(['id','data']).where(d.expressions.idInJson('id',[...new Set(ids)]))).map(row=>[row.id,JSON.parse(row.data) as Question]):[]);}
function issueFeedbacks(store:Store,ids:string[]){const d=store.database;return new Map(ids.length?d.all(d.query.selectFrom('question_feedback').select(['id','data']).where(d.expressions.idInJson('id',[...new Set(ids)]))).map(row=>[row.id,JSON.parse(row.data) as QuestionFeedback]):[]);}
export function qualityIssueView(store:Store,issue:QualityIssue,supplied?:Map<string,Question>,suppliedFeedbacks?:Map<string,QuestionFeedback>):QualityIssueView{
  const sources=supplied||sourceMap(store,[issue.questionId,...issue.relatedQuestions.map(q=>q.questionId)]),question=sources.get(issue.questionId);
  const feedbacks=suppliedFeedbacks||issueFeedbacks(store,issue.feedbackIds||[]);
  const feedbackChanged=(issue.feedbackIds||[]).some(id=>{const feedback=feedbacks.get(id);if(!feedback)return true;const part=feedback.partId?question?.parts?.find(p=>p.id===feedback.partId):undefined;return !question||!!feedback.partId&&!part||feedbackFingerprint({question,...(part?{part}:{})})!==feedback.contentFingerprint;});
  return {...issue,origin:qualityIssueOrigin(issue),sourceAvailable:!!question,sourceChanged:!question||qualityContentFingerprint(question)!==issue.contentFingerprint||feedbackChanged,relatedChanged:issue.relatedQuestions.some(q=>{const value=sources.get(q.questionId);return!value||qualityContentFingerprint(value)!==q.contentFingerprint;})};
}
export function qualityIssueDetail(store:Store,id:string):QualityIssueDetail{
  const issue=requireQualityIssue(store,id),sources=sourceMap(store,[issue.questionId,...issue.relatedQuestions.map(q=>q.questionId)]),feedbacks=issueFeedbacks(store,issue.feedbackIds||[]);
  return {issue:qualityIssueView(store,issue,sources,feedbacks),question:sources.get(issue.questionId)||null,relatedQuestions:issue.relatedQuestions.flatMap(q=>sources.has(q.questionId)?[sources.get(q.questionId)!]:[]),feedbacks:(issue.feedbackIds||[]).flatMap(id=>feedbacks.has(id)?[currentFeedbackView(store,feedbacks.get(id)!)]:[])};
}

function persistFinding(store:Store,scan:QualityScan,question:Question,fingerprint:string,domains:string[],finding:QualityFinding,related:QualityIssue['relatedQuestions']=[]){
  const id='quality-'+digest([question.id,finding.partId||null,QUALITY_RULE_VERSION,finding.rule,fingerprint,related.map(q=>[q.questionId,q.contentFingerprint])]);
  const old=store.database.getRecord<QualityIssue>('quality_issues',id),timestamp=now();
  const issue:QualityIssue={id,origin:'scan',questionId:question.id,...(finding.partId?{partId:finding.partId}:{}),questionTitle:(typeof question.title==='string'&&question.title||question.id).slice(0,300),domainIds:domains,contentFingerprint:fingerprint,ruleVersion:QUALITY_RULE_VERSION,rule:finding.rule,severity:finding.severity,status:old?.status==='stale'?'open':old?.status||'open',message:finding.message,evidence:finding.evidence,suggestion:finding.suggestion,relatedQuestions:related,createdAt:old?.createdAt||timestamp,updatedAt:nextStamp(old?.updatedAt),lastDetectedAt:timestamp,scanId:scan.id,note:old?.note||''};
  if(old?.feedbackIds)issue.feedbackIds=[...old.feedbackIds];
  store.database.putRecord('quality_issues',id,issue);syncFeedbacksFromQualityIssue(store,issue);
  scan.findings++;scan.severityCounts[finding.severity]++;scan.ruleCounts[finding.rule]=(scan.ruleCounts[finding.rule]||0)+1;if(!old)scan.newIssues++;
  return id;
}
function duplicateFindings(store:Store,question:Question,index:QualityFingerprint):Array<{finding:QualityFinding;related:QualityIssue['relatedQuestions']}>{
  const d=store.database,x=d.expressions;
  // The comparison uses tiny indexed signatures. Full candidate bodies are
  // loaded only when a user opens an issue, never once per candidate in scan.
  const prior=d.all(d.query.selectFrom('quality_fingerprints as f').innerJoin('questions as q','q.id','f.id')
    .select('f.data').where(x.field('f.data','promptHash'),'=',index.promptHash).where('f.id','<',question.id)
    .where(eb=>eb(x.field('f.data','sourceStamp'),'=',eb.fn.coalesce(x.field('q.data','updatedAt'),x.field('q.data','createdAt'),eb.val('')))).orderBy('f.id').limit(20)).map(row=>JSON.parse(row.data) as QualityFingerprint);
  const exact=prior.filter(row=>row.fullHash===index.fullHash).slice(0,5),conflict=['true_false','single_choice','multiple_choice','fill_blank'].includes(question.type)?prior.filter(row=>row.answerHash!==index.answerHash).slice(0,5):[];
  const related=(rows:QualityFingerprint[])=>rows.map(row=>({questionId:row.id,title:row.title,contentFingerprint:row.contentFingerprint}));
  return [
    ...(exact.length?[{finding:{rule:'exact_duplicate' as const,severity:'notice' as const,message:'发现完整题面、答案与解析相同的候选',evidence:exact.map(q=>`${q.id} · ${q.title}`).join('\n'),suggestion:'比较来源、版本和用途后再决定是否合并；扫描不会删除题目或改动历史引用。'},related:related(exact)}]:[]),
    ...(conflict.length?[{finding:{rule:'conflicting_answers' as const,severity:'warning' as const,message:'相同题面与选项存在不同保存答案',evidence:conflict.map(q=>`${q.id} · ${q.title}`).join('\n'),suggestion:'核对条件、版本、选项映射及参考依据；这只是冲突候选，不证明任一答案必然错误。'},related:related(conflict)}]:[]),
  ];
}
/** One explicit request performs at most 200 source rows in one transaction.
 * GETs never trigger scans, model calls or question/learning mutations. */
export function processQualityScan(store:Store,id:string,batchSize=100):QualityScan{
  if(!Number.isInteger(batchSize)||batchSize<1||batchSize>200)fail(400,'QUALITY_BATCH_LIMIT','每批扫描1–200题');
  const active=scanning.get(store)||new Set<string>();scanning.set(store,active);if(active.has(id))fail(409,'QUALITY_SCAN_BUSY','该扫描正在处理当前批次，请稍后继续');
  active.add(id);
  try{return store.transaction(()=>{
    const scan=requireQualityScan(store,id);if(scan.status==='completed')return scan;if(scan.status==='cancelled')fail(409,'QUALITY_SCAN_CANCELLED','扫描已取消，请新建扫描');
    if(scan.ruleVersion!==QUALITY_RULE_VERSION)fail(409,'QUALITY_RULE_VERSION_CHANGED','规则版本已更新，请新建扫描');
    const d=store.database,x=d.expressions;let query=selectedQuestions(store,scan.filters);
    if(scan.cursor){const missing=d.one(selectedQuestions(store,scan.filters).leftJoin('quality_fingerprints as f','f.id','q.id').where('q.id','<=',scan.cursor).where(eb=>eb.or([eb('f.id','is',null),eb(x.field('f.data','ruleVersion'),'!=',scan.ruleVersion)])).limit(1));if(missing)fail(409,'QUALITY_REBUILD_REQUIRED','扫描游标前的比对签名已缺失（例如完整恢复或迁移后），请新建扫描重建，不能直接续跑旧任务。');}
    if(scan.cursor)query=query.where('q.id','>',scan.cursor);if(scan.upperId)query=query.where('q.id','<=',scan.upperId);
    const selected=d.all(query.orderBy('q.id').limit(batchSize+1));
    const batch=selected.slice(0,batchSize),sources=sourceMap(store,batch.map(q=>q.id));
    const categories=new Map(store.all<Category>('categories').map(c=>[c.id,c.domainId]));
    for(const row of batch){const question=sources.get(row.id);if(!question){scan.cursor=row.id;continue;}
      const fingerprint=qualityContentFingerprint(question),domains=[...new Set((Array.isArray(question.categoryIds)?question.categoryIds:[]).map(id=>categories.get(id)).filter((id):id is string=>!!id))];
      const old=d.all(d.query.selectFrom('quality_issues').select('data').where(x.field('data','questionId'),'=',question.id)).map(row=>JSON.parse(row.data) as QualityIssue);
      const oldFingerprint=d.getRecord<QualityFingerprint>('quality_fingerprints',question.id);if(oldFingerprint&&oldFingerprint.contentFingerprint!==fingerprint)scan.changedSources++;
      const found=new Set<string>();
      const findings=inspectQuestionQuality(question);
      try{validateAssetReferences(store,question);}catch(error){findings.push({rule:'structure',severity:'error',message:'题目引用的图片或文件不可用',evidence:error instanceof Error?error.message:'附件引用校验失败',suggestion:'核对原题中的本地附件引用及图片类型，恢复附件后重新扫描。'});}
      const grouped=new Map<string,QualityFinding>();for(const finding of findings){const key=finding.rule+'\0'+(finding.partId||''),prior=grouped.get(key);if(prior){prior.evidence=(prior.evidence+'\n'+finding.evidence).slice(0,4000);prior.message=(prior.message+'；'+finding.message).slice(0,2000);prior.suggestion=(prior.suggestion+'\n'+finding.suggestion).slice(0,2000);}else grouped.set(key,{...finding});}for(const finding of grouped.values())found.add(persistFinding(store,scan,question,fingerprint,domains,finding));
      const index:QualityFingerprint={id:question.id,contentFingerprint:fingerprint,...qualitySignatures(question),sourceStamp:question.updatedAt||question.createdAt||'',title:(question.title||question.id).slice(0,300),type:question.type,domainIds:domains,indexedAt:now(),ruleVersion:QUALITY_RULE_VERSION};
      for(const {finding,related}of duplicateFindings(store,question,index))found.add(persistFinding(store,scan,question,fingerprint,domains,finding,related));
      for(const issue of old)if(issue.origin!=='feedback'&&issue.rule!=='user_feedback'&&['open','confirmed'].includes(issue.status)&&(!found.has(issue.id)||issue.contentFingerprint!==fingerprint)){const stale={...issue,status:'stale' as const,updatedAt:nextStamp(issue.updatedAt)};d.putRecord('quality_issues',issue.id,stale);syncFeedbacksFromQualityIssue(store,stale);}
      d.putRecord('quality_fingerprints',index.id,index);scan.processed++;scan.cursor=row.id;
    }
    scan.status=selected.length>batchSize?'ready':'completed';scan.updatedAt=nextStamp(scan.updatedAt);scan.finishedAt=scan.status==='completed'?now():null;delete scan.lastFailure;
    if(scan.status==='completed')scan.plannedTotal=scan.processed;
    d.putRecord('quality_scans',scan.id,scan);return scan;
  });}catch(error){
    const current=store.database.getRecord<QualityScan>('quality_scans',id);
    if(current&&['ready','failed'].includes(current.status)){const known=error instanceof ApiError&&['QUALITY_REBUILD_REQUIRED','QUALITY_RULE_VERSION_CHANGED'].includes(error.code);const failed={...current,status:'failed' as const,updatedAt:nextStamp(current.updatedAt),lastFailure:{code:known?error.code:'QUALITY_BATCH_FAILED',message:known?error.message:'本批扫描未完成，未保存本批结果；可重试或新建扫描。'}};store.database.putRecord('quality_scans',id,failed);}
    throw error;
  }finally{active.delete(id);}
}
export function cancelQualityScan(store:Store,id:string){const scan=requireQualityScan(store,id);if(scan.status==='completed'||scan.status==='cancelled')return scan;const next={...scan,status:'cancelled' as const,updatedAt:nextStamp(scan.updatedAt),finishedAt:now()};store.database.putRecord('quality_scans',id,next);return next;}
export function qualityScanPage(store:Store,query:{page:number;pageSize:number}){const d=store.database,x=d.expressions,base=d.query.selectFrom('quality_scans');return{items:d.all(base.select('data').orderBy(x.field('data','createdAt'),'desc').orderBy('id').limit(query.pageSize).offset((query.page-1)*query.pageSize)).map(row=>JSON.parse(row.data) as QualityScan),total:Number(d.one(base.select(eb=>eb.fn.countAll<number>().as('count')))?.count||0),...query};}
export function qualityIssueSelection(store:Store,query:z.infer<typeof qualityIssueQuerySchema>){const d=store.database,x=d.expressions;let base=d.query.selectFrom('quality_issues');if(!query.feedbackId)base=base.where(x.field('data','rule'),'not in',[...RETIRED_QUALITY_RULES]);
  if(query.origin==='feedback')base=base.where(eb=>eb.or([eb(x.field('data','origin'),'=','feedback'),eb(x.field('data','rule'),'=','user_feedback')]));else if(query.origin==='scan')base=base.where(x.field('data','rule'),'!=','user_feedback').where(eb=>eb.or([eb(x.field('data','origin'),'is',null),eb(x.field('data','origin'),'=','scan')]));
  if(query.feedbackId)base=base.where(x.arrayAny('data','feedbackIds',[query.feedbackId]));
  if(query.status==='active')base=base.where(x.field('data','status'),'in',['open','confirmed','stale']);else if(query.status!=='all')base=base.where(x.field('data','status'),'=',query.status);
  for(const key of ['severity','rule','questionId','scanId']as const)if(query[key])base=base.where(x.field('data',key),'=',query[key]);
  if(query.domainId)base=base.where(x.arrayAny('data','domainIds',[query.domainId]));
  if(query.search)base=base.where(eb=>eb.or([x.containsLiteral(x.field('data','questionId'),query.search),x.containsLiteral(x.field('data','questionTitle'),query.search),x.containsLiteral(x.field('data','message'),query.search),x.containsLiteral(x.field('data','evidence'),query.search)]));
  return base;
}
export function qualityIssuePage(store:Store,query:z.infer<typeof qualityIssueQuerySchema>){
  const d=store.database,x=d.expressions,base=qualityIssueSelection(store,query);
  const total=Number(d.one(base.select(eb=>eb.fn.countAll<number>().as('count')))?.count||0),items=d.all(base.select('data').orderBy(x.field('data','updatedAt'),'desc').orderBy('id').limit(query.pageSize).offset((query.page-1)*query.pageSize)).map(row=>JSON.parse(row.data) as QualityIssue);
  const ids=items.flatMap(issue=>[issue.questionId,...issue.relatedQuestions.map(q=>q.questionId)]),sources=sourceMap(store,ids);
  const feedbacks=issueFeedbacks(store,items.flatMap(issue=>issue.feedbackIds||[]));
  return{items:items.map(issue=>qualityIssueView(store,issue,sources,feedbacks)),total,page:query.page,pageSize:query.pageSize};
}
export function resolveQualityIssue(store:Store,id:string,input:z.infer<typeof qualityResolveSchema>){
 return store.transaction(()=>{
  const issue=requireQualityIssue(store,id);if(issue.updatedAt!==input.expectedUpdatedAt)fail(409,'QUALITY_ISSUE_VERSION_CONFLICT','问题状态已更新，请刷新后处理');
  const view=qualityIssueView(store,issue),changed=view.sourceChanged||view.relatedChanged;
  if(changed&&['confirmed','resolved'].includes(input.status)){
    const sources=sourceMap(store,[issue.questionId,...issue.relatedQuestions.map(value=>value.questionId)]);
    const rechecked=input.status==='resolved'&&(issue.status==='stale'||issue.origin==='feedback'||!!issue.feedbackIds?.length)&&[...sources].every(([qid,question])=>{const index=store.database.getRecord<QualityFingerprint>('quality_fingerprints',qid);return index?.ruleVersion===QUALITY_RULE_VERSION&&index.contentFingerprint===qualityContentFingerprint(question);})&&sources.size===new Set([issue.questionId,...issue.relatedQuestions.map(value=>value.questionId)]).size;
    if(!rechecked)fail(409,'QUALITY_SOURCE_CHANGED','题目或对比候选已变化，请重新扫描当前内容后确认');
  }
  const next={...issue,status:input.status,note:input.note,updatedAt:nextStamp(issue.updatedAt)};store.database.putRecord('quality_issues',id,next);syncFeedbacksFromQualityIssue(store,next);return qualityIssueView(store,next);
 });
}
export function qualityOverview(store:Store):QualityOverview{const d=store.database,x=d.expressions;const visible=d.query.selectFrom('quality_issues').where(x.field('data','rule'),'not in',[...RETIRED_QUALITY_RULES]),questionId=x.field<string>('data','questionId');const totalQuestions=Number(d.one(visible.select(eb=>eb.fn.count<number>(questionId).distinct().as('count')))?.count||0),activeQuestions=Number(d.one(visible.where(x.field('data','status'),'in',['open','confirmed','stale']).select(eb=>eb.fn.count<number>(questionId).distinct().as('count')))?.count||0);const counts={open:0,confirmed:0,resolved:0,dismissed:0,stale:0},severity={error:0,warning:0,notice:0};const rows=d.all(d.query.selectFrom('quality_issues').where(x.field('data','rule'),'not in',[...RETIRED_QUALITY_RULES]).select([x.field<keyof typeof counts>('data','status').as('status'),x.field<QualitySeverity>('data','severity').as('severity')]).select(eb=>eb.fn.countAll<number>().as('count')).groupBy([x.field('data','status'),x.field('data','severity')]));for(const row of rows){counts[row.status]+=Number(row.count);if(['open','confirmed','stale'].includes(row.status))severity[row.severity]+=Number(row.count);}return{counts,severity,totalIssues:Object.values(counts).reduce((a,b)=>a+b,0),totalQuestions,activeQuestions,latestScan:qualityScanPage(store,{page:1,pageSize:1}).items[0]||null,ruleVersion:QUALITY_RULE_VERSION,coverage:{deterministic:true,semanticVerification:'not_performed',sourceReachability:'not_checked',message:'规则检查结构、表达和有限精确重复候选；未联网核验全部来源，也未对每题知识正确性作专家或AI鉴定。'}};}
