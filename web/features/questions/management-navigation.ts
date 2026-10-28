import { PAGE_SIZES } from '../../../shared/utils/pagination';
import { isRetiredQualityRule, QUALITY_RULE_LABELS } from '../../../shared/models/content-quality';

export type ManagementKind = 'review' | 'quality';
interface ManagementPageState { search:string; domainId:string; page:number; pageSize:number }
export interface ReviewManagementLocation extends ManagementPageState { kind:'review' }
export interface QualityManagementLocation extends ManagementPageState {
  kind:'quality'; status:string; origin:string; severity:string; rule:string; questionId:string; scanId:string;
}
export type ManagementLocation = ReviewManagementLocation | QualityManagementLocation;
export interface ManagementContext { kind:ManagementKind; returnTo:string; label:'审核管理'|'质量管理'; issueId?:string }

const paths = {review:'#/questions/review',quality:'#/content-quality'} as const;
const identifier = (value:string | null | undefined) => value && /^[\p{L}\p{N}_.:-]{1,160}$/u.test(value) && !['__proto__','prototype','constructor'].includes(value) ? value : '';
const bounded = (value:string,max:number) => { const result=value.slice(0,max);return /[\uD800-\uDBFF]$/.test(result)?result.slice(0,-1):result; };
const split = (hash:string) => { const index=hash.indexOf('?');return index<0?[hash,'']:[hash.slice(0,index),hash.slice(index+1)]; };
const choice = (value:string | null,values:readonly string[],fallback='') => value && values.includes(value)?value:fallback;

/** Only the two management lists are accepted. Unknown and nested redirect
 * parameters are discarded, so an editor never inherits an arbitrary target. */
export function readManagementLocation(hash:string):ManagementLocation | null {
  if(hash.length>20000)return null;
  const [path,query]=split(hash),kind=path===paths.review?'review':path===paths.quality?'quality':null;
  if(!kind)return null;
  const params=new URLSearchParams(query),page=Number(params.get('page')||1),pageSize=Number(params.get('pageSize')||20);
  const common={search:bounded(params.get('search')||'',kind==='quality'?200:500),domainId:identifier(params.get('domainId')),page:Number.isSafeInteger(page)&&page>0&&page<=1_000_000?page:1,pageSize:(PAGE_SIZES as readonly number[]).includes(pageSize)?pageSize:20};
  if(kind==='review')return{kind,...common};
  const rule=params.get('rule')||'';
  return{kind,...common,status:choice(params.get('status'),['active','all','open','confirmed','resolved','dismissed','stale'],'active'),origin:choice(params.get('origin'),['all','scan','feedback'],'all'),severity:choice(params.get('severity'),['error','warning','notice']),rule:Object.hasOwn(QUALITY_RULE_LABELS,rule)&&!isRetiredQualityRule(rule)?rule:'',questionId:identifier(params.get('questionId')),scanId:identifier(params.get('scanId'))};
}

export function managementLocation(kind:ManagementKind,state:Partial<Omit<QualityManagementLocation,'kind'>>={}):string {
  const params=new URLSearchParams();
  for(const key of ['search','domainId','status','origin','severity','rule','questionId','scanId','page','pageSize'] as const){
    if(kind==='review'&&['status','origin','severity','rule','questionId','scanId'].includes(key))continue;
    const value=state[key];if(value!==undefined&&value!==''){
      const text=String(value),clean=key==='search'?bounded(text,kind==='quality'?200:500):['domainId','questionId','scanId'].includes(key)?identifier(text):bounded(text,200);
      if(clean)params.set(key,clean);
    }
  }
  const normalized=readManagementLocation(paths[kind]+'?'+params)!;
  const clean=new URLSearchParams();
  if(normalized.search)clean.set('search',normalized.search);
  if(normalized.domainId)clean.set('domainId',normalized.domainId);
  if(normalized.kind==='quality'){
    if(normalized.status!=='active')clean.set('status',normalized.status);
    if(normalized.origin!=='all')clean.set('origin',normalized.origin);
    for(const key of ['severity','rule','questionId','scanId'] as const)if(normalized[key])clean.set(key,normalized[key]);
  }
  if(normalized.page!==1)clean.set('page',String(normalized.page));
  if(normalized.pageSize!==20)clean.set('pageSize',String(normalized.pageSize));
  return paths[kind]+(clean.size?'?'+clean:'');
}

export function safeManagementReturn(value:string | null | undefined):string | null {
  if(!value)return null;
  const location=readManagementLocation(value);return location?managementLocation(location.kind,location):null;
}

export function readManagementContext(hash:string):ManagementContext | null {
  if(hash.length>24000)return null;
  const params=new URLSearchParams(split(hash)[1]),returnTo=safeManagementReturn(params.get('returnTo'));
  if(!returnTo)return null;
  const location=readManagementLocation(returnTo)!,issueId=location.kind==='quality'?identifier(params.get('qualityIssueId')):'';
  return{kind:location.kind,returnTo,label:location.kind==='review'?'审核管理':'质量管理',...(issueId?{issueId}:{})};
}

export function managementEditorHref(questionId:string,returnTo:string,issueId?:string):string {
  const back=safeManagementReturn(returnTo)||paths.quality,params=new URLSearchParams({returnTo:back});
  if(readManagementLocation(back)?.kind==='quality'&&identifier(issueId))params.set('qualityIssueId',issueId!);
  return `#/questions/${encodeURIComponent(questionId)}/edit?${params}`;
}
