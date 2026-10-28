import {useEffect,useRef,useState} from 'react';
import {ArrowLeft,RefreshCw,Settings2} from 'lucide-react';
import type {Paged} from '../../../shared/utils/pagination';
import type {FeedbackReviewBatch,QuestionFeedbackView} from '../../../shared/models/question-feedback';
import {isRetiredQualityRule,QUALITY_RULE_LABELS,QUALITY_SEVERITY_LABELS,QUALITY_STATUS_LABELS,type QualityIssueDetail,type QualityIssueStatus,type QualityIssueView,type QualityQuestionGroup,type QualityOverview} from '../../../shared/models/content-quality';
import {idPath,qs,request,send,useDebounced,useResource} from '../../shared/lib/api';
import {replaceHashRoute} from '../../shared/lib/navigation-guard';
import {Empty,ErrorNotice,Loading,PageHeader,Pagination,SearchBox,useApp} from '../../shared/ui/components';
import {managementEditorHref,managementLocation,readManagementLocation} from '../questions/management-navigation';
import {AiProgressPanel,aiFailureMessage,useAiProgress} from '../ai/ai-progress';
import {notifyFeedbackChanged} from '../quality-feedback/feedback-state';
import {QualityBatchActions} from './quality-batch-actions';
import type {QualityActionResult} from './quality-detail';
import {QualityQuestionSummary} from './quality-question-summary';
import {QualityScanTools} from './quality-scan-tools';
import './content-quality.css';

const base='/api/content-quality';
type Action=Exclude<QualityIssueStatus,'stale'>;

export function ContentQualityPage({questionId='',feedbackId='',issueId=''}:{questionId?:string;feedbackId?:string;issueId?:string}){
  const {bootstrap,toast}=useApp(),progress=useAiProgress();
  const [initial]=useState(()=>{const value=readManagementLocation(window.location.hash);return value?.kind==='quality'?value:null;});
  const [search,setSearch]=useState(initial?.search||''),[status,setStatus]=useState(initial?.status||'active'),[origin,setOrigin]=useState(initial?.origin||'all');
  const [severity,setSeverity]=useState(initial?.severity||''),[rule,setRule]=useState(initial?.rule||''),[domainId,setDomainId]=useState(initial?.domainId||'');
  const [page,setPage]=useState(initial?.page||1),[pageSize,setPageSize]=useState(initial?.pageSize||20);
  const [selected,setSelected]=useState<Record<string,string>>({}),[note,setNote]=useState(''),[busy,setBusy]=useState(false);
  const [error,setError]=useState(''),[message,setMessage]=useState(''),[revision,setRevision]=useState(0),[toolsOpen,setToolsOpen]=useState(false);
  const tools=useRef<HTMLDetailsElement>(null),mounted=useRef(true);
  const scopedQuestion=questionId||initial?.questionId||'',scanId=initial?.scanId||'';
  const returnTo=managementLocation('quality',{search,status,origin,severity,rule,domainId,questionId:scopedQuestion,scanId,page,pageSize});
  const debounced=useDebounced(search),overview=useResource<QualityOverview>(`${base}/overview`);
  const groups=useResource<Paged<QualityQuestionGroup>>(`${base}/questions?${qs({search:debounced,status,origin,severity,rule,domainId,questionId:scopedQuestion,scanId,page,pageSize})}`);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{if(!issueId&&!feedbackId&&window.location.hash!==returnTo)history.replaceState(history.state,'',returnTo);},[returnTo,issueId,feedbackId]);
  useEffect(()=>{
    if(!issueId&&!feedbackId)return;let cancelled=false;
    async function locate(){
      try{
        const issue=issueId?(await request<QualityIssueDetail>(`${base}/issues/${idPath(issueId)}`)).issue:(await request<Paged<QualityIssueView>>(`${base}/issues?${qs({feedbackId,status:'all',page:1,pageSize:10})}`)).items[0];
        if(!issue)throw Error('没有找到这条反馈关联的质量问题。');
        if(!issue.sourceAvailable)throw Error('原题已删除，无法进入编辑页；历史问题记录仍保留在列表中。');
        if(!cancelled)replaceHashRoute(managementEditorHref(issue.questionId,returnTo,issue.id));
      }catch(reason){if(!cancelled)setError((reason as Error).message);}
    }
    void locate();return()=>{cancelled=true;};
  },[issueId,feedbackId]);
  useEffect(()=>{if(groups.data&&page>1&&!groups.data.items.length)setPage(Math.max(1,Math.ceil(groups.data.total/pageSize)));},[groups.data,page,pageSize]);
  function refresh(){groups.refresh();overview.refresh();setRevision(value=>value+1);}
  function selectIssue(item:QualityIssueView,checked:boolean){setSelected(values=>{const next={...values};if(checked&&!next[item.id]&&Object.keys(next).length>=100)return values;if(checked)next[item.id]=item.updatedAt;else delete next[item.id];return next;});}
  function changeFilter(setter:(value:string)=>void,value:string){setter(value);setPage(1);}
  async function resolve(entries:Record<string,string>,action:Action,text:string):Promise<QualityActionResult>{
    setBusy(true);setError('');setMessage('');
    try{
      const result=await send<{items:QualityIssueView[]}>(`${base}/issues/resolve`,'POST',{ids:Object.keys(entries),status:action,note:text,expectedUpdatedAt:entries});
      const message=`已保存为“${QUALITY_STATUS_LABELS[action]}”（${result.items.length}项）。`;
      if(mounted.current){setSelected({});setNote('');notifyFeedbackChanged();refresh();setMessage(message);toast(message);}return{ok:true,message};
    }catch(reason){const message=(reason as Error).message;if(mounted.current)setError(message);return{ok:false,message};}
    finally{if(mounted.current)setBusy(false);}
  }
  async function review(entries:Record<string,string>):Promise<QualityActionResult>{
    const ids=Object.keys(entries);if(!ids.length||ids.length>20)return{ok:false,message:'每次AI复核请选择1至20项问题。'};
    setBusy(true);setError('');setMessage('');let outcome:QualityActionResult={ok:false,message:'AI复核尚未完成。'};
    try{
      const prepared=await send<{items:Array<{issue:QualityIssueView;feedback:QuestionFeedbackView}>}>(`${base}/review-contexts`,'POST',{ids,expectedUpdatedAt:entries});
      const versions=Object.fromEntries(prepared.items.map(item=>[item.feedback.id,item.feedback.updatedAt]));
      const result=await progress.run<FeedbackReviewBatch>('/api/question-feedback/ai-review',{ids:Object.keys(versions),expectedUpdatedAt:versions});
      outcome={ok:result.failed===0,message:`AI复核完成${result.completed}项${result.failed?`，${result.failed}项失败`:''}。进入编辑页查看各项证据、建议或失败原因，并确认处理状态。`};
    }catch(reason){outcome={ok:false,message:aiFailureMessage(reason)||'已取消本次AI复核；已保存的结果仍保留。'};if(mounted.current)setError(outcome.message);}
    finally{if(mounted.current){setSelected({});notifyFeedbackChanged();refresh();setBusy(false);}}
    if(mounted.current)setMessage(outcome.message);return outcome;
  }
  const ids=Object.keys(selected),items=groups.data?.items||[];
  return <div className="content-quality-page quality-queue-page">
    <PageHeader eyebrow="CONTENT QUALITY" title="质量管理" description="按题目查看反馈与扫描问题，进入编辑页修改内容、核对证据和更新状态。" actions={<><a className="button" href="#/questions"><ArrowLeft size={16}/>返回题库</a><button className="button" onClick={()=>{setToolsOpen(value=>!value);if(!toolsOpen)requestAnimationFrame(()=>tools.current?.scrollIntoView({behavior:'smooth',block:'start'}));}}><Settings2 size={15}/>扫描与批量工具{ids.length?`（已选${ids.length}项）`:''}</button><button className="button" onClick={refresh} disabled={busy}><RefreshCw size={15}/>刷新</button></>}/>
    {overview.data&&<div className="quality-queue-overview"><p><strong>{overview.data.activeQuestions.toLocaleString()}道题待处理</strong><span className="muted"> · {overview.data.totalQuestions.toLocaleString()}道题有记录 · 共{overview.data.totalIssues.toLocaleString()}个问题项</span></p><div className="quality-queue-counts">{(['open','confirmed','stale','resolved','dismissed']as const).map(value=><button className={`quality-count-filter quality-state-badge-${value} ${status===value?'active':''}`} key={value} onClick={()=>changeFilter(setStatus,value)}>{QUALITY_STATUS_LABELS[value]} {overview.data!.counts[value].toLocaleString()}</button>)}</div></div>}
    {error&&<ErrorNotice message={error}/>} {message&&<p className="notice info" role="status">{message}</p>}
    <AiProgressPanel value={progress.progress} cancel={progress.cancel}/>
    <section className="card form-stack" aria-label="质量题目列表">
      {(scopedQuestion||scanId)&&<p className="notice info">当前限定{scopedQuestion?`题目 ${scopedQuestion}`:`扫描 ${scanId}`}。<a href="#/content-quality">查看全部质量题目</a></p>}
      <div className="quality-queue-filters"><SearchBox value={search} onChange={value=>changeFilter(setSearch,value)} placeholder="搜索题目或问题描述"/><select aria-label="质量问题状态" value={status} onChange={event=>changeFilter(setStatus,event.target.value)}><option value="active">含待处理问题</option><option value="all">全部状态</option>{Object.entries(QUALITY_STATUS_LABELS).map(([key,label])=><option key={key} value={key}>含{label}项</option>)}</select><select aria-label="质量问题来源" value={origin} onChange={event=>changeFilter(setOrigin,event.target.value)}><option value="all">全部来源</option><option value="feedback">用户反馈</option><option value="scan">规则扫描</option></select></div>
      <details className="quality-queue-more-filters"><summary>更多筛选{domainId||severity||rule?' · 已设置':''}</summary><div className="quality-filters"><select aria-label="质量问题领域" value={domainId} onChange={event=>changeFilter(setDomainId,event.target.value)}><option value="">全部领域</option>{bootstrap.domains.map(domain=><option key={domain.id} value={domain.id}>{domain.name}</option>)}</select><select aria-label="质量严重程度" value={severity} onChange={event=>changeFilter(setSeverity,event.target.value)}><option value="">全部严重程度</option>{Object.entries(QUALITY_SEVERITY_LABELS).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select><select aria-label="质量检查规则" value={rule} onChange={event=>changeFilter(setRule,event.target.value)}><option value="">全部规则</option>{Object.entries(QUALITY_RULE_LABELS).filter(([key])=>!isRetiredQualityRule(key)).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></div></details>
      <div className="quality-queue-result"><span>{groups.data?.total??'…'}道题</span><span className="muted">同题只显示一次 · 题下分别列出全部来源的问题</span>{ids.length>0&&<button className="text-button" onClick={()=>{setToolsOpen(true);requestAnimationFrame(()=>tools.current?.scrollIntoView({behavior:'smooth',block:'start'}));}}>处理已选问题项（{ids.length}）</button>}</div>
      {groups.loading?<Loading/>:groups.error?<ErrorNotice message={groups.error} retry={groups.refresh}/>:items.length?<div className="quality-question-list">{items.map(group=><QualityQuestionSummary key={group.questionId} group={group} returnTo={returnTo} revision={revision} busy={busy} selected={selected} onSelect={selectIssue}/>)}</div>:<Empty title="当前没有符合条件的质量题目" description="用户反馈与规则发现会归在对应题目下。"/>}
      <Pagination page={page} pageSize={pageSize} total={groups.data?.total||0} onPage={setPage} onPageSize={size=>{setPageSize(size);setPage(1);}} label="质量题目"/>
    </section>
    <details ref={tools} className="card quality-management-tools" open={toolsOpen} onToggle={event=>setToolsOpen(event.currentTarget.open)}><summary>扫描与批量工具{ids.length?` · 已选${ids.length}个问题项`:''}</summary><div className="form-stack">
      <QualityBatchActions selected={selected} note={note} onNote={setNote} busy={busy} onClear={()=>setSelected({})} onResolve={resolve} onReview={review}/>
      <QualityScanTools latestScan={overview.data?.latestScan||null} ruleVersion={overview.data?.ruleVersion||''} onChanged={refresh} disabled={busy}/>
      <p className="muted">{overview.data?.coverage.message} 参考来源与独立解析均可留空。无规则命中不表示内容已完成专家核验。</p>
    </div></details>
  </div>;
}
