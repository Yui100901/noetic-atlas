import {Sparkles} from 'lucide-react';
import type {QualityIssueStatus} from '../../../shared/models/content-quality';
import {QUALITY_STATUS_LABELS} from '../../../shared/models/content-quality';
import {Field} from '../../shared/ui/components';
import {AiServiceNotice} from '../ai/ai-components';
import type {QualityActionResult} from './quality-detail';

type Action=Exclude<QualityIssueStatus,'stale'>;
export function QualityBatchActions({selected,note,onNote,busy,onClear,onResolve,onReview}:{selected:Record<string,string>;note:string;onNote:(note:string)=>void;busy:boolean;onClear:()=>void;onResolve:(entries:Record<string,string>,action:Action,note:string)=>Promise<QualityActionResult>;onReview:(entries:Record<string,string>)=>Promise<QualityActionResult>}){
 const ids=Object.keys(selected);
 return <details className="quality-batch"><summary>批量处理已选问题项（最多100项）</summary><div className="form-stack">
  <p className="muted">勾选题目下的具体问题项。选择可跨题目和分页保留；处理一项不会改变同题其他项。</p>
  <div className="quality-actions"><strong>已选 {ids.length} 项</strong><button className="button" disabled={busy||!ids.length} onClick={onClear}>清空选择</button></div>
  <Field label="批量处理依据 / 备注"><textarea rows={2} maxLength={5000} value={note} disabled={busy} onChange={event=>onNote(event.target.value)}/></Field>
  <div className="quality-actions">{(['confirmed','resolved','dismissed','open'] as const).map(action=><button className="button" key={action} disabled={busy||!ids.length||action!=='open'&&!note.trim()} onClick={()=>void onResolve(selected,action,note)}>{QUALITY_STATUS_LABELS[action]}（{ids.length}）</button>)}</div>
  <AiServiceNotice/><button className="button primary" disabled={busy||!ids.length||ids.length>20} onClick={()=>void onReview(selected)}><Sparkles size={15}/>AI批量复核选中问题（{ids.length}）</button>
  <p className="muted">AI每批最多20项，成功与失败分别留证。确认或解决前请核对证据；原题变化后先重新扫描。</p>
 </div></details>;
}
