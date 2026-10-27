import type {z} from 'zod';
import type {Store} from '../../core/store.js';
import {RETIRED_QUALITY_RULES,type QualityIssueStatus,type QualityQuestionGroup,type QualitySeverity} from '../../../shared/models/content-quality.js';
import {qualityIssueQuerySchema} from './schema.js';
import {qualityIssueSelection} from './service.js';

const active=new Set<QualityIssueStatus>(['open','confirmed','stale']);
const rank:Record<QualitySeverity,number>={notice:0,warning:1,error:2};
const emptyCounts=():Record<QualityIssueStatus,number>=>({open:0,confirmed:0,resolved:0,dismissed:0,stale:0});

/** Filter individual findings, but paginate distinct root questions in the
 * database. Page summaries then include every visible finding for those roots,
 * so choosing one source never conceals the other source's issue count. */
export function qualityQuestionPage(store:Store,query:z.infer<typeof qualityIssueQuerySchema>){
  const d=store.database,x=d.expressions,questionId=x.field<string>('data','questionId');
  // The old issue endpoint permits explicit historical feedback deep links.
  // The question queue always represents current (non-retired) checks.
  const matched=qualityIssueSelection(store,query).where(x.field('data','rule'),'not in',[...RETIRED_QUALITY_RULES]).select([
    questionId.as('questionId'),
    eb=>eb.fn.countAll<number>().as('matchedIssueCount'),
    eb=>eb.fn.max<string>(x.field<string>('data','updatedAt')).as('matchedUpdatedAt'),
  ]).groupBy(questionId);
  const total=Number(d.one(d.query.selectFrom(matched.as('matches')).select(eb=>eb.fn.countAll<number>().as('count')))?.count||0);
  const page=d.all(matched.orderBy('matchedUpdatedAt','desc').orderBy('questionId').limit(query.pageSize).offset((query.page-1)*query.pageSize));
  if(!page.length)return{items:[] as QualityQuestionGroup[],total,page:query.page,pageSize:query.pageSize};
  const ids=page.map(row=>row.questionId);
  const status=x.field<QualityIssueStatus>('data','status'),severity=x.field<QualitySeverity>('data','severity');
  const grouped=d.all(d.query.selectFrom('quality_issues')
    .where(questionId,'in',ids).where(x.field('data','rule'),'not in',[...RETIRED_QUALITY_RULES])
    .select([
      questionId.as('questionId'),status.as('status'),severity.as('severity'),
      eb=>eb.case().when(eb.or([eb(x.field('data','origin'),'=','feedback'),eb(x.field('data','rule'),'=','user_feedback')])).then('feedback' as const).else('scan' as const).end().as('origin'),
      eb=>eb.fn.countAll<number>().as('count'),
      eb=>eb.fn.max<string>(x.field<string>('data','updatedAt')).as('updatedAt'),
      eb=>eb.fn.max<string>(x.field<string>('data','questionTitle')).as('questionTitle'),
    ]).groupBy([questionId,status,severity,x.field('data','origin'),x.field('data','rule')]));
  // Only selected title metadata is read, never the full question or answers.
  const titles=new Map(d.all(d.query.selectFrom('questions').select(['id',x.field<string>('data','title').as('title')]).where('id','in',ids)).map(row=>[row.id,row.title]));
  const summaries=new Map<string,QualityQuestionGroup>();
  const highestActive=new Map<string,QualitySeverity>();
  for(const row of grouped){
    let summary=summaries.get(row.questionId);
    if(!summary){summary={questionId:row.questionId,questionTitle:titles.get(row.questionId)||row.questionTitle||row.questionId,sourceAvailable:titles.has(row.questionId),issueCount:0,matchedIssueCount:0,activeIssueCount:0,counts:emptyCounts(),origins:[],severity:'notice',updatedAt:row.updatedAt||''};summaries.set(row.questionId,summary);}
    const count=Number(row.count);summary.issueCount+=count;summary.counts[row.status]+=count;
    if(active.has(row.status)){summary.activeIssueCount+=count;const prior=highestActive.get(row.questionId);if(!prior||rank[row.severity]>rank[prior])highestActive.set(row.questionId,row.severity);}
    if(!summary.origins.includes(row.origin))summary.origins.push(row.origin);
    if(rank[row.severity]>rank[summary.severity])summary.severity=row.severity;
    if(row.updatedAt&&row.updatedAt>summary.updatedAt)summary.updatedAt=row.updatedAt;
  }
  const items=page.map(row=>{
    const value=summaries.get(row.questionId)!;
    value.matchedIssueCount=Number(row.matchedIssueCount);
    // Show the highest unresolved severity; closed history cannot overshadow
    // a current minor finding, but remains represented in the full counts.
    value.severity=highestActive.get(row.questionId)||value.severity;
    value.origins.sort();return value;
  });
  return{items,total,page:query.page,pageSize:query.pageSize};
}
