import {PAGE_SIZES} from '../../../shared/utils/pagination';

export interface DocumentListLocation{search:string;collection:string;kind:string;domainId:string;categoryId:string;tagId:string;format:string;page:number;pageSize:number}
const defaults:DocumentListLocation={search:'',collection:'',kind:'',domainId:'',categoryId:'',tagId:'',format:'',page:1,pageSize:20};
const identifier=/^[\p{L}\p{N}_.:-]{1,160}$/u;
const bounded=(value:string,maximum:number)=>value.slice(0,maximum).replace(/[\uD800-\uDBFF]$/,'');
export function readDocumentListLocation(hash:string):DocumentListLocation{
 const state={...defaults};if(hash.split('?')[0]!=='#/documents')return state;
 const params=new URLSearchParams(hash.split('?')[1]||'');
 state.search=bounded(params.get('search')||'',500);state.kind=bounded(params.get('kind')||'',300);
 for(const key of ['domainId','categoryId','tagId'] as const){const value=params.get(key)||'';state[key]=identifier.test(value)?value:'';}
 const collection=params.get('collection')||'',format=params.get('format')||'';
 if(['general','personal'].includes(collection))state.collection=collection;
 if(['markdown','pdf'].includes(format))state.format=format;
 const page=Number(params.get('page')||1),size=Number(params.get('pageSize')||20);
 state.page=Number.isSafeInteger(page)&&page>0&&page<=1_000_000?page:1;state.pageSize=(PAGE_SIZES as readonly number[]).includes(size)?size:20;
 return state;
}
export function documentListLocation(state:DocumentListLocation):string{
 const params=new URLSearchParams();for(const key of ['search','collection','kind','domainId','categoryId','tagId','format'] as const)if(state[key])params.set(key,state[key]);
 if(state.page!==1)params.set('page',String(state.page));if(state.pageSize!==20)params.set('pageSize',String(state.pageSize));
 return '#/documents'+(params.size?'?'+params:'');
}
export function safeDocumentReturn(value:string|null|undefined):string{
 if(!value||value.length>20000||value.split('?')[0]!=='#/documents')return '#/documents';
 return documentListLocation(readDocumentListLocation(value));
}
export const documentReturnFromHash=(hash:string)=>safeDocumentReturn(new URLSearchParams(hash.split('?')[1]||'').get('returnTo'));
export function documentHref(id:string,returnTo='#/documents',edit=false):string{
 const back=safeDocumentReturn(returnTo);return '#/documents/'+encodeURIComponent(id)+(edit?'/edit':'')+(back==='#/documents'?'':'?returnTo='+encodeURIComponent(back));
}
