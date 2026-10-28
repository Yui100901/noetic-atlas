import {useEffect,useRef,useState} from 'react';
import {Check,Sparkles,Undo2} from 'lucide-react';
import type {QuestionInput} from '../../../shared/models/types';
import type {AiRun} from '../../../shared/ai/ai';
import type {AiQuestionEditResult,AiQuestionEditSuggestion,AiQuestionEditChanges} from '../../../shared/ai/question-edit';
import {AiServiceNotice} from '../ai/ai-components';
import {AiProgressPanel,aiFailureMessage,useAiProgress} from '../ai/ai-progress';
import {ErrorNotice,Field,useApp} from '../../shared/ui/components';
import {applyAiQuestionEditSuggestion,undoAiQuestionEditSuggestion,type AiQuestionEditReceipt} from './ai-question-edit-policy';
import './ai-question-editor.css';

type EditRun=Extract<AiRun<AiQuestionEditResult>,{status:'completed'}>;
interface Applied {key:string;runId:string;suggestion:AiQuestionEditSuggestion;receipt:AiQuestionEditReceipt}
const labels:Record<keyof AiQuestionEditChanges,string>={title:'标题',stemMarkdown:'题干',answerMarkdown:'参考答案',explanationMarkdown:'解析',options:'选项',correctAnswers:'判分答案',blanks:'填空答案',categoryIds:'分类',tagIds:'标签'};
const confidence={high:'较高把握',medium:'建议核对',low:'需重点核对'};

/** Suggestions operate on the current local form, never a server mutation. */
export function AiQuestionEditor({questionId,version,draft,disabled,onChange}:{questionId:string;version:string;draft:QuestionInput;disabled:boolean;onChange:(value:QuestionInput)=>void}){
 const {bootstrap}=useApp(),progress=useAiProgress();
 const current=useRef(draft);current.current=draft;
 const mounted=useRef(true),locked=useRef(false);
 const [requirements,setRequirements]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [analysis,setAnalysis]=useState<{run:EditRun;baseline:QuestionInput}|null>(null);
 const [applied,setApplied]=useState<Applied[]>([]),[feedback,setFeedback]=useState<Record<string,{ok:boolean;message:string}>>({});
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const blocked=disabled||busy;
 async function analyze(){
  if(blocked||locked.current)return;locked.current=true;setBusy(true);setError('');
  const baseline=structuredClone(current.current);
  try{const run=await progress.run<EditRun>('/api/ai/question-edit',{questionId,expectedUpdatedAt:version,question:baseline,requirements:requirements.trim()});if(mounted.current)setAnalysis({run,baseline});}
  catch(reason){if(mounted.current)setError(aiFailureMessage(reason));}
  finally{locked.current=false;if(mounted.current)setBusy(false);}
 }
 function apply(suggestion:AiQuestionEditSuggestion){
  if(!analysis||blocked)return;const key=analysis.run.id+':'+suggestion.id;if(applied.some(value=>value.key===key))return;
  const result=applyAiQuestionEditSuggestion(current.current,analysis.baseline,suggestion);
  setFeedback(value=>({...value,[key]:{ok:result.ok,message:result.message}}));
  if(result.ok){current.current=result.value;onChange(result.value);setApplied(value=>[...value,{key,runId:analysis.run.id,suggestion,receipt:result.receipt}]);}
 }
 function undo(entry:Applied){
  if(blocked)return;const result=undoAiQuestionEditSuggestion(current.current,entry.receipt);
  setFeedback(value=>({...value,[entry.key]:{ok:result.ok,message:result.message}}));
  if(result.ok){current.current=result.value;onChange(result.value);setApplied(value=>value.filter(item=>item.key!==entry.key));}
 }
 function format(field:string,value:unknown){
  if(value===undefined)return'（未设置）';
  if(field==='categoryIds'||field==='tagIds'){const records=field==='categoryIds'?bootstrap.categories:bootstrap.tags;return(value as string[]).map(id=>records.find(item=>item.id===id)?.name||id).join('、')||'（空）';}
  if(field==='options')return(value as Array<{key:string;text:string}>).map(item=>item.key+'. '+item.text).join('\n')||'（空）';
  if(field==='correctAnswers')return(value as string[]).map(item=>item==='true'?'正确':item==='false'?'错误':item).join('、')||'（空）';
  return typeof value==='string'?value||'（空）':JSON.stringify(value,null,2);
 }
 const oldApplied=applied.filter(value=>value.runId!==analysis?.run.id);
 return <section className="card form-stack ai-question-editor" aria-label="AI辅助编辑">
  <div className="ai-question-editor-heading"><div><h2><Sparkles size={18}/>AI辅助编辑</h2><p className="muted">分析当前题干、答案、解析、归类及质量问题，逐条选择修改并随时撤回。</p></div><button className="button primary" type="button" disabled={blocked||!bootstrap.ai.available} onClick={()=>void analyze()}><Sparkles size={16}/>{busy?'正在分析…':'分析当前题目'}</button></div>
  <AiServiceNotice/>
  <details className="ai-edit-requirements"><summary>补充编辑要求（可选）</summary><Field label="编辑要求（可选）"><textarea rows={2} maxLength={5000} disabled={busy||disabled} value={requirements} onChange={event=>setRequirements(event.target.value)} placeholder="例如：保留原考点，修正答案矛盾，补充易错点并检查分类标签。"/></Field></details>
  <p className="muted">应用建议只更新表单，检查后点击“保存题目”。质量问题的处理状态在对应问题卡片中单独确认。</p>
  <AiProgressPanel value={progress.progress} cancel={progress.cancel} previousResult={!!analysis}/>
  {error&&<ErrorNotice message={error}/>}
  {analysis&&<div className="form-stack ai-edit-results"><p className="ai-edit-summary">{analysis.run.result.summary}</p>{[...new Set([...analysis.run.warnings,...analysis.run.result.warnings])].map((warning,index)=><p className="notice info" key={index}>{warning}</p>)}
   {analysis.run.result.suggestions.length?analysis.run.result.suggestions.map(suggestion=>{
    const key=analysis.run.id+':'+suggestion.id,entry=applied.find(value=>value.key===key),outcome=feedback[key];
    const target=suggestion.partId?analysis.baseline.parts?.find(part=>part.id===suggestion.partId):analysis.baseline;
    return <article className="ai-edit-suggestion form-stack" data-edit-suggestion={suggestion.id} key={key}>
     <div className="ai-edit-suggestion-heading"><h3>{suggestion.title}</h3><span className="badge">{confidence[suggestion.confidence]}</span>{suggestion.partId&&<span className="badge">小题：{target?.title||suggestion.partId}</span>}{entry&&<span className="badge"><Check size={13}/>已应用到表单</span>}</div>
     <p>{suggestion.reason}</p>
     <div className="ai-edit-changes">{Object.entries(suggestion.changes).map(([field,value])=><section key={field}><h4>{labels[field as keyof AiQuestionEditChanges]}</h4><div className="ai-edit-diff"><div><span className="muted">分析时内容</span><pre>{format(field,(target as unknown as Record<string,unknown>)?.[field])}</pre></div><div><span className="muted">建议修改为</span><pre>{format(field,value)}</pre></div></div></section>)}</div>
     <div className="ai-actions">{entry?<button className="button" type="button" disabled={blocked} onClick={()=>undo(entry)}><Undo2 size={15}/>撤回本条修改</button>:<button className="button primary" type="button" disabled={blocked} onClick={()=>apply(suggestion)}>应用本条建议</button>}</div>
     {outcome&&<p className={`notice ${outcome.ok?'info':'error'}`} role={outcome.ok?'status':'alert'}>{outcome.message}</p>}
    </article>;
   }):<p className="notice info">本次没有可直接应用的修改建议，可参考分析结论继续核查。</p>}
  </div>}
  {!!oldApplied.length&&<section className="ai-edit-applied-history form-stack" aria-label="此前已应用的AI修改"><h3>此前已应用的修改</h3><p className="muted">重新分析会更新建议列表；先前应用的修改仍可逐条撤回。撤回只更新表单，已保存内容需再次保存才会改变。</p>{oldApplied.map(entry=><article key={entry.key}><span>{entry.suggestion.title}</span><button className="button" type="button" disabled={blocked} onClick={()=>undo(entry)}><Undo2 size={15}/>撤回本条修改</button>{feedback[entry.key]&&<p className={`notice ${feedback[entry.key].ok?'info':'error'}`} role={feedback[entry.key].ok?'status':'alert'}>{feedback[entry.key].message}</p>}</article>)}</section>}
  {!!applied.length&&<div className="ai-actions ai-edit-save"><span className="muted">已应用{applied.length}条建议，检查后可保存并留在此处继续编辑或撤回。</span><button className="button primary" type="submit" form="question-editor-form" data-keep-editing="true" disabled={blocked}>保存并继续编辑</button></div>}
 </section>;
}
