import {useEffect,useRef,useState} from 'react';
import type {Paged} from '../../../shared/utils/pagination';
import {qs,request} from '../../shared/lib/api';
import {Modal} from '../../shared/ui/components';
import {unchangedActiveQualityIssues,type QualitySaveState} from './question-quality-save-policy';

async function readQualityStates(questionId:string,signal?:AbortSignal):Promise<QualitySaveState[]>{
  const result=new Map<string,QualitySaveState>();let page=1,total=0;
  do{
    const batch=await request<Paged<QualitySaveState>>(`/api/content-quality/issues?${qs({questionId,status:'all',page,pageSize:100})}`,{signal});
    total=batch.total;for(const issue of batch.items)result.set(issue.id,{id:issue.id,status:issue.status,rule:issue.rule});
    if(!batch.items.length&&result.size<total)throw Error('质量问题列表在检查期间发生变化，请重新保存以核对最新状态。');
    page++;
  }while((page-1)*100<total);
  if(result.size<total)throw Error('质量问题列表在检查期间发生变化，请重新保存以核对最新状态。');
  return [...result.values()];
}

/** The dialog authorizes one captured save attempt. It never resolves an issue
 * and never saves when dismissed; question writes keep their normal version. */
export function useQualitySaveConfirm(questionId?:string){
  const [count,setCount]=useState<number|null>(null);
  const baseline=useRef<Promise<QualitySaveState[]|null>>(Promise.resolve(null));
  const checked=useRef<QualitySaveState[]|null>(null),choose=useRef<((value:boolean|null)=>void)|null>(null),epoch=useRef(0);
  useEffect(()=>{
    const controller=new AbortController();const current=++epoch.current;
    checked.current=null;
    baseline.current=questionId?readQualityStates(questionId,controller.signal).catch(()=>null):Promise.resolve([]);
    return()=>{controller.abort();if(epoch.current===current)epoch.current++;choose.current?.(null);choose.current=null;};
  },[questionId]);
  function finish(value:boolean|null){const resolve=choose.current;choose.current=null;setCount(null);resolve?.(value);}
  async function beforeSave(dirty:boolean,keepEditing:boolean):Promise<boolean|null>{
    if(!questionId||!dirty)return keepEditing;
    const current=epoch.current,original=await baseline.current;
    let latest:QualitySaveState[];
    try{latest=await readQualityStates(questionId);}catch(reason){throw Error(`未能核对质量问题，题目尚未保存：${(reason as Error).message}`);}
    if(epoch.current!==current)return null;
    checked.current=latest;
    const outstanding=unchangedActiveQualityIssues(original||[],latest);
    if(!outstanding.length)return keepEditing;
    if(choose.current)return null;
    return new Promise<boolean|null>(resolve=>{choose.current=resolve;setCount(outstanding.length);});
  }
  function saved(){if(checked.current)baseline.current=Promise.resolve(checked.current);}
  const dialog=count===null?null:<Modal title="保存前核对质量问题" onClose={()=>finish(null)}><div className="form-stack">
    <p>原题已修改，还有<strong>{count}项</strong>质量问题未变更处理状态。保存原题不会自动将这些问题标为已解决。</p>
    <p className="muted">可先保存并留在编辑页，重新检查本题后更新质量问题状态；也可保留当前状态直接保存。</p>
    <div className="form-actions"><button type="button" className="button" onClick={()=>finish(null)}>返回编辑</button><button type="button" className="button" onClick={()=>finish(false)}>保留状态并保存</button><button type="button" className="button primary" onClick={()=>finish(true)}>保存并继续处理</button></div>
  </div></Modal>;
  return{beforeSave,saved,dialog};
}
