import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AttemptAnswer, VocabularyDirection } from '../../../shared/models/types.js';
import type { Store } from '../../core/store.js';
import { id, parse } from '../../core/validation.js';
import { paginationFields } from '../../core/pagination.js';
import type { StoredLeafQuestion } from './structure.js';
import { questionHistoryLimit, type QuestionHistoryRecord } from './history-store.js';
import { learningQuestionKey } from '../practice/learning-state.js';

export const questionHistoryQuerySchema=z.object({...paginationFields,page:paginationFields.page.default(1),pageSize:paginationFields.pageSize.default(10),partId:id.optional(),summary:z.enum(['true','false']).default('true')}).strict();

export function questionStatistics(store:Store,questionId:string,partId?:string) {
  const db=store.database,field=db.expressions.field.bind(db.expressions);
  const rows=db.all(db.query.selectFrom('learning_results').select(field<string>('data','submittedAt').as('submittedAt')).select(db.expressions.learningQuestionItems('data',questionId,partId).as('items')).where(db.expressions.learningQuestionItems('data',questionId,partId),'!=','[]'));
  const summary={answered:0,correct:0,partial:0,incorrect:0,ungraded:0,lastAnsweredAt:null as string|null,unknown:0};
  for(const row of rows)for(const item of JSON.parse(row.items) as Array<{answered?:boolean;judgment?:string}>){
    if(item.answered===undefined){summary.unknown++;continue;}
    if(!item.answered)continue;
    summary.answered++;
    if(item.judgment==='correct')summary.correct++;
    else if(item.judgment==='partial')summary.partial++;
    else if(item.judgment==='incorrect')summary.incorrect++;
    else summary.ungraded++;
    if(!summary.lastAnsweredAt||row.submittedAt>summary.lastAnsweredAt)summary.lastAnsweredAt=row.submittedAt;
  }
  return summary;
}

export function questionHistory(store:Store,questionId:string,query:{partId?:string;page:number;pageSize:number;summary?:'true'|'false'}) {
  const db=store.database,field=db.expressions.field.bind(db.expressions),limit=questionHistoryLimit(store);
  let selection=db.query.selectFrom('question_history as h').leftJoin('attempts as a',join=>join.onRef('a.id','=',field<string>('h.data','attemptId'))).leftJoin('learning_results as r',join=>join.onRef('r.id','=',field<string>('h.data','attemptId'))).where(field('h.data','questionId'),'=',questionId);
  if(query.partId!==undefined)selection=selection.where(field('h.data','partId'),'=',query.partId);
  const total=limit===0?0:Number(db.one(selection.select(eb=>eb.fn.countAll<number>().as('total')))?.total||0);
  const rows=total?db.all(selection.select(['h.data','a.id as retainedId']).select(field<number|null>('r.data','reset').as('reset')).orderBy(field('h.data','submittedAt'),'desc').orderBy('h.id','desc').limit(query.pageSize).offset((query.page-1)*query.pageSize)):[];
  const entries=rows.map(row=>{const record=JSON.parse(row.data) as QuestionHistoryRecord;return {record,historyAvailable:!!row.retainedId,beforeReset:!!row.reset||!!record.beforeReset};});
  const references=entries.filter(entry=>entry.historyAvailable),attemptIds=[...new Set(references.map(entry=>entry.record.attemptId))];
  const raw=attemptIds.length?db.all(db.query.selectFrom('attempts').select('id').select([
    db.expressions.selectedLearningQuestions('data',references.map(({record})=>({sourceId:record.questionId,id:record.leafId}))).as('questions'),
    db.expressions.selectedAttemptAnswers('data',references.map(({record})=>record.leafId)).as('answers'),
    field<VocabularyDirection | null>('data','vocabularyDirection').as('vocabularyDirection'),
  ]).where(db.expressions.idInJson('id',attemptIds))):[];
  const attempts=new Map(raw.map(row=>[row.id,{vocabularyDirection:row.vocabularyDirection||undefined,questions:new Map((JSON.parse(row.questions) as StoredLeafQuestion[]).map(q=>[learningQuestionKey(q.sourceQuestionId||q.id,q.id),q])),answers:JSON.parse(row.answers) as Record<string,AttemptAnswer>}]));
  const items=entries.map(({record,historyAvailable,beforeReset})=>{
    const source=attempts.get(record.attemptId),question=source?.questions.get(learningQuestionKey(record.questionId,record.leafId))||record.detail?.question,answer=source?.answers[record.leafId]||record.detail?.answer;
    if(!question||!answer)throw new Error('单题历史引用不完整，请从有效备份恢复');
    const vocabularyDirection=record.vocabularyDirection||source?.vocabularyDirection;
    return {id:record.id,attemptId:record.attemptId,source:record.source,paperId:record.paperId,paperTitle:record.paperTitle,paperVersion:record.paperVersion,...(vocabularyDirection?{vocabularyDirection}:{}),submittedAt:record.submittedAt,historyAvailable,question,answer,verdict:record.verdict,points:record.points,score:record.score,...(beforeReset?{beforeReset:true}:{})};
  });
  return {...(query.summary==='false'?{}:{summary:questionStatistics(store,questionId,query.partId)}),retention:{limit,available:total},items,total,page:query.page,pageSize:query.pageSize};
}

export function registerQuestionHistoryRoutes(app:FastifyInstance,store:Store) {
  app.get('/api/questions/:id/history',async request=>questionHistory(store,parse(id,(request.params as {id:string}).id),parse(questionHistoryQuerySchema,request.query)));
  app.get('/api/questions/:id/statistics',async request=>{const query=parse(z.object({partId:id.optional()}).strict(),request.query);return questionStatistics(store,parse(id,(request.params as {id:string}).id),query.partId);});
}
