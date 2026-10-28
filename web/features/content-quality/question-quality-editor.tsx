import {QualityDetail,qualityOriginLabel,type QualityActionResult} from './quality-detail';
import {QualityIssueResolution} from './quality-issue-resolution';
import {useEffect,useRef,useState} from 'react';
import {Check,RefreshCw,Search,ShieldCheck} from 'lucide-react';
import type {Question} from '../../../shared/models/types';
import type {FeedbackReviewBatch,QuestionFeedbackView} from '../../../shared/models/question-feedback';
import type {Paged} from '../../../shared/utils/pagination';
import {QUALITY_RULE_LABELS,QUALITY_SEVERITY_LABELS,QUALITY_STATUS_LABELS,type QualityIssueDetail,type QualityIssueStatus,type QualityIssueView,type QualityQuestionGroup,type QualityScan} from '../../../shared/models/content-quality';
import {idPath,localDate,qs,request,send,useResource} from '../../shared/lib/api';
import {Empty,ErrorNotice,Field,Loading,Pagination} from '../../shared/ui/components';
import {aiFailureMessage,useAiProgress} from '../ai/ai-progress';
import {notifyFeedbackChanged} from '../quality-feedback/feedback-state';
import './content-quality.css';
import '../quality-feedback/question-feedback.css';
import './question-quality-editor.css';

type Action=Exclude<QualityIssueStatus,'stale'>;
const base='/api/content-quality';

/** Each finding owns its version and decision. Authoring and issue processing
 * share the saved question, while local unsaved text never counts as a fix. */
export function QuestionQualityEditor({question,dirty,saving,initialIssueId=''}:{question:Question;dirty:boolean;saving:boolean;initialIssueId?:string}) {
 const [status,setStatus]=useState('all'),[page,setPage]=useState(1),[pageSize,setPageSize]=useState(10);
 const issues=useResource<Paged<QualityIssueView>>(`${base}/issues?${qs({questionId:question.id,status,page,pageSize})}`);
 const summary=useResource<Paged<QualityQuestionGroup>>(`${base}/questions?${qs({questionId:question.id,status:'all',page:1,pageSize:10})}`);
 const [expanded,setExpanded]=useState(!!initialIssueId),initialExpansion=useRef(!!initialIssueId);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 const [detail,setDetail]=useState<QualityIssueDetail|null>(null),[detailLoading,setDetailLoading]=useState(false);
 const locked=useRef(false),current=useRef({dirty,saving,question});current.current={dirty,saving,question};
 const selected=useRef(''),sequence=useRef(0),version=useRef(question.updatedAt),detailRef=useRef<HTMLDivElement>(null),mounted=useRef(true);
 const progress=useAiProgress();
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;++sequence.current;};},[]);
 function guard(){if(current.current.dirty)throw Error('题目尚有未保存修改，请先保存再检查或处理质量问题。');if(current.current.saving)throw Error('正在保存题目，请等待保存完成。');}
 async function refreshDetail():Promise<boolean>{
  const id=selected.current,requestSequence=++sequence.current;if(!id)return true;
  try{const value=await request<QualityIssueDetail>(`${base}/issues/${idPath(id)}`);if(mounted.current&&selected.current===id&&sequence.current===requestSequence){if(value.issue.questionId!==current.current.question.id)throw Error('指定问题不属于当前题目，请从本题问题列表重新选择。');setDetail(previous=>previous?.issue.id===id&&previous.issue.updatedAt>value.issue.updatedAt?previous:value);}return true;}
  catch(reason){if(mounted.current&&selected.current===id&&sequence.current===requestSequence)setError((reason as Error).message);return false;}
 }
 async function openIssue(id:string){if(locked.current)return;selected.current=id;setDetail(null);setError('');setDetailLoading(true);try{await refreshDetail();}finally{if(mounted.current&&selected.current===id)setDetailLoading(false);}}
 function closeIssue(){selected.current='';++sequence.current;setDetail(null);setDetailLoading(false);}
 function refresh(){issues.refresh();summary.refresh();void refreshDetail();}
 useEffect(()=>{if(initialIssueId){setExpanded(true);void openIssue(initialIssueId);}},[initialIssueId,question.id]);
 useEffect(()=>{if(!initialExpansion.current&&!summary.loading&&summary.data){initialExpansion.current=true;setExpanded((summary.data.items[0]?.activeIssueCount||0)>0);}},[summary.loading,summary.data]);
 useEffect(()=>{if(detail)detailRef.current?.scrollIntoView({behavior:'smooth',block:'start'});},[detail?.issue.id]);
 useEffect(()=>{if(version.current!==question.updatedAt){version.current=question.updatedAt;issues.refresh();void refreshDetail();setMessage('题目已保存。可重新检查本题，再按证据更新问题状态。');}},[question.updatedAt,issues.refresh]);
 async function perform(action:()=>Promise<QualityActionResult>):Promise<QualityActionResult>{
  if(locked.current)return{ok:false,message:'上一项操作尚未完成，请稍候。'};
  try{guard();locked.current=true;setBusy(true);setError('');setMessage('');++sequence.current;
   const latest=await request<Question>(`/api/questions/${idPath(current.current.question.id)}`);guard();
   if(latest.updatedAt!==current.current.question.updatedAt)throw Error('题目已被其他页面修改，请保留尚未提交的内容并刷新编辑页后，再处理质量问题。');
   const result=await action();if(mounted.current)setMessage(result.message);return result;
  }catch(reason){const text=(reason as Error).message;if(mounted.current)setError(text);return{ok:false,message:text};}
  finally{locked.current=false;if(mounted.current)setBusy(false);}
 }
 async function refreshAfterWrite(){issues.refresh();summary.refresh();notifyFeedbackChanged();return refreshDetail();}
 async function rescan():Promise<QualityActionResult>{return perform(async()=>{
  const scan=await send<QualityScan>(`${base}/scans`,'POST',{filters:{questionId:question.id,status:'all'}});guard();
  const result=await send<QualityScan>(`${base}/scans/${idPath(scan.id)}/process`,'POST',{batchSize:1});
  if(result.status!=='completed')throw Error('本题检查尚未结束，请到质量管理继续。');
  const refreshed=await refreshAfterWrite();return{ok:true,message:`本题检查完成，发现${result.findings}项。历史问题的关闭仍需填写处理依据并确认。${refreshed?'':'证据刷新失败，请刷新后查看，扫描结果已保存。'}`};
 });}
 async function resolve(issue:QualityIssueView,action:Action,note:string):Promise<QualityActionResult>{return perform(async()=>{
  guard();const saved=await send<QualityIssueView>(`${base}/issues/${idPath(issue.id)}/resolve`,'POST',{status:action,note,expectedUpdatedAt:issue.updatedAt});
  // Apply only this finding; never copy its version/status to sibling findings.
  issues.setData(previous=>previous?{...previous,items:previous.items.map(item=>item.id===saved.id?saved:item)}:previous);
  setDetail(previous=>previous?.issue.id===saved.id?{...previous,issue:saved}:previous);
  const refreshed=await refreshAfterWrite();return{ok:true,message:`已将本问题设为“${QUALITY_STATUS_LABELS[action]}”，同题其他问题分别保留。${refreshed?'':'证据刷新失败，请刷新后继续；已保存的状态保留。'}`};
 });}
 async function review(issue:QualityIssueView):Promise<QualityActionResult>{return perform(async()=>{
  let result:QualityActionResult;
  try{
   const prepared=await send<{issue:QualityIssueView;feedback:QuestionFeedbackView}>(`${base}/issues/${idPath(issue.id)}/review-context`,'POST',{expectedUpdatedAt:issue.updatedAt});guard();
   const reviewed=await progress.run<FeedbackReviewBatch>('/api/question-feedback/ai-review',{ids:[prepared.feedback.id],expectedUpdatedAt:{[prepared.feedback.id]:prepared.feedback.updatedAt}});
   result={ok:reviewed.failed===0,message:reviewed.failed?'本问题AI复核失败，具体原因保留在证据和AI处理记录中，可核对后重试。':'本问题AI复核完成；请核对下方建议，再确认处理状态。'};
  }catch(reason){result={ok:false,message:aiFailureMessage(reason)||'已取消本次AI复核，已完成的证据仍保留。'};}
  const refreshed=await refreshAfterWrite();return{...result,message:result.message+(refreshed?'':'证据刷新失败，请刷新后查看已保存的结果。')};
 });}
 const disabled=busy||saving||dirty;
 return <section className="card question-quality-editor" aria-label="本题质量问题"><details className="question-quality-disclosure" open={expanded} onToggle={event=>{const next=event.currentTarget.open;if(next!==expanded){initialExpansion.current=true;setExpanded(next);}}}>
  <summary className="question-quality-summary"><span className="card-title"><ShieldCheck size={17}/>本题质量问题</span><span className="muted">{summary.loading?'正在读取…':summary.error?'读取失败，可展开重试':summary.data?.items[0]?.activeIssueCount?`${summary.data.items[0].activeIssueCount}项待处理`:(summary.data?.items[0]?.issueCount||0)>0?'均已处理':'未发现问题'}</span></summary><div className="form-stack question-quality-content">
  <div className="question-quality-heading"><div><h2 className="card-title"><ShieldCheck size={17}/>本题质量问题</h2><p className="muted">逐项核对用户反馈与扫描发现，修改原题后可在这里直接确认处理。</p></div><a className="button" href={`#/content-quality?questionId=${idPath(question.id)}`}>本题质量记录</a></div>
  <div className="question-quality-toolbar"><Field label="本题质量问题状态"><select value={status} disabled={busy} onChange={event=>{setStatus(event.target.value);setPage(1);}}><option value="all">全部状态</option><option value="active">待处理与需重查</option>{(['open','confirmed','stale','resolved','dismissed'] as const).map(value=><option value={value} key={value}>{QUALITY_STATUS_LABELS[value]}</option>)}</select></Field><button className="button" type="button" disabled={disabled} onClick={()=>void rescan()}><RefreshCw size={15}/>{busy?'正在处理…':'重新检查本题'}</button>{dirty&&<button className="button primary" type="submit" data-keep-editing="true" disabled={busy||saving}><Check size={15}/>保存题目并继续处理</button>}</div>
  {dirty&&<p className="notice info" role="status">有未保存修改。先保存题目，再检查及更新质量问题状态；保存后会留在编辑页。</p>}
  {error&&<ErrorNotice message={error}/>} {message&&<p className="notice info" role="status">{message}</p>}
  {issues.loading&&!issues.data?<Loading/>:issues.error?<ErrorNotice message={issues.error} retry={issues.refresh}/>:issues.data?.items.length?<div className="question-quality-items" aria-busy={issues.loading}>{issues.data.items.map(issue=>{
   const part=issue.partId?question.parts?.find(value=>value.id===issue.partId):undefined;
   return <article className={`question-quality-item question-quality-${issue.status} question-quality-severity-${issue.severity}${detail?.issue.id===issue.id?' is-selected':''}`} key={issue.id} data-quality-issue={issue.id}>
    <div className="question-quality-item-header"><strong>{QUALITY_RULE_LABELS[issue.rule]}</strong><span className="badge">{qualityOriginLabel(issue)}</span><span className={`badge quality-state-${issue.status}`}>{QUALITY_STATUS_LABELS[issue.status]}</span><span className={`badge quality-${issue.severity}`}>{QUALITY_SEVERITY_LABELS[issue.severity]}</span></div>
    <p>{issue.message}</p><div className="question-quality-item-footer"><small className="muted">{issue.partId?`小题：${part?.title||issue.partId}${!part?'（原小题已移除）':''}`:'整题 / 公共材料'} · {localDate(issue.updatedAt)}{issue.sourceChanged||issue.relatedChanged?' · 内容已变化，请重新检查':''}</small><button className="button" type="button" disabled={busy||detailLoading} onClick={()=>void openIssue(issue.id)}><Search size={14}/>查看证据与处理</button></div>
    <QualityIssueResolution issue={issue} disabled={disabled||issues.loading} onResolve={(action,note)=>resolve(issue,action,note)}/>
   </article>;
  })}</div>:<Empty title="当前没有符合条件的质量问题" description="可查看全部状态或检查本题。没有规则提示不等于内容已完成专家核验。"/>}
  {!!issues.data?.total&&<Pagination page={page} pageSize={pageSize} total={issues.data.total} onPage={setPage} onPageSize={size=>{setPageSize(size);setPage(1);}} label="本题质量问题"/>}
  {detailLoading&&<Loading/>}
  {detail&&<div ref={detailRef} className="question-quality-detail">{!issues.data?.items.some(issue=>issue.id===detail.issue.id)&&<p className="notice info">已定位指定问题；该项不在当前筛选或分页中，其证据仍可核查。</p>}
   {disabled&&<p className="notice info">{dirty?'原题有未保存修改，请先保存后再更新问题状态或发起AI复核。':saving?'正在保存原题，请等待完成。':'正在处理本问题，请等待完成后继续处理其他问题。'}</p>}
   <p className="notice info">本项状态在上方对应问题卡片中单独保存；这里查看证据及AI复核。</p>
   <QualityDetail key={detail.issue.id} embedded showResolution={false} value={detail} busy={disabled} onClose={closeIssue} onResolve={(action,note)=>resolve(detail.issue,action,note)} onRescan={rescan} onReview={()=>review(detail.issue)} onRefresh={refresh} aiProgress={progress.progress} onCancelAi={progress.cancel}/>
  </div>}
 </div></details></section>;
}
