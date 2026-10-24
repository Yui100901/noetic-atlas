import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Question, StudyState } from '../../../shared/models/types.js';
import type { AttemptHistoryItem, ContextLearningQuestion, ContextLearningSummary, LearningContext } from '../../../shared/practice/context-learning.js';
import type { Paged } from '../../../shared/utils/pagination.js';
import { isAnswerPresent, attemptElapsedSeconds } from '../../../shared/practice/attempt-timing.js';
import { isSubjectiveType } from '../../../shared/questions/question-utils.js';
import { cleanLearningRecord } from '../../../shared/questions/learning-records.js';
import type { Store } from '../../core/store.js';
import { fail, id, parse } from '../../core/validation.js';
import { paginationFields } from '../../core/pagination.js';
import { flattenQuestions, type StoredLeafQuestion } from '../questions/structure.js';
import { normalizeScoring } from './scoring.js';
import { QUICK_PAPER_ID, type StoredAttempt, type StoredPaper } from './service.js';
import { learningQuestionKey, learningJudgment, type LearningJudgingItem } from './learning-state.js';
import { learningMetadata, learningSnapshots } from './learning-results.js';
import { loadLeafStudies } from '../study/state.js';

const contextFields={source:z.enum(['paper','quick']),paperId:id.optional()};
const pageFields={...paginationFields,page:paginationFields.page.default(1),pageSize:paginationFields.pageSize.default(20)};
function contextRule(value:LearningContext,ctx:z.RefinementCtx) {
  if(value.source==='paper'&&(!value.paperId||value.paperId===QUICK_PAPER_ID))ctx.addIssue({code:'custom',path:['paperId'],message:'题集学习记录必须指定有效题集ID'});
  if(value.source==='quick'&&value.paperId)ctx.addIssue({code:'custom',path:['paperId'],message:'随机练习上下文不指定题集ID'});
}
export const learningSummaryQuerySchema=z.object(contextFields).strict().superRefine(contextRule);
export const learningAttemptsQuerySchema=z.object({...contextFields,...pageFields,status:z.enum(['in_progress','submitted'])}).strict().superRefine(contextRule);
export const learningQuestionsQuerySchema=z.object({...contextFields,...pageFields,kind:z.enum(['wrong','due','favorite'])}).strict().superRefine(contextRule);
export const learningContextsQuerySchema=z.object(pageFields).strict();

function attemptRows(store:Store,context:LearningContext) {
  const db=store.database,field=db.expressions.field.bind(db.expressions);
  // Match the existing (source, paperId, status) expression index. Wrapping
  // source in coalesce would force a scan of every source's attempt snapshots.
  return db.query.selectFrom('attempts as a').where(eb=>context.source==='quick'
    ?eb(field<string>('a.data','source'),'=','quick')
    :eb.or([eb(field<string>('a.data','source'),'=','paper'),eb(field('a.data','source'),'is',null)]))
    .where(field('a.data','paperId'),'=',context.source==='quick'?QUICK_PAPER_ID:context.paperId!);
}
function headers(store:Store,context:LearningContext) {
  const db=store.database,field=db.expressions.field.bind(db.expressions);
  const rows=db.all(attemptRows(store,context).select('a.id').select([
    field<string>('a.data','status').as('status'),field<string>('a.data','paperTitle').as('title'),
    field<string>('a.data','startedAt').as('startedAt'),field<string|null>('a.data','submittedAt').as('submittedAt'),field<string|null>('a.data','updatedAt').as('updatedAt'),
  ]));
  return rows.sort((a,b)=>time(b.updatedAt||b.submittedAt||b.startedAt)-time(a.updatedAt||a.submittedAt||a.startedAt)||b.id.localeCompare(a.id));
}
const time=(stamp?:string|null)=>Date.parse(stamp||'')||0;
function resolveContext(store:Store,input:LearningContext) {
  const rows=headers(store,input);
  if(input.source==='quick')return {context:{source:'quick' as const},title:'随机练习',deleted:false,archived:false,headers:rows};
  const db=store.database,field=db.expressions.field.bind(db.expressions);
  const paper=db.one(db.query.selectFrom('papers').select('id').select([field<string>('data','title').as('title'),field<number>('data','archived').as('archived')]).where('id','=',input.paperId!));
  const evidence=!paper&&!rows.length?db.one(db.query.selectFrom('learning_results').select(field<string>('data','paperTitle').as('title')).where(field('data','source'),'=','paper').where(field('data','paperId'),'=',input.paperId!).where(db.expressions.arrayLength('data','items'),'>',0).orderBy(field('data','submittedAt'),'desc').limit(1)):undefined;
  if(!paper&&!rows.length&&!evidence)fail(404,'LEARNING_CONTEXT_NOT_FOUND','题集及其学习记录均不存在');
  return {context:{source:'paper' as const,paperId:input.paperId!},title:paper?.title||rows[0]?.title||evidence?.title||'已删除题集',deleted:!paper,archived:!!paper?.archived,headers:rows};
}
type ResolvedContext=ReturnType<typeof resolveContext>;
interface Candidate {id:string;sourceId:string;partId?:string;attemptId?:string;historyAvailable?:boolean;lastPracticedAt?:string;wrongCount:number;answerState?:'incorrect'|'unanswered'}
// An ordinary question may legally contain "::" in its ID and match another
// root's flattened leaf ID. Retain both the owning root and leaf identity.
const candidateKey=(candidate:Pick<Candidate,'sourceId'|'id'>)=>learningQuestionKey(candidate.sourceId,candidate.id);
function contextQuestions(store:Store,resolved:ResolvedContext) {
  const db=store.database,field=db.expressions.field.bind(db.expressions),context=resolved.context;
  const rows=learningMetadata(store,{source:context.source,paperId:context.source==='quick'?QUICK_PAPER_ID:context.paperId});
  const latest=new Map<string,Candidate>(),judged=new Map<string,{wrong:boolean;candidate:Candidate}>(),wrongCounts=new Map<string,number>();
  for(const row of rows)for(const item of row.items) {
    const candidate:Candidate={id:item.id,sourceId:item.sourceQuestionId||item.id,...(item.partId?{partId:item.partId}:{}),attemptId:row.id,historyAvailable:row.historyAvailable,lastPracticedAt:row.submittedAt||row.updatedAt||row.startedAt,wrongCount:0};
    const key=candidateKey(candidate);
    if(!latest.has(key))latest.set(key,candidate);
    if(row.status!=='submitted')continue;
    if(!item.judgment)continue;
    const wrong=item.judgment!=='correct';
    if(wrong){candidate.answerState=item.judgment==='partial'?'incorrect':item.judgment as 'incorrect'|'unanswered';wrongCounts.set(key,(wrongCounts.get(key)||0)+1);}
    if(!judged.has(key))judged.set(key,{wrong,candidate});
  }
  // Unpracticed current members still participate in shared favorites/review.
  if(context.source==='paper'&&!resolved.deleted){
    const paper=db.one(db.query.selectFrom('papers').select(db.expressions.paperLearningLeaves('data').as('leaves')).where('id','=',context.paperId!));
    if(paper?.leaves)for(const q of JSON.parse(paper.leaves) as Array<{id:string;sourceId:string;partId?:string}>){
      const candidate:Candidate={id:q.id,sourceId:q.sourceId,...(q.partId?{partId:q.partId}:{}),wrongCount:0},key=candidateKey(candidate);
      if(!latest.has(key))latest.set(key,candidate);
    }
  }
  const states=loadLeafStudies(store,[...latest.values()]);
  const wrong=[...judged.values()].filter(value=>value.wrong).map(value=>({...value.candidate,wrongCount:wrongCounts.get(candidateKey(value.candidate))||0}));
  const recent=(a:Candidate,b:Candidate)=>time(b.lastPracticedAt)-time(a.lastPracticedAt)||a.id.localeCompare(b.id,undefined,{numeric:true});
  wrong.sort(recent);
  const favorite:Candidate[]=[],due:Candidate[]=[],stamp=Date.now();
  for(const candidate of latest.values()){
    candidate.wrongCount=wrongCounts.get(candidateKey(candidate))||0;
    const state=states.get(candidateKey(candidate));if(state?.favorite)favorite.push(candidate);
    if(state?.nextReviewAt&&Number.isFinite(Date.parse(state.nextReviewAt))&&Date.parse(state.nextReviewAt)<=stamp)due.push(candidate);
  }
  favorite.sort(recent);due.sort((a,b)=>time(states.get(candidateKey(a))?.nextReviewAt)-time(states.get(candidateKey(b))?.nextReviewAt)||recent(a,b));
  return {wrong,due,favorite};
}
function summary(store:Store,resolved:ResolvedContext):ContextLearningSummary {
  const questions=contextQuestions(store,resolved),drafts=resolved.headers.filter(row=>row.status==='in_progress').length,submitted=resolved.headers.filter(row=>row.status==='submitted').length;
  const counts={drafts,submitted,wrong:questions.wrong.length,due:questions.due.length,favorite:questions.favorite.length};
  const suggestions:string[]=[];
  if(drafts)suggestions.push(`有${drafts}份未完成作答，可先继续最近的草稿。`);
  if(counts.wrong)suggestions.push(`有${counts.wrong}道题在本来源最近已判作答中需要巩固，建议先看错题与解析，再重新作答。`);
  if(counts.due)suggestions.push(`有${counts.due}道关联题已到预定复习时间，可完成复习后重新安排日期。`);
  if(!submitted)suggestions.push('完成一次练习后，可在这里查看本来源的作答历史和错题。');
  if(!drafts&&!counts.wrong&&!counts.due&&submitted)suggestions.push('当前保留历史中没有待巩固错题或到期复习，可继续练习或复习收藏题。');
  suggestions.push('错题与来源独立保留，清理整卷历史不影响；收藏共享原题，组合小题独立复习。未判主观题不记错，未调用AI。');
  return {...resolved.context,title:resolved.title,deleted:resolved.deleted,archived:resolved.archived,counts,suggestions};
}
function page<T>(items:T[],query:{page:number;pageSize:number}):Paged<T>{return {items:items.slice((query.page-1)*query.pageSize,query.page*query.pageSize),total:items.length,page:query.page,pageSize:query.pageSize};}
function historyItem(attempt:StoredAttempt):AttemptHistoryItem {
  const scoring=normalizeScoring(attempt.questions,attempt.scoring),subjective=attempt.questions.filter(q=>isSubjectiveType(q.type)),pending=scoring.enabled?subjective.filter(q=>attempt.answers[q.id]?.selfScore==null).length:0;
  const gradingStatus=!scoring.enabled?'not_applicable':!pending&&attempt.status==='submitted'?'complete':pending<subjective.length?'partial':'pending';
  return {id:attempt.id,...(attempt.vocabularyDirection?{vocabularyDirection:attempt.vocabularyDirection}:{}),source:attempt.source||'paper',paperId:attempt.paperId,paperTitle:attempt.paperTitle,paperVersion:attempt.paperVersion,status:attempt.status,referenceViewedAt:attempt.referenceViewedAt??null,practiceMode:attempt.practiceMode||'practice',startedAt:attempt.startedAt,updatedAt:attempt.updatedAt||attempt.submittedAt||attempt.startedAt,submittedAt:attempt.submittedAt,elapsedSeconds:attemptElapsedSeconds(attempt),durationMinutes:attempt.durationMinutes??null,deadlineAt:attempt.deadlineAt??null,autoSubmitted:!!attempt.autoSubmitted,questionCount:attempt.questions.length,answeredCount:attempt.questions.filter(q=>isAnswerPresent(attempt.answers[q.id])).length,scoringEnabled:scoring.enabled,totalPoints:scoring.totalPoints,objectiveScore:attempt.objectiveScore,objectiveMax:attempt.objectiveMax,subjectiveScore:attempt.subjectiveScore,subjectiveMax:attempt.subjectiveMax,totalScore:scoring.enabled&&attempt.status==='submitted'&&!pending?Math.round((attempt.objectiveScore+attempt.subjectiveScore)*100)/100:null,pendingSubjectiveCount:pending,gradingStatus};
}
function hydrateQuestions(store:Store,resolved:ResolvedContext,candidates:Candidate[]):ContextLearningQuestion[] {
  if(!candidates.length)return [];
  const db=store.database;
  const snapshots=learningSnapshots(store,candidates.flatMap(candidate=>candidate.attemptId?[{...candidate,attemptId:candidate.attemptId}]:[]));
  const missing=candidates.filter(candidate=>!candidate.attemptId||!snapshots.get(candidate.attemptId)?.has(candidateKey(candidate)));
  const paper=missing.length&&resolved.context.source==='paper'?db.one(db.query.selectFrom('papers').select(db.expressions.arrayRecordsByIds('data','snapshot',missing.map(item=>item.sourceId)).as('snapshot')).where('id','=',resolved.context.paperId!)):undefined;
  const paperQuestions=paper?new Map(flattenQuestions(JSON.parse(paper.snapshot) as Question[]).map(q=>[learningQuestionKey(q.sourceQuestionId||q.id,q.id),q])):new Map<string,StoredLeafQuestion>();
  const roots=[...new Set(missing.filter(candidate=>!paperQuestions.has(candidateKey(candidate))).map(candidate=>candidate.sourceId))];
  const current=new Map((roots.length?db.all(db.query.selectFrom('questions').select('data').where(db.expressions.idInJson('id',roots))):[]).flatMap(row=>flattenQuestions([JSON.parse(row.data) as Question]).map(q=>[learningQuestionKey(q.sourceQuestionId||q.id,q.id),q] as const)));
  const study=loadLeafStudies(store,candidates,{includeNotes:true});
  return candidates.map(candidate=>{const key=candidateKey(candidate);return {question:(candidate.attemptId?snapshots.get(candidate.attemptId)?.get(key):undefined)||paperQuestions.get(key)||current.get(key)!,...(candidate.attemptId?{attemptId:candidate.attemptId,historyAvailable:candidate.historyAvailable}:{}),wrongCount:candidate.wrongCount,...(candidate.answerState?{answerState:candidate.answerState}:{}),...(candidate.lastPracticedAt?{lastPracticedAt:candidate.lastPracticedAt}:{}),...(study.has(key)?{study:study.get(key)!}:{})};});
}
export function registerContextLearningRoutes(app:FastifyInstance,store:Store) {
  app.get('/api/learning/summary',async request=>summary(store,resolveContext(store,parse(learningSummaryQuerySchema,request.query))));
  app.get('/api/learning/attempts',async request=>{
    const query=parse(learningAttemptsQuerySchema,request.query),resolved=resolveContext(store,query),selected=page(resolved.headers.filter(row=>row.status===query.status),query),db=store.database;
    const rows=selected.items.length?db.all(db.query.selectFrom('attempts').select(['id','data']).where(db.expressions.idInJson('id',selected.items.map(row=>row.id)))):[];
    const byId=new Map(rows.map(row=>[row.id,cleanLearningRecord('attempts',JSON.parse(row.data)) as StoredAttempt]));
    return {...selected,items:selected.items.map(row=>historyItem(byId.get(row.id)!))};
  });
  app.get('/api/learning/questions',async request=>{
    const query=parse(learningQuestionsQuerySchema,request.query),resolved=resolveContext(store,query),questions=contextQuestions(store,resolved),selected=page(questions[query.kind],query);
    return {...selected,items:hydrateQuestions(store,resolved,selected.items)};
  });
  app.get('/api/learning/contexts',async request=>{
    const query=parse(learningContextsQuerySchema,request.query),db=store.database,field=db.expressions.field.bind(db.expressions);
    const ids=db.all(db.query.selectFrom('attempts as a').leftJoin('papers as p',join=>join.on('p.id','=',field<string>('a.data','paperId'))).select(field<string>('a.data','paperId').as('paperId')).where('p.id','is',null).where(eb=>eb.or([eb(field<string>('a.data','source'),'=','paper'),eb(field('a.data','source'),'is',null)])).where(field('a.data','paperId'),'!=',QUICK_PAPER_ID).distinct()).sort((a,b)=>a.paperId.localeCompare(b.paperId,undefined,{numeric:true}));
    const evidence=db.all(db.query.selectFrom('learning_results as r').leftJoin('papers as p',join=>join.on('p.id','=',field<string>('r.data','paperId'))).select(field<string>('r.data','paperId').as('paperId')).where('p.id','is',null).where(field('r.data','source'),'=','paper').where(db.expressions.arrayLength('r.data','items'),'>',0).distinct());
    const combined=[...new Map([...ids,...evidence].map(row=>[row.paperId,row])).values()].sort((a,b)=>a.paperId.localeCompare(b.paperId,undefined,{numeric:true}));
    const selected=page(combined,query);return {...selected,items:selected.items.map(row=>summary(store,resolveContext(store,{source:'paper',paperId:row.paperId})))};
  });
}
