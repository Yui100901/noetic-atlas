import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Question, StudyState } from '../../../shared/models/types.js';
import type { LearningSource } from '../../../shared/practice/context-learning.js';
import type { GlobalLearningKind, GlobalLearningQuestion, GlobalLearningSummary, LearningCardSummaries, LearningOrigin } from '../../../shared/practice/global-learning.js';
import type { Paged } from '../../../shared/utils/pagination.js';
import { cleanLearningRecord } from '../../../shared/questions/learning-records.js';
import type { Store } from '../../core/store.js';
import { id, parse } from '../../core/validation.js';
import { paginationFields } from '../../core/pagination.js';
import { flattenQuestions } from '../questions/structure.js';
import { learningJudgment, learningQuestionKey, type LearningJudgingItem } from './learning-state.js';
import { QUICK_PAPER_ID, type StoredAttempt } from './service.js';

export const globalLearningSummaryQuerySchema=z.object({}).strict();
export const globalLearningQuestionsQuerySchema=z.object({kind:z.enum(['wrong','favorite','due']),...paginationFields,page:paginationFields.page.default(1),pageSize:paginationFields.pageSize.default(20)}).strict();
export const learningCardSummariesInputSchema=z.object({paperIds:z.array(id).min(1).max(100).refine(ids=>new Set(ids).size===ids.length,'题集ID不得重复')}).strict();

interface Leaf { id:string; sourceId:string }
interface AttemptMetadata {
  id:string; source:LearningSource|null; paperId:string; paperTitle:string; paperVersion:number;
  status:'in_progress'|'submitted'; startedAt:string; submittedAt:string|null; updatedAt:string|null; items:string;
}
interface Entry extends Leaf { key:string; attempt:AttemptMetadata; answerState?:'incorrect'|'unanswered' }
interface Context {
  source:LearningSource; paperId:string; drafts:number; submitted:number;
  latest:Map<string,Entry>; judged:Map<string,{wrong:boolean;entry:Entry}>; wrongCounts:Map<string,number>;
}
interface PaperMetadata { id:string; title:string; version:number; archived:number; leaves:string }
interface LibraryLeaf extends Leaf { key:string; favorite:boolean; due:boolean; nextReviewAt:string|null }
interface GlobalCandidate extends Leaf { key:string; entries:Array<{context:Context;entry:Entry}>; selected?:Entry }
const timestamp=(value?:string|null)=>Date.parse(value||'')||0;
const practicedAt=(attempt:AttemptMetadata)=>attempt.submittedAt||attempt.updatedAt||attempt.startedAt;
const recentEntries=(a:Entry,b:Entry)=>timestamp(practicedAt(b.attempt))-timestamp(practicedAt(a.attempt))||b.attempt.id.localeCompare(a.attempt.id);

/** One compact query for the requested contexts. No attempt or question body,
 * subjective answer text, study notes or full paper snapshot crosses this read. */
function attemptContexts(store:Store,paperIds?:readonly string[]):Context[] {
  const db=store.database,field=db.expressions.field.bind(db.expressions);
  let query=db.query.selectFrom('attempts as a').select('a.id').select([
    field<LearningSource|null>('a.data','source').as('source'),field<string>('a.data','paperId').as('paperId'),field<string>('a.data','paperTitle').as('paperTitle'),field<number>('a.data','paperVersion').as('paperVersion'),
    field<'in_progress'|'submitted'>('a.data','status').as('status'),field<string>('a.data','startedAt').as('startedAt'),field<string|null>('a.data','submittedAt').as('submittedAt'),field<string|null>('a.data','updatedAt').as('updatedAt'),db.expressions.attemptLearningItems('a.data').as('items'),
  ]);
  if(paperIds)query=query.where(eb=>eb.or([eb(field('a.data','source'),'=','paper'),eb(field('a.data','source'),'is',null)])).where(field<string>('a.data','paperId'),'in',paperIds);
  const rows=db.all(query).sort((a,b)=>timestamp(practicedAt(b))-timestamp(practicedAt(a))||b.id.localeCompare(a.id));
  const contexts=new Map<string,Context>();
  for(const attempt of rows){
    const source=attempt.source||'paper',contextKey=JSON.stringify([source,attempt.paperId]);
    let context=contexts.get(contextKey);
    if(!context){context={source,paperId:attempt.paperId,drafts:0,submitted:0,latest:new Map(),judged:new Map(),wrongCounts:new Map()};contexts.set(contextKey,context);}
    if(attempt.status==='submitted')context.submitted++;else context.drafts++;
    for(const item of JSON.parse(attempt.items) as LearningJudgingItem[]){
      const sourceId=item.sourceQuestionId||item.id,key=learningQuestionKey(sourceId,item.id),entry:Entry={id:item.id,sourceId,key,attempt};
      if(!context.latest.has(key))context.latest.set(key,entry);
      if(attempt.status!=='submitted')continue;
      const judgment=learningJudgment(item);if(!judgment)continue;
      entry.answerState=judgment.answerState;
      if(judgment.wrong)context.wrongCounts.set(key,(context.wrongCounts.get(key)||0)+1);
      if(!context.judged.has(key))context.judged.set(key,{wrong:judgment.wrong,entry});
    }
  }
  return [...contexts.values()];
}

function papers(store:Store,options:{paperIds?:readonly string[];sourceIds?:readonly string[]}={}):PaperMetadata[] {
  const db=store.database,field=db.expressions.field.bind(db.expressions);
  // Reuse clean compact projections without mutating caches during a read.
  // Dirty/missing projections fall back to their current authoritative row.
  const source=db.query.selectFrom('papers as original').leftJoin('paper_read_model as projected','projected.id','original.id')
    .leftJoin('projection_pending as pending',join=>join.onRef('pending.source_id','=','original.id').on('pending.source_table','=','papers'))
    .select('original.id').select(eb=>eb.case().when('pending.source_id','is not',null).then(eb.ref('original.data')).else(eb.fn.coalesce('projected.data','original.data')).end().as('data')).as('p');
  let query=db.query.selectFrom(source).select('p.id').select([field<string>('p.data','title').as('title'),field<number>('p.data','version').as('version'),field<number>('p.data','archived').as('archived'),db.expressions.paperLearningLeaves('p.data').as('leaves')]);
  if(options.paperIds){if(!options.paperIds.length)return [];query=query.where(db.expressions.idInJson('p.id',options.paperIds));}
  if(options.sourceIds){if(!options.sourceIds.length)return [];query=query.where(db.expressions.arrayAny('p.data','questionIds',options.sourceIds));}
  return db.all(query);
}
function libraryLeaves(store:Store):LibraryLeaf[] {
  const db=store.database,field=db.expressions.field.bind(db.expressions),now=Date.now();
  const rows=db.all(db.query.selectFrom('study as s').innerJoin('questions as q','q.id','s.id').select([
    field<number>('s.data','favorite').as('favorite'),field<string|null>('s.data','nextReviewAt').as('nextReviewAt'),db.expressions.questionLearningLeaves('q.data').as('leaves'),
  ]).where(eb=>eb.or([eb(field('s.data','favorite'),'=',1),eb(field('s.data','nextReviewAt'),'is not',null)])));
  return rows.flatMap(row=>{
    const favorite=!!row.favorite,due=!!row.nextReviewAt&&Number.isFinite(Date.parse(row.nextReviewAt))&&Date.parse(row.nextReviewAt)<=now;
    if(!favorite&&!due)return [];
    return (JSON.parse(row.leaves) as Leaf[]).map(leaf=>({...leaf,key:learningQuestionKey(leaf.sourceId,leaf.id),favorite,due,nextReviewAt:row.nextReviewAt}));
  });
}
function wrongCandidates(contexts:Context[]):GlobalCandidate[] {
  const result=new Map<string,GlobalCandidate>();
  for(const context of contexts)for(const {wrong,entry} of context.judged.values())if(wrong){
    let candidate=result.get(entry.key);
    if(!candidate){candidate={key:entry.key,id:entry.id,sourceId:entry.sourceId,entries:[]};result.set(entry.key,candidate);}
    candidate.entries.push({context,entry});
    if(!candidate.selected||recentEntries(entry,candidate.selected)<0)candidate.selected=entry;
  }
  return [...result.values()].sort((a,b)=>recentEntries(a.selected!,b.selected!)||a.key.localeCompare(b.key,undefined,{numeric:true}));
}
function attemptOrigin(context:Context,entry:Entry,paperMap:Map<string,PaperMetadata>):LearningOrigin {
  const a=entry.attempt,paper=paperMap.get(context.paperId);
  return {source:context.source,...(context.source==='paper'?{paperId:context.paperId,deleted:!paper,archived:!!paper?.archived}:{}),paperTitle:a.paperTitle||'随机练习',attemptId:a.id,paperVersion:a.paperVersion,startedAt:a.startedAt,submittedAt:a.submittedAt,questionId:entry.id,...(entry.answerState?{answerState:entry.answerState}:{}),wrongCount:context.wrongCounts.get(entry.key)||0};
}
function hydrate(store:Store,candidates:GlobalCandidate[],kind:GlobalLearningKind,contexts:Context[]):GlobalLearningQuestion[] {
  if(!candidates.length)return [];
  const db=store.database,roots=[...new Set(candidates.map(candidate=>candidate.sourceId))],pageKeys=new Set(candidates.map(candidate=>candidate.key));
  const relevantPaperIds=[...new Set(candidates.flatMap(candidate=>candidate.entries.filter(({context})=>context.source==='paper').map(({context})=>context.paperId)))];
  const paperRows=papers(store,kind==='wrong'?{paperIds:relevantPaperIds}:{sourceIds:roots}),paperMap=new Map(paperRows.map(paper=>[paper.id,paper]));
  const memberships=new Map<string,LearningOrigin[]>();
  if(kind!=='wrong')for(const paper of paperRows)for(const leaf of JSON.parse(paper.leaves) as Leaf[]){
    const key=learningQuestionKey(leaf.sourceId,leaf.id);if(!pageKeys.has(key))continue;
    const origins=memberships.get(key)||[];
    origins.push({source:'paper',paperId:paper.id,paperTitle:paper.title,paperVersion:paper.version,deleted:false,archived:!!paper.archived,questionId:leaf.id});memberships.set(key,origins);
  }
  // Deleted contexts absent from current memberships still need accurate flags.
  if(kind!=='wrong'){
    const historyPaperIds=[...new Set(contexts.filter(context=>context.source==='paper'&&[...context.latest.keys()].some(key=>pageKeys.has(key))).map(context=>context.paperId))].filter(id=>!paperMap.has(id));
    for(const paper of papers(store,{paperIds:historyPaperIds}))paperMap.set(paper.id,paper);
  }
  const attemptIds=[...new Set(candidates.flatMap(candidate=>candidate.selected?[candidate.selected.attempt.id]:[]))];
  const attemptRows=attemptIds.length?db.all(db.query.selectFrom('attempts').select(['id','data']).where(db.expressions.idInJson('id',attemptIds))):[];
  const snapshots=new Map(attemptRows.map(row=>[row.id,new Map((cleanLearningRecord('attempts',JSON.parse(row.data)) as StoredAttempt).questions.map(q=>[q.id,q]))]));
  const questionRows=kind==='wrong'?[]:db.all(db.query.selectFrom('questions').select(['id','data']).where(db.expressions.idInJson('id',roots)));
  const current=new Map(questionRows.flatMap(row=>flattenQuestions([cleanLearningRecord('questions',JSON.parse(row.data)) as Question]).map(q=>[learningQuestionKey(q.sourceQuestionId||q.id,q.id),q] as const)));
  const stateRows=db.all(db.query.selectFrom('study as s').innerJoin('questions as q','q.id','s.id').select(['s.id','s.data']).where(db.expressions.idInJson('s.id',roots)));
  const states=new Map(stateRows.map(row=>[row.id,JSON.parse(row.data) as StudyState]));
  return candidates.map(candidate=>{
    const entries=kind==='wrong'?candidate.entries:contexts.flatMap(context=>{const entry=context.latest.get(candidate.key);return entry?[{context,entry}]:[];});
    entries.sort((a,b)=>recentEntries(a.entry,b.entry));
    const origins=[...(kind==='wrong'?[]:memberships.get(candidate.key)||[]),...entries.map(({context,entry})=>attemptOrigin(context,entry,paperMap))];
    if(!origins.length)origins.push({source:'library',paperTitle:'知识题库',questionId:candidate.id});
    const selected=candidate.selected,lastPracticedAt=selected?practicedAt(selected.attempt):entries[0]?practicedAt(entries[0].entry.attempt):undefined;
    return {key:candidate.key,question:selected?snapshots.get(selected.attempt.id)!.get(candidate.id)!:current.get(candidate.key)!,snapshotSource:kind==='wrong'?'attempt':'library',origins,wrongCount:entries.reduce((n,{context})=>n+(context.wrongCounts.get(candidate.key)||0),0),...(selected?{attemptId:selected.attempt.id,...(selected.answerState?{answerState:selected.answerState}:{})}:{}),...(lastPracticedAt?{lastPracticedAt}:{}),...(states.has(candidate.sourceId)?{study:states.get(candidate.sourceId)!}:{})};
  });
}

export function globalLearningSummary(store:Store):GlobalLearningSummary {
  const leaves=libraryLeaves(store);
  return {counts:{wrong:wrongCandidates(attemptContexts(store)).length,favorite:leaves.filter(leaf=>leaf.favorite).length,due:leaves.filter(leaf=>leaf.due).length}};
}
export function globalLearningQuestions(store:Store,query:{kind:GlobalLearningKind;page:number;pageSize:number}):Paged<GlobalLearningQuestion> {
  const contexts=attemptContexts(store);
  const candidates:GlobalCandidate[]=query.kind==='wrong'?wrongCandidates(contexts):libraryLeaves(store).filter(leaf=>query.kind==='favorite'?leaf.favorite:leaf.due).sort((a,b)=>(query.kind==='due'?timestamp(a.nextReviewAt)-timestamp(b.nextReviewAt):0)||a.key.localeCompare(b.key,undefined,{numeric:true})).map(leaf=>({...leaf,entries:[]}));
  const selected=candidates.slice((query.page-1)*query.pageSize,query.page*query.pageSize);
  return {items:hydrate(store,selected,query.kind,contexts),total:candidates.length,page:query.page,pageSize:query.pageSize};
}
export function learningCardSummaries(store:Store,paperIds:readonly string[]):LearningCardSummaries {
  const contexts=attemptContexts(store,paperIds),byPaper=new Map(contexts.map(context=>[context.paperId,context])),paperRows=papers(store,{paperIds}),paperMap=new Map(paperRows.map(paper=>[paper.id,paper]));
  const members=new Map<string,Map<string,Leaf>>();
  for(const paperId of paperIds){
    const context=byPaper.get(paperId),leaves=new Map<string,Leaf>(context?[...context.latest].map(([key,entry])=>[key,{id:entry.id,sourceId:entry.sourceId}]):[]);
    const paper=paperMap.get(paperId);if(paper)for(const leaf of JSON.parse(paper.leaves) as Leaf[])leaves.set(learningQuestionKey(leaf.sourceId,leaf.id),leaf);
    members.set(paperId,leaves);
  }
  const roots=[...new Set([...members.values()].flatMap(leaves=>[...leaves.values()].map(leaf=>leaf.sourceId)))],db=store.database,field=db.expressions.field.bind(db.expressions);
  const states=roots.length?db.all(db.query.selectFrom('study as s').innerJoin('questions as q','q.id','s.id').select('s.id').select([field<number>('s.data','favorite').as('favorite'),field<string|null>('s.data','nextReviewAt').as('nextReviewAt')]).where(db.expressions.idInJson('s.id',roots))):[];
  const stateMap=new Map(states.map(state=>[state.id,state])),now=Date.now();
  return {items:paperIds.map(paperId=>{
    const context=byPaper.get(paperId),leaves=members.get(paperId)!;let favorite=0,due=0;
    for(const leaf of leaves.values()){
      const state=stateMap.get(leaf.sourceId);if(state?.favorite)favorite++;
      if(state?.nextReviewAt&&Number.isFinite(Date.parse(state.nextReviewAt))&&Date.parse(state.nextReviewAt)<=now)due++;
    }
    return {paperId,counts:{drafts:context?.drafts||0,submitted:context?.submitted||0,wrong:context?[...context.judged.values()].filter(value=>value.wrong).length:0,favorite,due}};
  })};
}
export function registerGlobalLearningRoutes(app:FastifyInstance,store:Store) {
  app.get('/api/learning/global/summary',async request=>{parse(globalLearningSummaryQuerySchema,request.query);return globalLearningSummary(store);});
  app.get('/api/learning/global/questions',async request=>globalLearningQuestions(store,parse(globalLearningQuestionsQuerySchema,request.query)));
  app.post('/api/learning/card-summaries',async request=>learningCardSummaries(store,parse(learningCardSummariesInputSchema,request.body).paperIds));
}
