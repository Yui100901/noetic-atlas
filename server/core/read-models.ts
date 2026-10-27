import type { Store } from './store.js';
import type { StoredAttempt, StoredPaper } from '../modules/practice/service.js';
import { paperView, attemptView } from '../modules/practice/service.js';
import type { SelectQueryBuilder } from 'kysely';
import { cleanLearningRecord } from '../../shared/questions/learning-records.js';

/** List projections/counts stay in the database; decode only the requested page. */
function pageOf<Row,Result>(store:Store,query:{page?:number;pageSize?:number},builder:SelectQueryBuilder<any,any,Row>,map:(row:Row)=>Result) {
  const db=store.database,paged=query.page!==undefined||query.pageSize!==undefined,page=query.page??1,pageSize=query.pageSize??20;
  const total=paged?Number(db.one(builder.clearSelect().clearOrderBy().select(eb=>eb.fn.countAll<number>().as('total')))?.total||0):0;
  const rows=db.all<Row>(paged?builder.limit(pageSize).offset((page-1)*pageSize):builder);
  const items=rows.map(map);return paged?{items,total,page,pageSize}:items;
}

export function dashboardStats(store:Store) {
  const db=store.database,field=db.expressions.field.bind(db.expressions),q=db.query;
  db.projections.ensure(['questions','papers']);
  const groups=db.all(q.selectFrom('question_read_model').select([field<string>('data','type').as('type'),field<string>('data','collection').as('collection')]).select(eb=>eb.fn.countAll<number>().as('count')).where(field('data','status'),'=','published').groupBy([field('data','type'),field('data','collection')]));
  const stats={totalQuestions:0,generalQuestions:0,personalQuestions:0,totalPapers:0,totalDocuments:0,favoriteCount:0,dueCount:0,wrongCount:0,typeCounts:{} as Record<string,number>,domainQuestionCounts:{} as Record<string,{published:number;pending:number}>};
  for(const row of groups){const n=Number(row.count);stats.totalQuestions+=n;if(row.collection==='general')stats.generalQuestions+=n;if(row.collection==='personal')stats.personalQuestions+=n;stats.typeCounts[row.type]=(stats.typeCounts[row.type]||0)+n;}
  const domainCounts=db.all(q.selectFrom('question_read_model as question')
    .innerJoin(db.expressions.arrayElements('question.data','categoryIds').as('membership'),join=>join.onTrue())
    .innerJoin('categories as category','category.id','membership.value')
    .select([field<string>('category.data','domainId').as('domainId'),field<string>('question.data','status').as('status')])
    .select(eb=>eb.fn.count<number>('question.id').distinct().as('count'))
    .where(field('question.data','status'),'in',['published','pending'])
    .groupBy([field('category.data','domainId'),field('question.data','status')]));
  for(const row of domainCounts){const counts=stats.domainQuestionCounts[row.domainId] ||= {published:0,pending:0};counts[row.status as 'published'|'pending']=Number(row.count);}
  // Read tiny study metadata, never question bodies or Markdown notes.
  const states=db.all(q.selectFrom('study as s').innerJoin('question_read_model as q','q.id','s.id').select([field<string>('q.data','type').as('type'),field<boolean>('s.data','favorite').as('favorite'),field<number>('s.data','wrongCount').as('wrongCount'),field<string|null>('s.data','nextReviewAt').as('nextReviewAt')]).where(field('q.data','status'),'=','published'));
  const stamp=Date.now();for(const state of states){if(state.favorite)stats.favoriteCount++;if(state.type==='group')continue;if(state.wrongCount>0)stats.wrongCount++;if(state.nextReviewAt&&Date.parse(state.nextReviewAt)<=stamp)stats.dueCount++;}
  const partStates=db.all(q.selectFrom('study_parts as s').innerJoin('question_read_model as q',join=>join.onRef('q.id','=',field<string>('s.data','questionId'))).select([field<number>('s.data','wrongCount').as('wrongCount'),field<string|null>('s.data','nextReviewAt').as('nextReviewAt')]).where(field('q.data','status'),'=','published').where(field('q.data','type'),'=','group').where(db.expressions.objectArrayHas('q.data','parts','id',field('s.data','partId'))));
  for(const state of partStates){if(state.wrongCount>0)stats.wrongCount++;if(state.nextReviewAt&&Date.parse(state.nextReviewAt)<=stamp)stats.dueCount++;}
  stats.totalPapers=Number(db.one(q.selectFrom('paper_read_model').select(eb=>eb.fn.countAll<number>().as('count')).where(eb=>eb.or([eb(field('data','archived'),'is',null),eb(field('data','archived'),'=',0)])))?.count||0);
  stats.totalDocuments=Number(db.one(q.selectFrom('documents').select(eb=>eb.fn.countAll<number>().as('count')).where(eb=>eb.or([eb(field('data','_archived'),'is',null),eb(field('data','_archived'),'=',0)])))?.count||0);
  return stats;
}

export function paperList(store:Store,query:{page?:number;pageSize?:number;archived?:string;organization?:string;domainId?:string}) {
  const db=store.database,field=db.expressions.field.bind(db.expressions);
  db.projections.ensure(['papers']);
  // Original insertion order breaks timestamp ties, independent of the order
  // a disposable projection was rebuilt in. The PK join reads no source JSON.
  let rows=db.query.selectFrom('paper_read_model as p').innerJoin('papers as original','original.id','p.id').select('p.data');
  if(query.archived!=='true')rows=rows.where(eb=>eb.or([eb(field('p.data','archived'),'is',null),eb(field('p.data','archived'),'=',0)]));
  if(query.organization)rows=rows.where(eb=>eb.fn.coalesce(field<string>('p.data','organization'),eb.val('other')),'=',query.organization);
  if(query.domainId)rows=rows.where(field('p.data','domainId'),'=',query.domainId);
  rows=rows.orderBy(field('p.data','updatedAt'),'desc').orderBy(db.expressions.rowOrder('original'),'asc');
  return pageOf<{data:string},ReturnType<typeof paperView>>(store,query,rows,row=>paperView(cleanLearningRecord('papers',JSON.parse(row.data)) as StoredPaper));
}

export function attemptList(store:Store,query:{page?:number;pageSize?:number;paperId?:string;source?:string;status?:string}) {
  const db=store.database,field=db.expressions.field.bind(db.expressions);
  let rows=db.query.selectFrom('attempts as a').select('a.data');
  if(query.paperId)rows=rows.where(field('a.data','paperId'),'=',query.paperId);
  if(query.source)rows=rows.where(eb=>eb.fn.coalesce(field<string>('a.data','source'),eb.val('paper')),'=',query.source);
  if(query.status)rows=rows.where(field('a.data','status'),'=',query.status);
  // Imported IDs may contain Unicode, case or punctuation. Binary SQL order
  // differs from the established localeCompare tie-breaker. Sort only tiny
  // headers in JS; keep complete question/answer snapshots page-local.
  const headers=db.all(rows.clearSelect().select('a.id').select(eb=>eb.fn.coalesce(field<string>('a.data','updatedAt'),field<string>('a.data','startedAt')).as('sortStamp')).orderBy(db.expressions.rowOrder('a'),'asc'));
  const compare=new Intl.Collator().compare;headers.sort((a,b)=>compare(b.sortStamp,a.sortStamp)||compare(b.id,a.id));
  const paged=query.page!==undefined||query.pageSize!==undefined,page=query.page??1,pageSize=query.pageSize??20;
  const selected=paged?headers.slice((page-1)*pageSize,page*pageSize):headers;
  const records=selected.length?db.all(db.query.selectFrom('attempts as a').select(['a.id','a.data']).where(db.expressions.idInJson('a.id',selected.map(row=>row.id)))):[];
  const byId=new Map(records.map(row=>[row.id,row.data]));
  const items=selected.map(row=>attemptView(cleanLearningRecord('attempts',JSON.parse(byId.get(row.id)!)) as StoredAttempt));
  return paged?{items,total:headers.length,page,pageSize}:items;
}

