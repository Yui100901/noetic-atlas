import {PAGE_SIZES} from '../../../shared/utils/pagination';

export interface PaperListContext {search:string;organization:string;showArchived:boolean;page:number;pageSize:number}
const storageKey='noetic-atlas:paper-list-view';
const bounded=(value:unknown,max:number)=>{if(typeof value!=='string')return'';let text=value.slice(0,max);if(/[\uD800-\uDBFF]$/.test(text))text=text.slice(0,-1);return new URLSearchParams({value:text}).get('value')!;};
export function normalizePaperListContext(value:Partial<PaperListContext>={}):PaperListContext{
 const organization=bounded(value.organization,167);
 return{search:bounded(value.search,1000),organization:['all','domain','other'].includes(organization)||/^domain:[\p{L}\p{N}_.:-]{1,160}$/u.test(organization)?organization:'all',showArchived:value.showArchived===true,page:Number.isSafeInteger(value.page)&&value.page!>=1&&value.page!<=1_000_000?value.page!:1,pageSize:PAGE_SIZES.includes(value.pageSize as typeof PAGE_SIZES[number])?value.pageSize!:20};
}
export function readPaperListContext(hash:string):PaperListContext{
 const params=new URLSearchParams(hash.split('?')[1]),one=(key:string)=>params.getAll(key).length===1?params.get(key)||'':'';
 return normalizePaperListContext({search:one('search'),organization:one('organization'),showArchived:one('archived')==='1',page:/^\d+$/.test(one('page'))?Number(one('page')):1,pageSize:/^\d+$/.test(one('pageSize'))?Number(one('pageSize')):20});
}
export function paperListHref(input:Partial<PaperListContext>={}):string{
 const value=normalizePaperListContext(input),params=new URLSearchParams();
 if(value.search)params.set('search',value.search);if(value.organization!=='all')params.set('organization',value.organization);if(value.showArchived)params.set('archived','1');if(value.page!==1)params.set('page',String(value.page));if(value.pageSize!==20)params.set('pageSize',String(value.pageSize));
 return'#/papers'+(params.size?'?'+params:'');
}
/** Returning through the common #/papers back links restores this tab's last
 * list. Explicit list URLs remain shareable and override the session view. */
export function initialPaperListContext():PaperListContext{
 const hash=window.location.hash;
 if(hash.includes('?'))return readPaperListContext(hash);
 try{const saved=sessionStorage.getItem(storageKey);if(saved?.startsWith('#/papers?'))return readPaperListContext(saved);}catch{/* Private mode may deny session storage; the current URL still works. */}
 return normalizePaperListContext();
}
export function rememberPaperList(input:PaperListContext){
 const url=paperListHref(input);history.replaceState(history.state,'',url);
 try{sessionStorage.setItem(storageKey,url);}catch{/* URL persistence remains available. */}
}
