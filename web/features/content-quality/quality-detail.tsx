import {useRef,useState} from 'react';
import {Check,RefreshCw,Sparkles,X} from 'lucide-react';
import {isRetiredQualityRule,qualityIssueOrigin,QUALITY_RULE_LABELS,QUALITY_STATUS_LABELS,type QualityIssueDetail,type QualityIssueStatus,type QualityIssue} from '../../../shared/models/content-quality';
import {localDate} from '../../shared/lib/api';
import {ErrorNotice,Field,useApp} from '../../shared/ui/components';
import {AiServiceNotice} from '../ai/ai-components';
import {AiProgressPanel,type AiProgressState} from '../ai/ai-progress';
import {FeedbackDetail} from '../quality-feedback/feedback-detail';
import {QualitySource} from './quality-source';

type Action=Exclude<QualityIssueStatus,'stale'>;
type Operation='resolve'|'review'|'scan';
export interface QualityActionResult {ok:boolean;message:string}
const actionLabels:Record<Action,string>={confirmed:'确认存在问题',resolved:'标为已解决',dismissed:'忽略此问题',open:'重新待核查'};
export const qualityOriginLabel=(issue:Pick<QualityIssue,'origin'|'rule'>)=>qualityIssueOrigin(issue)==='feedback'?'用户反馈':'规则扫描';
interface Props {
 value:QualityIssueDetail;busy:boolean;onClose:()=>void;embedded?:boolean;
 onResolve:(action:Action,note:string)=>Promise<QualityActionResult>;
 onRescan:()=>Promise<QualityActionResult>;onReview:()=>Promise<QualityActionResult>;
 onRefresh:()=>void;aiProgress:AiProgressState;onCancelAi:()=>void;
}
export function QualityDetail({value,busy,onClose,onResolve,onRescan,onReview,onRefresh,aiProgress,onCancelAi,embedded=false}:Props){
 const {bootstrap}=useApp(),{issue,question}=value;
 const changed=issue.sourceChanged||issue.relatedChanged,retired=isRetiredQualityRule(issue.rule);
 const [note,setNote]=useState(issue.note),[pending,setPending]=useState<Operation|null>(null);
 const [result,setResult]=useState<(QualityActionResult&{operation:Operation})|null>(null);
 const locked=useRef(false),disabled=busy||!!pending;
 async function perform(operation:Operation,callback:()=>Promise<QualityActionResult>){
  if(locked.current)return;locked.current=true;setPending(operation);setResult(null);
  try{setResult({...await callback(),operation});}catch(error){setResult({ok:false,message:(error as Error).message||'操作未完成，请重试。',operation});}
  finally{locked.current=false;setPending(null);}
 }
 const aiBlocked=retired?'该检查规则已停用，保留的历史证据不能再次发起AI复核。':!question?'原题已不存在，无法提交AI复核。':changed?'原题或候选已变化，不能用旧证据进行AI复核。请重新扫描并查看当前版本的问题；若是旧反馈，请核对后处理或重新反馈。':!['open','confirmed'].includes(issue.status)?'此问题已经处理。需要再次复核时，先将其设为待核查。':!bootstrap.ai.available?'请先在系统配置中启用并配置AI辅助。':'';
 const notice=(operation:Operation)=>result?.operation===operation?<div className="quality-action-feedback" role="region" aria-label="质量操作反馈" aria-live="polite">{result.ok?<p className="notice info" role="status"><Check size={16}/>{result.message}</p>:<><ErrorNotice message={result.message}/><button className="button" type="button" disabled={disabled} onClick={onRefresh}><RefreshCw size={15}/>刷新本条证据</button></>}</div>:null;
 return <section className={`${embedded?'quality-embedded-detail':'card'} form-stack quality-detail`} aria-label="质量问题详情" aria-busy={disabled}>
  <div className="list-toolbar"><div><h2>{embedded?`问题证据：${QUALITY_RULE_LABELS[issue.rule]}`:issue.questionTitle}</h2><p className="muted">{qualityOriginLabel(issue)} · {QUALITY_RULE_LABELS[issue.rule]} · {QUALITY_STATUS_LABELS[issue.status]}{issue.partId?` · 小题 ${issue.partId}`:''}</p></div><div className="quality-actions"><button className="button" type="button" disabled={disabled||!question} onClick={()=>void perform('scan',onRescan)}><RefreshCw size={15}/>{pending==='scan'?'正在重新扫描…':'重新扫描本题'}</button><button className="button" type="button" disabled={!!pending} onClick={onClose}><X size={15}/>收起详情</button></div></div>
  {notice('scan')}
  {retired&&<p className="notice info">该自动检查已停用，以下仅为历史证据，不计入待处理问题。独立解析与参考来源均可为空；如仍有具体内容问题，可对原题另行反馈。</p>}
  <p><strong>{issue.message}</strong></p><pre className="quality-evidence">{issue.evidence}</pre><p>{issue.suggestion}</p>
  {changed&&<p className="notice">原题或对比候选已变化，请先重新扫描当前内容。若已修复，填写处理依据后标为已解决；扫描不会自动替你关闭历史记录。</p>}
  {!question&&<p className="notice">原题已不可用；反馈和处理记录仍保留。</p>}
  {!embedded&&question&&<details open><summary>当前原题、选项与参考答案</summary><QualitySource question={question} partId={issue.partId}/></details>}
  {value.relatedQuestions.map(candidate=><details open key={candidate.id}><summary>对比候选：{candidate.title}</summary><QualitySource question={candidate}/></details>)}
  <section className="quality-review-evidence form-stack"><div className="list-toolbar"><h3>反馈与AI复核证据</h3><button className="button primary" type="button" title={aiBlocked||'结合当前题目、问题证据及站内候选给出核查建议'} disabled={disabled||!!aiBlocked} onClick={()=>void perform('review',onReview)}><Sparkles size={15}/>{pending==='review'?'AI正在复核…':'AI复核本条问题'}</button></div>
    <p className="muted">点击右侧按钮后，AI将比较本题、参考答案、反馈或扫描证据及站内相似题，结果显示在这里。AI不会自动改题或改变下方处理状态。</p>
    <AiServiceNotice/>{aiBlocked&&<p className="notice info" role="note">暂不可复核：{aiBlocked}</p>}
    {(pending==='review'||result?.operation==='review')&&<AiProgressPanel value={aiProgress} cancel={onCancelAi}/>}
    {notice('review')}
    {value.feedbacks.length?value.feedbacks.map(feedback=><FeedbackDetail key={feedback.id+':'+feedback.updatedAt} feedback={feedback} busy={disabled} onReview={()=>void perform('review',onReview)} onUpdated={onRefresh} onClose={()=>{}} embedded/>):<p className="muted">尚未发起AI复核。首次复核时会建立本问题的分析上下文，不新增独立反馈待办。</p>}
  </section>
  <section className="quality-resolution form-stack" aria-label="处理质量问题">
   <div className="quality-current-state"><span className="badge">当前状态：{QUALITY_STATUS_LABELS[issue.status]}</span><small className="muted">最近更新 {localDate(issue.updatedAt)}</small></div>
   {issue.note&&<p className="muted quality-saved-note"><strong>已保存的处理备注：</strong>{issue.note}</p>}
   <Field label="核查依据 / 处理备注" hint="先填写依据，才能确认、解决或忽略。确认表示确有问题；已解决表示已修正并核对；忽略表示本次反馈或提示不成立。"><textarea rows={3} maxLength={5000} value={note} disabled={disabled} onChange={event=>setNote(event.target.value)}/></Field>
   {!note.trim()&&<p className="quality-action-hint">请先填写核查依据或处理备注，再使用确认、解决或忽略按钮。</p>}
   {changed&&<p className="quality-action-hint">原题已变化，暂不能确认旧问题。请先重新扫描，再根据当前内容解决旧记录或查看新问题。</p>}
   <div className="quality-actions">{(['confirmed','resolved','dismissed','open'] as const).map(action=>{const reason=issue.status===action?'当前已经是此状态，无需重复提交':action!=='open'&&!note.trim()?'请先填写核查依据或处理备注':changed&&action==='confirmed'?'原题或候选已变化，请重新扫描当前内容':'';return <button className={`button ${action==='confirmed'?'primary':''}`} type="button" key={action} title={reason||actionLabels[action]} disabled={disabled||!!reason} onClick={()=>void perform('resolve',()=>onResolve(action,note.trim()))}>{actionLabels[action]}</button>;})}</div>
   {pending==='resolve'&&<p className="notice info" role="status">正在保存处理状态并刷新证据…</p>}
   {notice('resolve')}
   <p className="muted">状态按钮保存核查结论。需要修改题目时，使用上方“编辑原题”，保存后重新扫描核对。</p>
  </section>
 </section>;
}
