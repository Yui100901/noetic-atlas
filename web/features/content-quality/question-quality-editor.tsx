import {QualitySource} from './quality-source';
import {qualityOriginLabel} from './quality-detail';
import {useEffect,useRef,useState} from 'react';
import {Check,RefreshCw,ShieldCheck} from 'lucide-react';
import type {Question} from '../../../shared/models/types';
import type {Paged} from '../../../shared/utils/pagination';
import {QUALITY_RULE_LABELS,QUALITY_SEVERITY_LABELS,QUALITY_STATUS_LABELS,type QualityIssueStatus,type QualityIssueView,type QualityScan} from '../../../shared/models/content-quality';
import {idPath,localDate,qs,request,send,useResource} from '../../shared/lib/api';
import {Empty,ErrorNotice,Field,Loading,Pagination} from '../../shared/ui/components';
import './question-quality-editor.css';
import {notifyFeedbackChanged} from '../quality-feedback/feedback-state';

type Action=Exclude<QualityIssueStatus,'stale'>;
const base='/api/content-quality';

/** Works on the last saved question. Unsaved authoring never counts as a fix. */
export function QuestionQualityEditor({question,dirty,saving}:{question:Question;dirty:boolean;saving:boolean}) {
  const [status,setStatus]=useState('active'),[page,setPage]=useState(1),[pageSize,setPageSize]=useState(10);
  const issues=useResource<Paged<QualityIssueView>>(`${base}/issues?${qs({questionId:question.id,status,page,pageSize})}`);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const locked=useRef(false),current=useRef({dirty,saving});current.current={dirty,saving};
  const version=useRef(question.updatedAt);
  useEffect(()=>{if(version.current!==question.updatedAt){version.current=question.updatedAt;issues.refresh();setMessage('题目已保存。可重新检查本题，再按证据更新问题状态。');}},[question.updatedAt,issues.refresh]);
  function guard(){if(current.current.dirty)throw Error('题目尚有未保存修改，请先保存再检查或处理质量问题。');if(current.current.saving)throw Error('正在保存题目，请等待保存完成。');}
  async function perform(action:()=>Promise<void>){if(locked.current)return;try{guard();locked.current=true;setBusy(true);setError('');setMessage('');const latest=await request<Question>(`/api/questions/${idPath(question.id)}`);guard();if(latest.updatedAt!==question.updatedAt)throw Error('题目已被其他页面修改，请保留尚未提交的内容并刷新编辑页后，再处理质量问题。');await action();}catch(reason){setError((reason as Error).message);}finally{locked.current=false;setBusy(false);}}
  async function rescan(){await perform(async()=>{const scan=await send<QualityScan>(`${base}/scans`,'POST',{filters:{questionId:question.id,status:'all'}});guard();const result=await send<QualityScan>(`${base}/scans/${idPath(scan.id)}/process`,'POST',{batchSize:1});if(result.status!=='completed')throw Error('本题检查尚未结束，请到质量工作台继续。');setMessage(`本题检查完成，发现${result.findings}项。历史问题的关闭仍需填写处理依据并确认。`);issues.refresh();});}
  async function resolve(issue:QualityIssueView,action:Action,note:string){await perform(async()=>{await send<QualityIssueView>(`${base}/issues/${idPath(issue.id)}/resolve`,'POST',{status:action,note,expectedUpdatedAt:issue.updatedAt});setMessage(`已将问题设为“${QUALITY_STATUS_LABELS[action]}”。`);notifyFeedbackChanged();issues.refresh();});}
  const disabled=busy||saving||dirty;
  return <section className="card form-stack question-quality-editor" aria-label="本题质量问题">
    <div className="question-quality-heading"><div><h2 className="card-title"><ShieldCheck size={17}/>本题质量问题</h2><p className="muted">统一展示本题及各小题的用户反馈和扫描发现。修改题目与处理问题分别保存。</p></div><a className="button" href={`#/content-quality?questionId=${idPath(question.id)}`}>进入质量管理</a></div>
    <div className="question-quality-toolbar"><Field label="本题质量问题状态"><select value={status} disabled={busy} onChange={event=>{setStatus(event.target.value);setPage(1);}}><option value="active">待处理与需重查</option><option value="all">全部状态</option>{(['open','confirmed','stale','resolved','dismissed'] as const).map(value=><option value={value} key={value}>{QUALITY_STATUS_LABELS[value]}</option>)}</select></Field><button className="button" type="button" disabled={disabled} onClick={()=>void rescan()}><RefreshCw size={15}/>{busy?'正在处理…':'重新检查本题'}</button>{dirty&&<button className="button primary" type="submit" data-keep-editing="true" disabled={busy||saving}><Check size={15}/>保存题目并继续处理</button>}</div>
    {dirty&&<p className="notice info" role="status">有未保存修改。先保存题目，再检查及更新质量问题状态；保存后会留在编辑页。</p>}
    {error&&<ErrorNotice message={error}/>} {message&&<p className="notice info" role="status">{message}</p>}
    {issues.loading?<Loading/>:issues.error?<ErrorNotice message={issues.error} retry={issues.refresh}/>:issues.data?.items.length?<div className="question-quality-items">{issues.data.items.map(issue=><QuestionQualityItem key={issue.id+':'+issue.updatedAt} issue={issue} question={question} disabled={disabled} onResolve={(action,note)=>void resolve(issue,action,note)}/>)}</div>:<Empty title="当前没有符合条件的质量问题" description="可查看全部状态或检查本题。没有规则提示不等于内容已完成专家核验。"/>}
    {!!issues.data?.total&&<Pagination page={page} pageSize={pageSize} total={issues.data.total} onPage={setPage} onPageSize={size=>{setPageSize(size);setPage(1);}} label="本题质量问题"/>}
  </section>;
}
function QuestionQualityItem({issue,question,disabled,onResolve}:{issue:QualityIssueView;question:Question;disabled:boolean;onResolve:(action:Action,note:string)=>void}) {
  const [action,setAction]=useState<Action>('resolved'),[note,setNote]=useState(issue.note);
  const part=issue.partId?question.parts?.find(part=>part.id===issue.partId):undefined;
  return <article className="question-quality-item" data-quality-issue={issue.id}><div className="question-quality-item-header"><strong>{QUALITY_RULE_LABELS[issue.rule]}</strong><span className="badge">{qualityOriginLabel(issue)}</span><span className="badge">{QUALITY_STATUS_LABELS[issue.status]}</span><span className="badge">{QUALITY_SEVERITY_LABELS[issue.severity]}</span></div><p>{issue.message}</p><small className="muted">{issue.partId?`小题：${part?.title||issue.partId}${!part?'（原小题已移除）':''}`:'整题 / 公共材料'} · {localDate(issue.lastDetectedAt)}</small>
    {(issue.sourceChanged||issue.relatedChanged)&&<p className="notice info">原题或对比候选已变化。重新检查保存后的题目，再关闭旧记录；相关题也变化时，需要到质量工作台检查对应范围。</p>}
    <details><summary>查看证据、建议与处理</summary><div className="form-stack"><pre className="question-quality-evidence">{issue.evidence||'未提供额外片段。'}</pre><p>{issue.suggestion}</p><details open><summary>本题题干与参考答案</summary><QualitySource question={question} partId={issue.partId}/></details>{!!issue.relatedQuestions.length&&<ul>{issue.relatedQuestions.map(value=><li key={value.questionId}>{value.title}（{value.questionId}）</li>)}</ul>}
      {issue.note&&<p className="question-quality-previous-note"><strong>已保存的处理说明：</strong>{issue.note}</p>}
      <div className="question-quality-action"><Field label="质量问题处理状态"><select value={action} disabled={disabled} onChange={event=>setAction(event.target.value as Action)}>{(['resolved','confirmed','dismissed','open'] as const).map(value=><option key={value} value={value}>{QUALITY_STATUS_LABELS[value]}</option>)}</select></Field><Field label="质量问题处理依据 / 备注" hint="说明改了什么或核对了什么。设为已解决不会自动改动发布审核或历史卷面。"><textarea rows={3} maxLength={5000} value={note} disabled={disabled} onChange={event=>setNote(event.target.value)}/></Field><button className="button primary" type="button" disabled={disabled||(action!=='open'&&!note.trim())} onClick={()=>onResolve(action,note.trim())}>保存问题状态</button></div>
    </div></details></article>;
}
