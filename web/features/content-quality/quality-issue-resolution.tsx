import {useEffect,useRef,useState} from 'react';
import type {QualityIssueStatus,QualityIssueView} from '../../../shared/models/content-quality';
import {QUALITY_STATUS_LABELS} from '../../../shared/models/content-quality';
import {Field} from '../../shared/ui/components';
import type {QualityActionResult} from './quality-detail';

type Action=Exclude<QualityIssueStatus,'stale'>;
/** Kept mounted by issue ID during refreshes: saving a sibling must never
 * discard this issue's note or copy the sibling's status into this form. */
export function QualityIssueResolution({issue,disabled,onResolve}:{issue:QualityIssueView;disabled:boolean;onResolve:(action:Action,note:string)=>Promise<QualityActionResult>}){
 const [action,setAction]=useState<Action>(issue.status==='stale'||issue.status==='open'?'resolved':issue.status);
 const [note,setNote]=useState(issue.note),[result,setResult]=useState<QualityActionResult|null>(null),[pending,setPending]=useState(false);
 const previous=useRef(issue),locked=useRef(false),input=useRef<HTMLTextAreaElement>(null);
 useEffect(()=>{const old=previous.current;if(old.updatedAt!==issue.updatedAt){setNote(current=>current===old.note?issue.note:current);setAction(current=>current===old.status?issue.status==='stale'?'resolved':issue.status:current);}previous.current=issue;},[issue]);
 async function save(){
  if(disabled||locked.current)return;
  if(action!=='open'&&!note.trim()){setResult({ok:false,message:'请填写本问题的处理依据。每个问题单独保存备注，不共用其他问题的处理说明。'});input.current?.focus();return;}
  if(action==='confirmed'&&(issue.sourceChanged||issue.relatedChanged)){setResult({ok:false,message:'本问题的证据已变化，请先重新检查当前内容，再确认本项。'});return;}
  locked.current=true;setPending(true);setResult(null);
  try{setResult(await onResolve(action,note.trim()));}catch(reason){setResult({ok:false,message:(reason as Error).message});}finally{locked.current=false;setPending(false);}
 }
 return <section className="question-quality-item-resolution" aria-label="本项状态处理">
  <Field label="本项处理状态"><select value={action} disabled={disabled||pending} onChange={event=>{setAction(event.target.value as Action);setResult(null);}}>{(['resolved','confirmed','dismissed','open'] as const).map(value=><option value={value} key={value}>{QUALITY_STATUS_LABELS[value]}</option>)}</select></Field>
  <Field label="本项处理依据 / 备注" hint="确认、解决或忽略时填写；只用于当前问题。"><textarea ref={input} rows={2} maxLength={5000} value={note} disabled={disabled||pending} onChange={event=>setNote(event.target.value)}/></Field>
  <div className="quality-actions"><button className="button primary" type="button" disabled={disabled||pending} onClick={()=>void save()}>{pending?'正在保存本项…':'保存本项状态'}</button><span className="muted">当前：{QUALITY_STATUS_LABELS[issue.status]}</span></div>
  {result&&<p className={`notice ${result.ok?'info':'error'}`} role={result.ok?'status':'alert'}>{result.message}</p>}
 </section>;
}
