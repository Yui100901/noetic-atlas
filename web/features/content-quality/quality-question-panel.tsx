import {useEffect,useRef,useState,type ReactNode} from 'react';
import {Search,X} from 'lucide-react';
import type {Question} from '../../../shared/models/types';
import type {Paged} from '../../../shared/utils/pagination';
import {QUALITY_RULE_LABELS,QUALITY_SEVERITY_LABELS,QUALITY_STATUS_LABELS,type QualityIssueDetail,type QualityIssueView,type QualityQuestionGroup} from '../../../shared/models/content-quality';
import {idPath,localDate,qs,useResource} from '../../shared/lib/api';
import {Empty,ErrorNotice,Loading,Pagination} from '../../shared/ui/components';
import {qualityOriginLabel} from './quality-detail';
import {QualitySource} from './quality-source';

interface Props{
 questionId:string;revision:number;busy:boolean;selected:Record<string,string>;detail:QualityIssueDetail|null;
 onClose:()=>void;onOpenIssue:(id:string)=>void;onSelect:(issue:QualityIssueView,selected:boolean)=>void;
 onSelectPage:(items:QualityIssueView[])=>void;onManageSelection:()=>void;children:ReactNode;
}
/** A question has one workspace. Individual findings keep their own identity,
 * provenance and state inside its paged list. */
export function QualityQuestionPanel({questionId,revision,busy,selected,detail,onClose,onOpenIssue,onSelect,onSelectPage,onManageSelection,children}:Props){
 const [page,setPage]=useState(1),[pageSize,setPageSize]=useState(20),[status,setStatus]=useState('all'),[origin,setOrigin]=useState('all');
 const issues=useResource<Paged<QualityIssueView>>(`/api/content-quality/issues?${qs({questionId,status,origin,page,pageSize})}`);
 const summaries=useResource<Paged<QualityQuestionGroup>>(`/api/content-quality/questions?${qs({questionId,status:'all',page:1,pageSize:1})}`);
 const source=useResource<Question>(`/api/questions/${idPath(questionId)}`),seen=useRef(revision),evidence=useRef<HTMLDivElement>(null);
 useEffect(()=>{if(seen.current!==revision){seen.current=revision;issues.refresh();summaries.refresh();source.refresh();}},[revision,issues.refresh,summaries.refresh,source.refresh]);
 useEffect(()=>{setPage(1);},[status,origin]);
 useEffect(()=>{if(detail?.issue.questionId===questionId)evidence.current?.scrollIntoView({behavior:'smooth',block:'start'});},[detail?.issue.id,questionId]);
 const summary=summaries.data?.items[0],question=detail?.issue.questionId===questionId?detail.question:source.data;
 const current=detail?.issue.questionId===questionId?detail:null,items=issues.data?.items||[];
 const questionTitle=question?.title||summary?.questionTitle||current?.issue.questionTitle||questionId;
 return <section className="card form-stack quality-question-panel" aria-label="题目质量问题" data-quality-question={questionId}>
  <div className="list-toolbar"><div><h2>{questionTitle}</h2><p className="muted">{questionId} · 共{summary?.issueCount??issues.data?.total??'…'}个问题项 · 待处理{summary?.activeIssueCount??'…'}项</p></div><button className="button" type="button" disabled={busy} onClick={onClose}><X size={15}/>收起题目</button></div>
  <p className="notice info">本题只在主列表出现一次。以下问题项分别记录来源、证据与处理状态；关闭其中一项不会关闭其他项。</p>
  <div className="list-toolbar"><h3>问题列表</h3><div className="quality-actions"><button className="button" type="button" disabled={busy||!items.length} onClick={()=>onSelectPage(items)}>选择本页问题项</button>{Object.keys(selected).length>0&&<button className="button primary" type="button" disabled={busy} onClick={onManageSelection}>处理已选问题项（{Object.keys(selected).length}）</button>}</div></div>
  <div className="quality-question-item-filters"><select aria-label="题内问题状态" value={status} onChange={event=>setStatus(event.target.value)}><option value="all">全部状态</option><option value="active">待处理与需重查</option>{Object.entries(QUALITY_STATUS_LABELS).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select><select aria-label="题内问题来源" value={origin} onChange={event=>setOrigin(event.target.value)}><option value="all">全部来源</option><option value="feedback">用户反馈</option><option value="scan">规则扫描</option></select></div>
  {issues.loading?<Loading/>:issues.error?<ErrorNotice message={issues.error} retry={issues.refresh}/>:items.length?<div className="quality-list quality-question-issues">{items.map(item=><article className={`quality-item ${current?.issue.id===item.id?'quality-item-selected':''}`} key={item.id} data-quality-issue={item.id}>
   <input type="checkbox" aria-label={`选择质量问题 ${item.id}`} checked={!!selected[item.id]} disabled={busy||!selected[item.id]&&Object.keys(selected).length>=100} onChange={event=>onSelect(item,event.target.checked)}/>
   <div className="quality-item-main"><div className="quality-item-heading"><strong>{QUALITY_RULE_LABELS[item.rule]}</strong><span className="badge">{qualityOriginLabel(item)}</span><span className={`badge quality-${item.severity}`}>{QUALITY_SEVERITY_LABELS[item.severity]}</span><span className="badge">{QUALITY_STATUS_LABELS[item.status]}</span></div><p>{item.message}</p><small className="muted">{item.partId?`小题：${question?.parts?.find(part=>part.id===item.partId)?.title||item.partId}`:'整题 / 公共材料'} · {localDate(item.updatedAt)}{item.sourceChanged||item.relatedChanged?' · 内容已变化，请重新扫描':''}</small></div>
   <button className="button" type="button" disabled={busy} onClick={()=>onOpenIssue(item.id)}><Search size={15}/>查看证据</button>
  </article>)}</div>:<Empty title="此筛选下没有问题项" description="可切换到全部状态查看已处理记录。"/>}
  <Pagination page={page} pageSize={pageSize} total={issues.data?.total||0} onPage={setPage} onPageSize={size=>{setPageSize(size);setPage(1);}} label="题内质量问题"/>
  {question?<details open className="quality-question-source"><summary>当前原题、选项与参考答案</summary><QualitySource question={question} partId={current?.issue.partId}/></details>:source.loading?<Loading/>:<p className="notice">原题已不可用或暂时无法读取，问题列表及历史证据仍可查看。</p>}
  {current&&<div ref={evidence} className="quality-question-evidence">{!items.some(item=>item.id===current.issue.id)&&<p className="notice info">已定位到指定问题项；它可能不在当前分页或筛选结果中，以下证据仍独立保留。</p>}{children}</div>}
 </section>;
}
