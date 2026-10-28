import {useEffect,useRef,useState} from 'react';
import {Edit3} from 'lucide-react';
import type {Paged} from '../../../shared/utils/pagination';
import {qualityIssueOrigin,QUALITY_RULE_LABELS,QUALITY_STATUS_LABELS,type QualityIssueView,type QualityQuestionGroup} from '../../../shared/models/content-quality';
import {localDate,qs,useResource} from '../../shared/lib/api';
import {ErrorNotice,Loading,Pagination} from '../../shared/ui/components';
import {managementEditorHref} from '../questions/management-navigation';

interface Props {
  group:QualityQuestionGroup;returnTo:string;revision:number;busy:boolean;
  selected:Record<string,string>;onSelect:(item:QualityIssueView,checked:boolean)=>void;
}

/** Only roots on the current page are mounted. Their short issue lists are
 * loaded near the viewport, so the management queue never fetches the bank. */
export function QualityQuestionSummary({group,returnTo,revision,busy,selected,onSelect}:Props){
  const element=useRef<HTMLElement>(null),seen=useRef(revision);
  const [visible,setVisible]=useState(false),[page,setPage]=useState(1),[pageSize,setPageSize]=useState(10);
  const issues=useResource<Paged<QualityIssueView>>(visible?`/api/content-quality/issues?${qs({questionId:group.questionId,status:'all',page,pageSize})}`:null);
  useEffect(()=>{
    if(visible)return;
    if(!('IntersectionObserver'in window)){setVisible(true);return;}
    const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){setVisible(true);observer.disconnect();}},{rootMargin:'240px'});
    if(element.current)observer.observe(element.current);
    return()=>observer.disconnect();
  },[visible]);
  useEffect(()=>{if(seen.current!==revision){seen.current=revision;issues.refresh();}},[revision,issues.refresh]);
  useEffect(()=>{if(issues.data&&page>1&&!issues.data.items.length)setPage(Math.max(1,Math.ceil(issues.data.total/pageSize)));},[issues.data,page,pageSize]);
  return <article ref={element} className="quality-question-item quality-queue-card" data-quality-question={group.questionId}>
    <div className="quality-queue-heading"><div><h3>{group.sourceAvailable?<a href={managementEditorHref(group.questionId,returnTo)}>{group.questionTitle}</a>:group.questionTitle}</h3><p className="muted">{group.activeIssueCount}项待处理 · 共{group.issueCount}项{group.matchedIssueCount!==group.issueCount?` · 当前筛选匹配${group.matchedIssueCount}项`:''} · {group.questionId}</p></div>{group.sourceAvailable?<a className="button" href={managementEditorHref(group.questionId,returnTo)}><Edit3 size={15}/>详情与编辑</a>:<span className="muted">原题已删除</span>}</div>
    {!visible?<button className="text-button" type="button" onClick={()=>setVisible(true)}>加载本题问题列表</button>:issues.loading?<Loading/>:issues.error?<ErrorNotice message={issues.error} retry={issues.refresh}/>:<>
      <ul className="quality-summary-issues" aria-label={`${group.questionTitle}的问题列表`}>{issues.data?.items.map(item=><li className={`quality-summary-issue quality-state-${item.status}`} key={item.id} data-quality-issue={item.id}>
        <input type="checkbox" aria-label={`选择质量问题 ${item.id}`} checked={!!selected[item.id]} disabled={busy||!selected[item.id]&&Object.keys(selected).length>=100} onChange={event=>onSelect(item,event.target.checked)}/>
        <div className="quality-summary-description"><div className="quality-item-heading"><span className={`badge quality-state-badge-${item.status}`}>{QUALITY_STATUS_LABELS[item.status]}</span><span className="badge">{qualityIssueOrigin(item)==='feedback'?'用户反馈':'规则扫描'}</span><span className="muted">{QUALITY_RULE_LABELS[item.rule]}{item.partId?` · 小题 ${item.partId}`:''}</span></div><p>{item.message}</p><small className="muted">{localDate(item.updatedAt)}{item.sourceChanged||item.relatedChanged?' · 内容已变化，需核对':''}</small></div>
        {group.sourceAvailable&&<a className="text-button quality-issue-edit" href={managementEditorHref(group.questionId,returnTo,item.id)}>详情与处理</a>}
      </li>)}</ul>
      {issues.data&&!issues.data.items.length&&<p className="muted">暂无可显示的问题项，刷新后重试。</p>}
      {(issues.data?.total||0)>10&&<Pagination page={page} pageSize={pageSize} total={issues.data?.total||0} onPage={setPage} onPageSize={size=>{setPageSize(size);setPage(1);}} label={`本题问题 ${group.questionId}`}/>}
    </>}
  </article>;
}
