import type {AnalyticsBreakdown,AnalyticsMetrics,AnalyticsReport,WeeklyReport} from '../../../shared/models/analytics.js';
import {typeLabels,type QuestionType} from '../../../shared/models/types.js';
import type {Store} from '../../core/store.js';
import {fail} from '../../core/validation.js';
import {getSettings} from '../settings/service.js';
import {learningQuestionKey} from '../practice/learning-state.js';
import {addDays,calendar,daysBetween,monday,validateRange} from './calendar.js';

interface Item {
  id:string;sourceQuestionId?:string|null;partId?:string|null;answered?:boolean|number;
  judgment?:string;type?:QuestionType|null;categoryIds?:string[]|null;
  tagIds?:string[]|null;difficulty?:number|null;selfScore?:number|null;verdict?:string|null;points?:number|null;
}
interface Session {
  id:string;source:string|null;submittedAt:string;elapsedSeconds:number|null;reset?:boolean|number|null;items:Item[];
}
interface Activity {sessions:Session[];reviews:string[];resetExcludedSessions:number;}
const identity=(item:Item)=>learningQuestionKey(item.sourceQuestionId||item.id,item.id);
/** Brackets cannot occur in a validated domain ID. */
const UNCLASSIFIED='[unclassified]';
const round=(value:number)=>Math.round((value+Number.EPSILON)*100)/100;
const knownDuration=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;

/** Date strings with offsets need an exact instant comparison. A broad indexed
 * ISO-date prefilter bounds parsing without assuming every backup used Z. */
function readActivity(store:Store,from:number,until:number):Activity {
  const db=store.database,field=db.expressions.field.bind(db.expressions);
  const lower=addDays(new Date(from).toISOString().slice(0,10),-2)+'T',upper=addDays(new Date(until).toISOString().slice(0,10),2)+'T';
  const inWindow=(value:string)=>{const time=Date.parse(value);return Number.isFinite(time)&&time>=from&&time<until;};
  const common=[field<string|null>('data','source').as('source'),field<string>('data','submittedAt').as('submittedAt'),field<number|null>('data','elapsedSeconds').as('elapsedSeconds')];
  const saved=db.all(db.query.selectFrom('learning_results').select('id').select(common).select([field<string>('data','items').as('items'),field<boolean|null>('data','reset').as('reset')]).where(field('data','submittedAt'),'>=',lower).where(field('data','submittedAt'),'<',upper)).filter(row=>inWindow(row.submittedAt));
  const retained=db.all(db.query.selectFrom('attempts').select('id').select(common).select(db.expressions.attemptAnalyticsItems('data').as('items')).where(field('data','status'),'=','submitted').where(field('data','submittedAt'),'>=',lower).where(field('data','submittedAt'),'<',upper)).filter(row=>inWindow(row.submittedAt));
  const byId=new Map(retained.map(row=>[row.id,{...row,items:JSON.parse(row.items) as Item[]}]));
  const selected=new Map<string,Session>(),resetIds=new Set(saved.filter(row=>row.reset).map(row=>row.id));
  // The independently retained single-question history can confirm a legacy
  // answer/grade when the original compact record omitted presence metadata.
  const needsHistory=[...new Set([...saved.filter(row=>!row.reset).map(row=>row.id),...retained.map(row=>row.id)])];
  const history=needsHistory.length?db.all(db.query.selectFrom('question_history').select([
    field<string>('data','attemptId').as('attemptId'),field<string>('data','leafId').as('leafId'),field<string>('data','questionId').as('questionId'),field<string>('data','verdict').as('verdict'),field<boolean|null>('data','beforeReset').as('beforeReset'),
  ]).where(db.expressions.valueInJson(field<string>('data','attemptId'),needsHistory))):[];
  const historyById=new Map<string,Map<string,string>>();
  for(const row of history){if(row.beforeReset||resetIds.has(row.attemptId))continue;const entries=historyById.get(row.attemptId)||new Map<string,string>();entries.set(learningQuestionKey(row.questionId,row.leafId),row.verdict);historyById.set(row.attemptId,entries);}
  const enriched=(id:string,items:Item[],fallback:Item[])=>{
    const byLeaf=new Map(fallback.map(item=>[identity(item),item]));
    return items.map(item=>{const previous=byLeaf.get(identity(item));const record={...previous,...item};
      for(const key of ['type','categoryIds','tagIds','difficulty','answered'] as const)if(item[key]===undefined||item[key]===null)(record as any)[key]=previous?.[key];
      const historyVerdict=historyById.get(id)?.get(identity(item));
      if(record.answered===undefined&&historyVerdict)record.answered=true;
      if(record.judgment===undefined){
        if(historyVerdict&&historyVerdict!=='ungraded')record.judgment=historyVerdict;
        else if(record.verdict)record.judgment=record.verdict;
        else if(record.selfScore!=null&&record.points!=null)record.judgment=record.selfScore>=record.points?'correct':record.selfScore>0?'partial':'incorrect';
      }
      return record;
    });
  };
  for(const row of saved){if(row.reset)continue;const fallback=byId.get(row.id);selected.set(row.id,{...row,elapsedSeconds:knownDuration(row.elapsedSeconds)?row.elapsedSeconds:fallback?.elapsedSeconds??null,items:enriched(row.id,JSON.parse(row.items) as Item[],fallback?.items||[])});}
  for(const row of byId.values())if(!selected.has(row.id)&&!resetIds.has(row.id))selected.set(row.id,{...row,items:enriched(row.id,row.items,[])});
  const reviews=db.all(db.query.selectFrom('reviews').select(field<string>('data','reviewedAt').as('reviewedAt')).where(field('data','reviewedAt'),'>=',lower).where(field('data','reviewedAt'),'<',upper)).map(row=>row.reviewedAt).filter(inWindow);
  return {sessions:[...selected.values()],reviews,resetExcludedSessions:resetIds.size};
}

export function emptyMetrics():AnalyticsMetrics{return {sessions:0,answeredSessions:0,paperSessions:0,quickSessions:0,answers:0,uniqueItems:0,uniqueQuestions:0,correct:0,partial:0,incorrect:0,ungraded:0,omitted:0,unknown:0,graded:0,accuracy:null,elapsedSeconds:0,timedSessions:0,missingTimeSessions:0,reviewEvents:0,activeDays:0};}
class Accumulator {
  metrics=emptyMetrics();leaves=new Set<string>();roots=new Set<string>();days=new Set<string>();
  answer(item:Item,date:string){const m=this.metrics;m.answers++;this.leaves.add(identity(item));this.roots.add(item.sourceQuestionId||item.id);this.days.add(date);if(item.judgment==='correct')m.correct++;else if(item.judgment==='partial')m.partial++;else if(item.judgment==='incorrect')m.incorrect++;else m.ungraded++;}
  session(session:Session,date:string){const m=this.metrics;m.sessions++;if(session.source==='quick')m.quickSessions++;else m.paperSessions++;let answered=0;const seen=new Set<string>();
    for(const item of session.items){const key=identity(item);if(seen.has(key))continue;seen.add(key);if(item.answered===true||item.answered===1){this.answer(item,date);answered++;}else if(item.answered===false||item.answered===0)m.omitted++;else m.unknown++;}
    if(answered){m.answeredSessions++;if(knownDuration(session.elapsedSeconds)){m.elapsedSeconds+=session.elapsedSeconds;m.timedSessions++;}else m.missingTimeSessions++;}
  }
  review(date:string){this.metrics.reviewEvents++;this.days.add(date);}
  finish(){const m=this.metrics;return {...m,uniqueItems:this.leaves.size,uniqueQuestions:this.roots.size,graded:m.correct+m.partial+m.incorrect,accuracy:m.correct+m.partial+m.incorrect?round(m.correct/(m.correct+m.partial+m.incorrect)*100):null,activeDays:this.days.size};}
}
function breakdown(id:string,label:string,acc:Accumulator):AnalyticsBreakdown{const m=acc.finish();return {id,label,answers:m.answers,uniqueItems:m.uniqueItems,correct:m.correct,partial:m.partial,incorrect:m.incorrect,ungraded:m.ungraded,graded:m.graded,accuracy:m.accuracy};}

function report(store:Store,range:{from:string;to:string;timeZone:string},now:Date,untilOverride?:number):AnalyticsReport {
  validateRange(range.from,range.to);const clock=calendar(range.timeZone),today=clock.date(now);
  const start=clock.start(range.from),end=clock.start(addDays(range.to,1)),until=Math.min(end,now.getTime()+1,untilOverride??Infinity);
  const activity=readActivity(store,start,Math.max(start,until)),total=new Accumulator();
  const daily=new Map<string,Accumulator>();for(let date=range.from;date<=range.to;date=addDays(date,1))daily.set(date,new Accumulator());
  const db=store.database,field=db.expressions.field.bind(db.expressions);
  const domains=new Map(db.all(db.query.selectFrom('domains').select('id').select(field<string>('data','name').as('name'))).map(row=>[row.id,row.name]));
  const categoryDomains=new Map(db.all(db.query.selectFrom('categories').select('id').select(field<string>('data','domainId').as('domainId'))).map(row=>[row.id,row.domainId]));
  const typeBuckets=new Map<string,Accumulator>(),domainBuckets=new Map<string,Accumulator>();
  const quality={unknownAnswerItems:0,missingTypeAnswers:0,missingDomainAnswers:0,missingDurationSessions:0,resetExcludedSessions:activity.resetExcludedSessions,warnings:[] as string[]};let overlapping=false;
  for(const session of activity.sessions){const date=clock.date(Date.parse(session.submittedAt));total.session(session,date);daily.get(date)?.session(session,date);const seen=new Set<string>();
    for(const item of session.items){const key=identity(item);if(seen.has(key))continue;seen.add(key);if(item.answered!==true&&item.answered!==1)continue;
      const type=item.type&&item.type!=='group'?item.type:'unknown';if(type==='unknown')quality.missingTypeAnswers++;
      const typeBucket=typeBuckets.get(type)||new Accumulator();typeBucket.answer(item,date);typeBuckets.set(type,typeBucket);
      const ids=[...new Set((item.categoryIds||[]).flatMap(category=>{const domain=categoryDomains.get(category);return domain&&domains.has(domain)?[domain]:[];}))];
      if(!ids.length){ids.push(UNCLASSIFIED);quality.missingDomainAnswers++;}if(ids.length>1)overlapping=true;
      for(const id of ids){const bucket=domainBuckets.get(id)||new Accumulator();bucket.answer(item,date);domainBuckets.set(id,bucket);}
    }
  }
  for(const stamp of activity.reviews){const date=clock.date(Date.parse(stamp));total.review(date);daily.get(date)?.review(date);}
  const summary=total.finish();quality.unknownAnswerItems=summary.unknown;quality.missingDurationSessions=summary.missingTimeSessions;
  if(summary.unknown)quality.warnings.push(`${summary.unknown}个旧作答项无法确认是否填写，未计入作答次数与正确率。`);
  if(summary.missingTimeSessions)quality.warnings.push(`${summary.missingTimeSessions}次实际作答缺少可靠耗时，未计入累计作答耗时。`);
  if(quality.missingTypeAnswers)quality.warnings.push(`${quality.missingTypeAnswers}次作答缺少题型快照，归入未知题型。`);
  if(quality.missingDomainAnswers)quality.warnings.push(`${quality.missingDomainAnswers}次作答未分类或原领域已删除，单列显示。`);
  if(quality.resetExcludedSessions)quality.warnings.push(`${quality.resetExcludedSessions}次作答已重置学习进度，不再计入学习统计。`);
  if(overlapping)quality.warnings.push('同一题可属于多个领域，各领域作答次数可能重叠，不能相加作为总次数。');
  const types=[...typeBuckets].map(([id,bucket])=>breakdown(id,id==='unknown'?'未知题型':typeLabels[id as QuestionType],bucket)).sort((a,b)=>b.answers-a.answers||a.id.localeCompare(b.id));
  const domainRows=[...domainBuckets].map(([id,bucket])=>breakdown(id,domains.get(id)||'未分类或领域已删除',bucket)).sort((a,b)=>b.answers-a.answers||a.id.localeCompare(b.id));
  const recommendations:AnalyticsReport['recommendations']=[];
  if(!summary.answers&&!summary.reviewEvents)recommendations.push({id:'start',title:'从一次小练习开始',description:'当前范围尚无实际作答或复习记录。选择一个题集，先完成少量题目。',href:'#/papers'});
  if(summary.ungraded)recommendations.push({id:'grade',title:'核对尚未判定的回答',description:`${summary.ungraded}次实际回答尚未判定，暂不参与正确率。核对后再判断掌握情况。`,href:'#/papers'});
  for(const weak of domainRows.filter(row=>row.id!==UNCLASSIFIED&&row.graded>=3&&row.accuracy!==null&&row.accuracy<70).sort((a,b)=>a.accuracy!-b.accuracy!).slice(0,2))recommendations.push({id:'domain-'+weak.id,title:`优先巩固${weak.label}`,description:`样本${weak.graded}次已判作答，完全正确率${weak.accuracy}%；其中部分正确${weak.partial}次、错误${weak.incorrect}次。先复盘原因，再少量重练。`,href:'#/questions?domainId='+encodeURIComponent(weak.id)});
  if(summary.answers&&summary.reviewEvents===0)recommendations.push({id:'review',title:'留一次复习时间',description:'本时段有作答但没有记录复习动作，可从到期题目中挑选少量回顾。',href:'#/questions?due=true'});
  if(summary.answers&&summary.activeDays<Math.min(3,Math.max(1,daysBetween(range.from,range.to)+1)))recommendations.push({id:'rhythm',title:'把练习分散到几天',description:`本时段记录到${summary.activeDays}个活跃日。可安排短时练习与回顾，逐步形成自己的节奏。`,href:'#/papers'});
  if(!recommendations.length)recommendations.push({id:'steady',title:'继续保持当前节奏',description:'结合错题原因与到期复习安排下一步；作答次数和耗时只描述活动量，不直接代表掌握程度。',href:'#/papers'});
  return {range:{...range,asOf:now.toISOString(),partial:range.to>=today},summary,daily:[...daily].map(([date,acc])=>({date,metrics:acc.finish()})),domains:domainRows,types,recommendations,quality};
}

export function learningAnalytics(store:Store,query:{from?:string;to?:string;timeZone?:string}={},now=new Date()):AnalyticsReport {
  const timeZone=query.timeZone||getSettings(store).dailyPush.timeZone,today=calendar(timeZone).date(now),to=query.to||today,from=query.from||addDays(to,-29);
  if(from>today||to>today)fail(400,'ANALYTICS_FUTURE_RANGE','统计日期不能晚于今天');
  return report(store,{from,to,timeZone},now);
}
export function weeklyReport(store:Store,query:{week?:string;timeZone?:string}={},now=new Date()):WeeklyReport {
  const timeZone=query.timeZone||getSettings(store).dailyPush.timeZone,clock=calendar(timeZone),today=clock.date(now),weekStart=monday(query.week||today),weekEnd=addDays(weekStart,6),isCurrentWeek=weekStart===monday(today);
  if(weekStart>today)fail(400,'ANALYTICS_FUTURE_WEEK','不能生成未来一周的学习周报');
  const current=report(store,{from:weekStart,to:weekEnd,timeZone},now),previousStart=addDays(weekStart,-7),previousEnd=addDays(weekStart,-1);
  const elapsed=now.getTime()+1-clock.start(weekStart),matchedUntil=isCurrentWeek?clock.start(previousStart)+elapsed:undefined;
  const previous=report(store,{from:previousStart,to:previousEnd,timeZone},now,matchedUntil),a=current.summary,b=previous.summary;
  return {weekStart,weekEnd,timeZone,generatedAt:now.toISOString(),isCurrentWeek,current,comparison:{mode:isCurrentWeek?'matched_elapsed':'full_week',from:previousStart,to:previousEnd,label:isCurrentWeek?'上周同期':'上周整周',summary:b,deltas:{answers:a.answers-b.answers,sessions:a.sessions-b.sessions,elapsedSeconds:a.elapsedSeconds-b.elapsedSeconds,activeDays:a.activeDays-b.activeDays,accuracyPoints:a.accuracy===null||b.accuracy===null?null:round(a.accuracy-b.accuracy)}}};
}
