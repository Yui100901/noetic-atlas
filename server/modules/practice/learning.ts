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
  if(!paper&&!rows.length)fail(404,'LEARNING_CONTEXT_NOT_FOUND','题集及其学习记录均不存在');
  return {context:{source:'paper' as const,paperId:input.paperId!},title:paper?.title||rows[0]!.title||'已删除题集',deleted:!paper,archived:!!paper?.archived,headers:rows};
}
type ResolvedContext=ReturnType<typeof resolveContext>;
interface Candidate {id:string;sourceId:string;attemptId?:string;lastPracticedAt?:string;wrongCount:number;answerState?:'incorrect'|'unanswered'}
// An ordinary question may legally contain "::" in its ID and match another
// root's flattened leaf ID. Retain both the owning root and leaf identity.
const candidateKey=(candidate:Pick<Candidate,'sourceId'|'id'>)=>learningQuestionKey(candidate.sourceId,candidate.id);
function contextQuestions(store:Store,resolved:ResolvedContext) {
  const db=store.database,field=db.expressions.field.bind(db.expressions),context=resolved.context;
  // Only this source's attempts are read, and only compact judging fields.
  // Complete immutable content is fetched for the requested question page.
  const rows=db.all(attemptRows(store,context).select('a.id').select([
    field<string>('a.data','status').as('status'),field<string>('a.data','startedAt').as('startedAt'),field<string|null>('a.data','submittedAt').as('submittedAt'),field<string|null>('a.data','updatedAt').as('updatedAt'),db.expressions.attemptLearningItems('a.data').as('items'),
  ])).sort((a,b)=>time(b.submittedAt||b.updatedAt||b.startedAt)-time(a.submittedAt||a.updatedAt||a.startedAt)||b.id.localeCompare(a.id));
  const latest=new Map<string,Candidate>(),judged=new Map<string,{wrong:boolean;candidate:Candidate}>(),wrongCounts=new Map<string,number>();
  for(const row of rows)for(const item of JSON.parse(row.items) as LearningJudgingItem[]) {
    const candidate:Candidate={id:item.id,sourceId:item.sourceQuestionId||item.id,attemptId:row.id,lastPracticedAt:row.submittedAt||row.updatedAt||row.startedAt,wrongCount:0};
    const key=candidateKey(candidate);
    if(!latest.has(key))latest.set(key,candidate);
    if(row.status!=='submitted')continue;
    const judgment=learningJudgment(item);if(!judgment)continue;
    if(judgment.wrong){candidate.answerState=judgment.answerState;wrongCounts.set(key,(wrongCounts.get(key)||0)+1);}
    if(!judged.has(key))judged.set(key,{wrong:judgment.wrong,candidate});
  }
  // Unpracticed current members still participate in shared favorites/review.
  if(context.source==='paper'&&!resolved.deleted){
    db.projections.ensure(['papers']);
    const paper=db.one(db.query.selectFrom('paper_read_model').select(field<string>('data','snapshot').as('snapshot')).where('id','=',context.paperId!));
    if(paper?.snapshot)for(const q of flattenQuestions(JSON.parse(paper.snapshot) as Question[])){
      const candidate:Candidate={id:q.id,sourceId:q.sourceQuestionId||q.id,wrongCount:0},key=candidateKey(candidate);
      if(!latest.has(key))latest.set(key,candidate);
    }
  }
  const roots=[...new Set([...latest.values()].map(candidate=>candidate.sourceId))];
  const stateRows=roots.length?db.all(db.query.selectFrom('study as s').innerJoin('questions as q','q.id','s.id').select('s.id').select([field<number>('s.data','favorite').as('favorite'),field<string|null>('s.data','nextReviewAt').as('nextReviewAt')]).where(db.expressions.idInJson('s.id',roots))):[];
  const states=new Map(stateRows.map(row=>[row.id,row]));
  const wrong=[...judged.values()].filter(value=>value.wrong).map(value=>({...value.candidate,wrongCount:wrongCounts.get(candidateKey(value.candidate))||0}));
  const recent=(a:Candidate,b:Candidate)=>time(b.lastPracticedAt)-time(a.lastPracticedAt)||a.id.localeCompare(b.id,undefined,{numeric:true});
  wrong.sort(recent);
  const favorite:Candidate[]=[],due:Candidate[]=[],stamp=Date.now();
  for(const candidate of latest.values()){
    candidate.wrongCount=wrongCounts.get(candidateKey(candidate))||0;
    const state=states.get(candidate.sourceId);if(state?.favorite)favorite.push(candidate);
    if(state?.nextReviewAt&&Number.isFinite(Date.parse(state.nextReviewAt))&&Date.parse(state.nextReviewAt)<=stamp)due.push(candidate);
  }
  favorite.sort(recent);due.sort((a,b)=>time(states.get(a.sourceId)?.nextReviewAt)-time(states.get(b.sourceId)?.nextReviewAt)||recent(a,b));
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
  suggestions.push('建议依据本来源保留的作答历史与原题共享的收藏、复习日期生成；未判主观题不记错，未调用AI。');
  return {...resolved.context,title:resolved.title,deleted:resolved.deleted,archived:resolved.archived,counts,suggestions};
}
function page<T>(items:T[],query:{page:number;pageSize:number}):Paged<T>{return {items:items.slice((query.page-1)*query.pageSize,query.page*query.pageSize),total:items.length,page:query.page,pageSize:query.pageSize};}
function historyItem(attempt:StoredAttempt):AttemptHistoryItem {
  const scoring=normalizeScoring(attempt.questions,attempt.scoring),subjective=attempt.questions.filter(q=>isSubjectiveType(q.type)),pending=scoring.enabled?subjective.filter(q=>attempt.answers[q.id]?.selfScore==null).length:0;
  const gradingStatus=!scoring.enabled?'not_applicable':!pending&&attempt.status==='submitted'?'complete':pending<subjective.length?'partial':'pending';
  return {id:attempt.id,source:attempt.source||'paper',paperId:attempt.paperId,paperTitle:attempt.paperTitle,paperVersion:attempt.paperVersion,status:attempt.status,referenceViewedAt:attempt.referenceViewedAt??null,practiceMode:attempt.practiceMode||'practice',startedAt:attempt.startedAt,updatedAt:attempt.updatedAt||attempt.submittedAt||attempt.startedAt,submittedAt:attempt.submittedAt,elapsedSeconds:attemptElapsedSeconds(attempt),durationMinutes:attempt.durationMinutes??null,deadlineAt:attempt.deadlineAt??null,autoSubmitted:!!attempt.autoSubmitted,questionCount:attempt.questions.length,answeredCount:attempt.questions.filter(q=>isAnswerPresent(attempt.answers[q.id])).length,scoringEnabled:scoring.enabled,totalPoints:scoring.totalPoints,objectiveScore:attempt.objectiveScore,objectiveMax:attempt.objectiveMax,subjectiveScore:attempt.subjectiveScore,subjectiveMax:attempt.subjectiveMax,totalScore:scoring.enabled&&attempt.status==='submitted'&&!pending?Math.round((attempt.objectiveScore+attempt.subjectiveScore)*100)/100:null,pendingSubjectiveCount:pending,gradingStatus};
}
function hydrateQuestions(store:Store,resolved:ResolvedContext,candidates:Candidate[]):ContextLearningQuestion[] {
  if(!candidates.length)return [];
  const db=store.database,attemptIds=[...new Set(candidates.flatMap(candidate=>candidate.attemptId?[candidate.attemptId]:[]))];
  const attempts=attemptIds.length?db.all(db.query.selectFrom('attempts').select(['id','data']).where(db.expressions.idInJson('id',attemptIds))):[];
  const snapshots=new Map(attempts.map(row=>[row.id,new Map((cleanLearningRecord('attempts',JSON.parse(row.data)) as StoredAttempt).questions.map(q=>[q.id,q]))]));
  const paperQuestions=candidates.some(candidate=>!candidate.attemptId)?new Map(flattenQuestions(store.require<StoredPaper>('papers',resolved.context.paperId!).snapshot).map(q=>[q.id,q])):new Map<string,StoredLeafQuestion>();
  const roots=[...new Set(candidates.map(candidate=>candidate.sourceId))];
  const states=db.all(db.query.selectFrom('study as s').innerJoin('questions as q','q.id','s.id').select(['s.id','s.data']).where(db.expressions.idInJson('s.id',roots)));
  const study=new Map(states.map(row=>[row.id,JSON.parse(row.data) as StudyState]));
  return candidates.map(candidate=>({question:candidate.attemptId?snapshots.get(candidate.attemptId)!.get(candidate.id)!:paperQuestions.get(candidate.id)!,...(candidate.attemptId?{attemptId:candidate.attemptId}:{}),wrongCount:candidate.wrongCount,...(candidate.answerState?{answerState:candidate.answerState}:{}),...(candidate.lastPracticedAt?{lastPracticedAt:candidate.lastPracticedAt}:{}),...(study.has(candidate.sourceId)?{study:study.get(candidate.sourceId)!}:{})}));
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
    const selected=page(ids,query);return {...selected,items:selected.items.map(row=>summary(store,resolveContext(store,{source:'paper',paperId:row.paperId})))};
  });
}
