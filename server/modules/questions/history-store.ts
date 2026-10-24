import { z } from 'zod';
import { DEFAULT_SETTINGS } from '../../../shared/models/settings.js';
import { answerState, isAnswerPresent } from '../../../shared/practice/attempt-timing.js';
import type { Store } from '../../core/store.js';
import { answerSchema, fail, id, leafId, moneySchema, parse, snapshotQuestionSchema } from '../../core/validation.js';
import type { StoredAttempt } from '../practice/service.js';
import type { PaperScoring } from '../../../shared/models/types.js';
import type { StoredLeafQuestion } from './structure.js';
import { normalizeScoring } from '../practice/scoring.js';
import { learningJudgment } from '../practice/learning-state.js';

export const historyRecordId = (attemptId: string, questionId: string, itemId: string) => JSON.stringify([attemptId, questionId, itemId]);
const stamp = z.string().datetime({ offset: true });
export const questionHistorySchema = z.object({
  id: z.string().min(1).max(1000), questionId: id, partId: id.optional(), leafId, attemptId: id,
  source: z.enum(['paper','quick']), paperId: id, paperTitle: z.string().max(300), paperVersion: z.number().int().positive(),
  submittedAt: stamp, verdict: z.enum(['correct','partial','incorrect','ungraded']), score: moneySchema.nullable(), points: moneySchema.nullable(),
  beforeReset:z.boolean().optional(),
  detail: z.object({ question: snapshotQuestionSchema.safeExtend({ id: leafId }), answer: answerSchema }).strict().optional(),
}).strict().superRefine((record, context) => {
  if (record.id !== historyRecordId(record.attemptId, record.questionId, record.leafId) || (record.partId ? record.leafId !== `${record.questionId}::${record.partId}` : record.leafId !== record.questionId)) context.addIssue({code:'custom',message:'单题历史身份不一致'});
  if ((record.source === 'quick') !== (record.paperId === 'quick-practice')) context.addIssue({code:'custom',message:'单题历史来源不一致'});
  if (record.score != null && (record.points == null || record.score > record.points)) context.addIssue({code:'custom',message:'单题历史分值无效'});
  if (record.detail) {
    const q = record.detail.question;
    if (!isAnswerPresent(record.detail.answer) || q.type === 'group' || q.id !== record.leafId || (q.sourceQuestionId || q.id) !== record.questionId || q.partId !== record.partId) context.addIssue({code:'custom',message:'单题历史必须包含对应的实际作答与小题快照'});
    if (q.partId && (q.groupId !== record.questionId || q.groupTitle === undefined || q.groupStemMarkdown === undefined || q.partIndex === undefined)) context.addIssue({code:'custom',message:'单题历史缺少公共材料'});
    const state=answerState(q,record.detail.answer,true,record.points??undefined);
    const score=record.points==null?null:q.type==='short_answer'||q.type==='essay'?record.detail.answer.selfScore??null:state==='correct'?record.points:0;
    if (state !== record.verdict || score !== record.score) context.addIssue({code:'custom',message:'单题历史判定与答案不一致'});
  }
});
export type QuestionHistoryRecord = Omit<z.infer<typeof questionHistorySchema>, 'detail'> & { detail?: { question: StoredLeafQuestion; answer: z.infer<typeof answerSchema> } };
export const questionHistoryLimit = (store: Store) => store.get<any>('settings','system')?.maxQuestionHistory ?? DEFAULT_SETTINGS.maxQuestionHistory;

export function questionHistoryRetentionCandidates(store: Store, limit: number, roots?: string[]) {
  const db=store.database,field=db.expressions.field.bind(db.expressions);
  let query=db.query.selectFrom('question_history').select('id').select([field<string>('data','questionId').as('questionId'),field<string|null>('data','partId').as('partId'),field<string>('data','submittedAt').as('submittedAt')]).orderBy(field('data','submittedAt'),'desc').orderBy('id','desc');
  if(roots?.length)query=query.where(field<string>('data','questionId'),'in',roots);
  const counts=new Map<string,number>(),removed:string[]=[];
  for(const row of db.all(query)){
    const key=JSON.stringify([row.questionId,row.partId??null]),count=(counts.get(key)||0)+1;counts.set(key,count);
    if(count>limit)removed.push(row.id);
  }
  return removed;
}

export function trimQuestionHistory(store: Store,roots?:string[]) {
  for(const key of questionHistoryRetentionCandidates(store,questionHistoryLimit(store),roots))store.remove('question_history',key);
}

function fromAnswer(attempt: StoredAttempt, question: StoredLeafQuestion,scoring:PaperScoring=normalizeScoring(attempt.questions,attempt.scoring)): QuestionHistoryRecord {
  const answer=attempt.answers[question.id]!;
  const verdict=answerState(question,answer,true,scoring.enabled?scoring.questionPoints[question.id]:undefined) as QuestionHistoryRecord['verdict'];
  const score=scoring.enabled?(question.type==='short_answer'||question.type==='essay'?answer.selfScore??null:verdict==='correct'?scoring.questionPoints[question.id]!:0):null;
  return {id:historyRecordId(attempt.id,question.sourceQuestionId||question.id,question.id),questionId:question.sourceQuestionId||question.id,...(question.partId?{partId:question.partId}:{}),leafId:question.id,attemptId:attempt.id,source:attempt.source||'paper',paperId:attempt.paperId,paperTitle:attempt.paperTitle,paperVersion:attempt.paperVersion,submittedAt:attempt.submittedAt!,verdict,score,points:scoring.enabled?scoring.questionPoints[question.id]!:null};
}

/** A live whole attempt owns its answers once. The per-question view stores only
 * references, and only the rows selected by its independent retention policy. */
export function preserveQuestionHistory(store: Store, attempt: StoredAttempt, trim=true,allowCreate=true) {
  if(attempt.status!=='submitted')return;
  if(questionHistoryLimit(store)===0){if(trim)trimQuestionHistory(store);return;}
  const db=store.database,field=db.expressions.field.bind(db.expressions),scoring=normalizeScoring(attempt.questions,attempt.scoring);
  const wasReset=!!db.one(db.query.selectFrom('learning_results').select(field<number>('data','reset').as('reset')).where('id','=',attempt.id))?.reset;
  const previous=new Map(db.all(db.query.selectFrom('question_history').select('id').select(field<number>('data','beforeReset').as('beforeReset')).where(field('data','attemptId'),'=',attempt.id)).map(row=>[row.id,!!row.beforeReset]));
  for(const question of attempt.questions)if(isAnswerPresent(attempt.answers[question.id])){
    const record=fromAnswer(attempt,question,scoring);
    if(!allowCreate&&!previous.has(record.id))continue;
    store.put('question_history',record.id,{...record,...(previous.get(record.id)||wasReset?{beforeReset:true}:{})});
  }
  if(trim)trimQuestionHistory(store,[...new Set(attempt.questions.map(q=>q.sourceQuestionId||q.id))]);
}

/** Before pruning a whole attempt, promote only still-referenced recent leaves.
 * Their answers remain readable without retaining unrelated questions/answers. */
export function archiveAttemptQuestionHistory(store: Store, attempt: StoredAttempt) {
  if(attempt.status!=='submitted')return;
  const db=store.database,rows=db.all(db.query.selectFrom('question_history').select(['id','data']).where(db.expressions.field('data','attemptId'),'=',attempt.id));
  const byId=new Map(attempt.questions.map(question=>[question.id,question]));
  for(const row of rows){
    const record=JSON.parse(row.data) as QuestionHistoryRecord,question=byId.get(record.leafId)??fail(400,'QUESTION_HISTORY_REFERENCE_INVALID','单题历史引用的原题不存在'),answer=attempt.answers[record.leafId];
    if(!isAnswerPresent(answer))fail(400,'QUESTION_HISTORY_REFERENCE_INVALID','单题历史引用的原作答不存在');
    const {study:_study,partStudies:_parts,...snapshot}=question;
    store.put('question_history',record.id,{...record,detail:{question:snapshot,answer}});
  }
}

/** Upgrade/merge only recover details from actually retained attempts. Missing
 * old answers are never synthesized from a judgment or a reference answer. */
export function migrateQuestionHistory(store: Store, force=false,backfill=true) {
  const db=store.database;
  if(!force&&db.one(db.query.selectFrom('metadata').select('value').where('key','=','question_history_version'))?.value==='1')return 0;
  const rows=backfill?db.all(db.query.selectFrom('attempts').select('data').where(db.expressions.field('data','status'),'=','submitted')):[];
  for(const row of rows){
    const attempt=JSON.parse(row.data) as StoredAttempt;
    const saved=store.get<any>('learning_results',attempt.id);
    preserveQuestionHistory(store,attempt,false,!saved?.historyIndexed);
    if(saved&&!saved.reset){
      const scoring=normalizeScoring(attempt.questions,attempt.scoring),questions=new Map(attempt.questions.map(question=>[question.id,question]));
      saved.items=saved.items.map((item:any)=>{
        const answer=attempt.answers[item.id],answered=isAnswerPresent(answer),question=questions.get(item.id);
        const judgment=question&&answered&&item.judgment==='incorrect'?learningJudgment({...question,answerValue:answer?.value,selfScore:answer?.selfScore,verdict:answer?.verdict,scoringEnabled:scoring.enabled,maximumPoints:scoring.questionPoints[item.id]}):undefined;
        return {...item,answered,...(judgment?.verdict==='partial'?{judgment:'partial'}:{})};
      });saved.historyIndexed=true;
      store.put('learning_results',saved.id,saved);
    }
  }
  trimQuestionHistory(store);
  db.run(db.query.insertInto('metadata').values({key:'question_history_version',value:'1'}).onConflict(c=>c.column('key').doUpdateSet({value:'1'})));
  return rows.length||1;
}

export function validateQuestionHistory(store: Store, raw: unknown): QuestionHistoryRecord {
  const record=parse(questionHistorySchema,raw);
  const attempt=store.get<StoredAttempt>('attempts',record.attemptId);
  if(attempt){
    const q=attempt.questions.find(q=>q.id===record.leafId&&(q.sourceQuestionId||q.id)===record.questionId)??fail(400,'QUESTION_HISTORY_REFERENCE_INVALID','单题历史原题与作答不一致');
    if(attempt.status!=='submitted'||!isAnswerPresent(attempt.answers[record.leafId]))fail(400,'QUESTION_HISTORY_REFERENCE_INVALID','单题历史与原作答不一致');
    const expected=fromAnswer(attempt,q);
    if(['source','paperId','paperTitle','paperVersion','submittedAt','verdict','score','points'].some(key=>(record as any)[key]!== (expected as any)[key]))fail(400,'QUESTION_HISTORY_REFERENCE_INVALID','单题历史来源、结果或分值与原作答不一致');
  }else if(!record.detail)fail(400,'QUESTION_HISTORY_DETAIL_MISSING','原整卷已删除，单题历史必须携带独立完整作答');
  return record;
}
