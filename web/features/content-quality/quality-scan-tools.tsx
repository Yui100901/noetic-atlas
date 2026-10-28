import {useEffect,useRef,useState} from 'react';
import {Pause,Play,ShieldCheck} from 'lucide-react';
import type {Paged} from '../../../shared/utils/pagination';
import {typeLabels} from '../../../shared/models/types';
import type {QualityFilters,QualityScan} from '../../../shared/models/content-quality';
import {idPath,localDate,qs,request,send,useResource} from '../../shared/lib/api';
import {CategoryOptions,ErrorNotice,Field,Loading,MultiSelect,Pagination,useApp} from '../../shared/ui/components';

const base='/api/content-quality';
const labels={ready:'可以继续',completed:'已完成规则检查',cancelled:'已取消',failed:'本批失败，可重试'};

export function QualityScanTools({latestScan,ruleVersion,onChanged,disabled}:{latestScan:QualityScan|null;ruleVersion:string;onChanged:()=>void;disabled:boolean}){
  const {bootstrap}=useApp();
  const [filters,setFilters]=useState<QualityFilters>({tagIds:[],status:'all'}),[run,setRun]=useState<QualityScan|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const [page,setPage]=useState(1),[pageSize,setPageSize]=useState(10);
  const scans=useResource<Paged<QualityScan>>(`${base}/scans?${qs({page,pageSize})}`);
  const stopped=useRef(false),mounted=useRef(true),locked=useRef(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;stopped.current=true;};},[]);
  const current=run||latestScan,blocked=busy||disabled;
  async function process(initial:QualityScan){
    stopped.current=false;let value=initial;
    try{
      while(!stopped.current&&['ready','failed'].includes(value.status)){
        value=await send<QualityScan>(`${base}/scans/${idPath(value.id)}/process`,'POST',{batchSize:100});
        if(!mounted.current)return;setRun(value);await new Promise<void>(resolve=>setTimeout(resolve,0));
      }
      if(mounted.current)setMessage(value.status==='completed'?`规则检查完成，共检查${value.processed.toLocaleString()}题，发现${value.findings.toLocaleString()}项，新增${value.newIssues.toLocaleString()}项。`:'已暂停，当前批次已保存。');
    }catch(reason){if(mounted.current){setError((reason as Error).message);try{setRun(await request<QualityScan>(`${base}/scans/${idPath(value.id)}`));}catch{/* Retain the first failure. */}}}
    finally{if(mounted.current){scans.refresh();onChanged();}}
  }
  async function operate(action:()=>Promise<void>){if(locked.current)return;locked.current=true;setBusy(true);setError('');setMessage('');try{await action();}catch(reason){if(mounted.current)setError((reason as Error).message);}finally{locked.current=false;if(mounted.current)setBusy(false);}}
  return <section className="form-stack" aria-label="扫描设置">
    <div className="list-toolbar"><h2>规则扫描</h2><span className="badge">规则 {ruleVersion||'…'}</span></div>
    <p className="muted">留空检查整个题库；每批100题，离开后在当前批次完成时暂停。</p>
    <div className="quality-filters"><Field label="扫描领域"><select value={filters.domainId||''} disabled={blocked} onChange={event=>setFilters({...filters,domainId:event.target.value||undefined,categoryId:undefined,tagIds:[]})}><option value="">全部领域</option>{bootstrap.domains.map(domain=><option key={domain.id} value={domain.id}>{domain.name}</option>)}</select></Field><Field label="扫描分类"><select value={filters.categoryId||''} disabled={blocked} onChange={event=>setFilters({...filters,categoryId:event.target.value||undefined})}><option value="">全部分类（含子分类）</option><CategoryOptions categories={bootstrap.categories} domainId={filters.domainId}/></select></Field><Field label="扫描题型"><select value={filters.type||''} disabled={blocked} onChange={event=>setFilters({...filters,type:event.target.value as QualityFilters['type']||undefined})}><option value="">全部题型</option>{Object.entries(typeLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></Field><Field label="发布状态"><select value={filters.status} disabled={blocked} onChange={event=>setFilters({...filters,status:event.target.value as QualityFilters['status']})}><option value="all">全部发布状态</option><option value="published">已审核</option><option value="pending">待审核</option><option value="draft">草稿</option><option value="archived">已归档</option></select></Field></div>
    <details><summary>限定标签</summary><MultiSelect label="扫描标签" options={bootstrap.tags.filter(tag=>!filters.domainId||!tag.domainId||tag.domainId===filters.domainId)} values={filters.tagIds||[]} onChange={values=>{if(!blocked)setFilters({...filters,tagIds:values});}}/></details>
    <div className="quality-actions"><button className="button primary" disabled={blocked} onClick={()=>void operate(async()=>{const value=await send<QualityScan>(`${base}/scans`,'POST',{filters});if(mounted.current)setRun(value);await process(value);})}><ShieldCheck size={16}/>新建并开始扫描</button>{busy&&<button className="button" onClick={()=>{stopped.current=true;}}><Pause size={16}/>本批完成后暂停</button>}{!busy&&current&&['ready','failed'].includes(current.status)&&<><button className="button" disabled={disabled} onClick={()=>void operate(()=>process(current))}><Play size={16}/>继续当前扫描</button><button className="button" disabled={disabled} onClick={()=>void operate(async()=>{setRun(await send<QualityScan>(`${base}/scans/${idPath(current.id)}/cancel`,'POST'));scans.refresh();onChanged();})}>取消扫描</button></>}</div>
    {current&&<div className="quality-progress" role="status"><div><strong>{labels[current.status]}{busy?' · 正在处理':''}</strong><span>{current.processed.toLocaleString()} / {current.plannedTotal.toLocaleString()} 题 · 发现 {current.findings.toLocaleString()} 项 · 新增 {current.newIssues.toLocaleString()} 项</span></div><progress value={current.processed} max={Math.max(current.plannedTotal,current.processed,1)}/><small className="muted">{localDate(current.updatedAt)} · 修改过的内容请重新扫描。</small>{current.lastFailure&&<ErrorNotice message={`${current.lastFailure.code}：${current.lastFailure.message}`}/>}</div>}
    {error&&<ErrorNotice message={error}/>} {message&&<p className="notice info" role="status">{message}</p>}
    <details><summary>扫描历史与继续入口</summary>{scans.loading?<Loading/>:scans.error?<ErrorNotice message={scans.error} retry={scans.refresh}/>:<div className="quality-history">{scans.data?.items.map(value=><article key={value.id}><div><strong>{localDate(value.createdAt)}</strong><p>{labels[value.status]} · {value.processed.toLocaleString()} / {value.plannedTotal.toLocaleString()} 题 · {value.findings.toLocaleString()} 项</p><small>{value.filters.questionId?`单题 ${value.filters.questionId}`:value.filters.domainId?bootstrap.domains.find(domain=>domain.id===value.filters.domainId)?.name:'全部领域'} · {value.ruleVersion}</small></div><button className="button" disabled={blocked} onClick={()=>setRun(value)}>查看进度</button>{['ready','failed'].includes(value.status)&&<button className="button" disabled={blocked} onClick={()=>void operate(()=>process(value))}>继续</button>}</article>)}</div>}<Pagination page={page} pageSize={pageSize} total={scans.data?.total||0} onPage={setPage} onPageSize={size=>{setPageSize(size);setPage(1);}} label="扫描历史"/></details>
  </section>;
}
