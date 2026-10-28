import { PAGE_SIZES } from '../../../shared/utils/pagination';
import type { GlobalLearningKind } from '../../../shared/practice/global-learning';

export type LearningReaderScope='global'|'paper'|'quick'|'queue';
export type LearningReaderTab='wrong'|'favorite'|'review'|'drafts'|'history';
export interface LearningReaderContext {
 scope:LearningReaderScope;kind:GlobalLearningKind;page:number;pageSize:number;
 paperId?:string;activity?:boolean;tab?:LearningReaderTab;
 queueKind?:'all'|'overdue'|'relearning'|'today';domainId?:string;categoryId?:string;direction?:string;
}
const text=(value:unknown,max=1000)=>{if(typeof value!=='string')return'';let bounded=value.slice(0,max);if(/[\uD800-\uDBFF]$/.test(bounded))bounded=bounded.slice(0,-1);return new URLSearchParams({value:bounded}).get('value')!;};
const integer=(value:unknown,fallback:number)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0&&value<=1_000_000?value:fallback;
export function normalizeLearningContext(input:LearningReaderContext):LearningReaderContext{
 const scope=['global','paper','quick','queue'].includes(input.scope)?input.scope:'global';
 const value:LearningReaderContext={scope,kind:['wrong','favorite','due'].includes(input.kind)?input.kind:'wrong',page:integer(input.page,1),pageSize:PAGE_SIZES.includes(input.pageSize as typeof PAGE_SIZES[number])?input.pageSize:20};
 if(scope==='paper'){value.paperId=text(input.paperId);value.activity=!!input.activity;}
 if(scope==='paper'||scope==='quick')value.tab=['wrong','favorite','review','drafts','history'].includes(input.tab||'')?input.tab:'review';
 if(scope==='queue')Object.assign(value,{kind:'due',queueKind:['all','overdue','relearning','today'].includes(input.queueKind||'')?input.queueKind:'all',domainId:text(input.domainId,160),categoryId:text(input.categoryId,160),direction:['standard','word_to_meaning','meaning_to_word'].includes(input.direction||'')?input.direction:''});
 return value;
}
export function readLearningPagination(params:URLSearchParams,queue=false){
 const number=(key:string,fallback:number)=>{const all=params.getAll(key);return all.length===1&&/^\d+$/.test(all[0])?Number(all[0]):fallback;};
 const prefix=queue?'queue':'learning';
 const page=integer(number(prefix+'Page',1),1),size=number(prefix+'PageSize',queue?10:20);
 return{page,pageSize:PAGE_SIZES.includes(size as typeof PAGE_SIZES[number])?size:queue?10:20};
}
export function learningListHref(input:LearningReaderContext):string{
 const value=normalizeLearningContext(input),params=new URLSearchParams();let path='';
 if(value.scope==='global')path='#/learning/'+value.kind;
 else if(value.scope==='queue')path='#/learning/due';
 else{path=value.scope==='quick'?'#/quick':`#/papers/${encodeURIComponent(value.paperId!)}${value.activity?'/activity':''}`;params.set('tab',value.tab!);if(value.tab==='review'&&value.kind==='favorite')params.set('reviewKind','favorite');}
 const prefix=value.scope==='queue'?'queue':'learning',defaultSize=value.scope==='queue'?10:20;
 if(value.page!==1)params.set(prefix+'Page',String(value.page));if(value.pageSize!==defaultSize)params.set(prefix+'PageSize',String(value.pageSize));
 if(value.scope==='queue'){if(value.queueKind!=='all')params.set('queueKind',value.queueKind!);for(const key of ['domainId','categoryId','direction']as const)if(value[key])params.set('queue'+key[0].toUpperCase()+key.slice(1),value[key]!);}
 return path+(params.size?'?'+params:'');
}
export function learningReaderHref(input:LearningReaderContext,itemKey:string):string{
 const value=normalizeLearningContext(input),params=new URLSearchParams({scope:value.scope,kind:value.kind,item:text(itemKey,3000),page:String(value.page),pageSize:String(value.pageSize)});
 if(value.scope==='paper'){params.set('paperId',value.paperId!);if(value.activity)params.set('activity','1');}
 if(value.tab)params.set('tab',value.tab);
 if(value.scope==='queue')for(const key of ['queueKind','domainId','categoryId','direction']as const)if(value[key])params.set(key,value[key]!);
 return '#/learning-reader?'+params;
}
export function readLearningReader(params:URLSearchParams):{context:LearningReaderContext;itemKey:string}|null{
 const one=(key:string)=>params.getAll(key).length===1?params.get(key)||'':'';
 const scope=one('scope') as LearningReaderScope;if(!['global','paper','quick','queue'].includes(scope)||!one('item')||scope==='paper'&&!one('paperId'))return null;
 const number=(key:string)=>/^\d+$/.test(one(key))?Number(one(key)):undefined;
 const context=normalizeLearningContext({scope,kind:one('kind') as GlobalLearningKind,page:number('page')||1,pageSize:number('pageSize')||20,paperId:one('paperId'),activity:one('activity')==='1',tab:one('tab') as LearningReaderTab,queueKind:one('queueKind') as LearningReaderContext['queueKind'],domainId:one('domainId'),categoryId:one('categoryId'),direction:one('direction')});
 return{context,itemKey:text(one('item'),3000)};
}
export function learningQuestionsUrl(context:LearningReaderContext,page=context.page):string{
 const params=new URLSearchParams({page:String(page),pageSize:String(context.pageSize)});
 if(context.scope==='global'){params.set('kind',context.kind);return'/api/learning/global/questions?'+params;}
 if(context.scope==='queue'){params.set('kind',context.queueKind||'all');for(const key of ['domainId','categoryId','direction']as const)if(context[key])params.set(key,context[key]!);return'/api/review-scheduler/queue?'+params;}
 params.set('kind',context.kind);params.set('source',context.scope==='paper'?'paper':'quick');if(context.scope==='paper')params.set('paperId',context.paperId!);return'/api/learning/questions?'+params;
}
