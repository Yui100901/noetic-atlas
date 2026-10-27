import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle, Square, Check, AlertCircle } from 'lucide-react';
import type { AiProgressUpdate } from '../../../shared/ai/ai-progress';
import { aiRequest } from './ai-api';
import './ai.css';

export interface AiPreviewItem { label: string; text: string }
const previewLabels: Record<string,string> = {title:'标题',description:'说明',summary:'知识块摘要',explanationMarkdown:'解析',followUpsMarkdown:'追问理解',pitfallsMarkdown:'误区与边界',comment:'评价',reason:'推荐理由',stemMarkdown:'题干',message:'服务回复'};
/** Read only human-readable JSON string values, including an unfinished last
 * string. This is a display preview, never a parser or source of saved data. */
export function aiReadablePreview(source: string): AiPreviewItem[] {
  const result: AiPreviewItem[] = []; const keys = /"(title|description|summary|explanationMarkdown|followUpsMarkdown|pitfallsMarkdown|comment|reason|stemMarkdown|message)"\s*:\s*"/g;
  let match: RegExpExecArray | null;
  while ((match = keys.exec(source))) {
    let text = ''; let cursor = keys.lastIndex;
    while (cursor < source.length) {
      const char = source[cursor++]; if (char === '"') break;
      if (char !== '\\') { text += char; continue; }
      if (cursor >= source.length) break;
      const escaped = source[cursor++];
      if (escaped === 'u') { const code = source.slice(cursor, cursor+4); if (!/^[a-fA-F0-9]{4}$/.test(code)) break; text += String.fromCharCode(parseInt(code,16)); cursor += 4; }
      else text += ({n:'\n',r:'\r',t:'\t',b:'\b',f:'\f'} as Record<string,string>)[escaped] ?? escaped;
    }
    keys.lastIndex = cursor;
    if (text.trim()) result.push({label:previewLabels[match[1]], text:text.slice(-6000)});
  }
  return result.slice(-8);
}
export interface AiProgressState {
  status: 'idle'|'running'|'completed'|'cancelled'|'failed';
  startedAt: number; elapsed: number; message: string; stages: string[];
  current?: number; total?: number; preview: AiPreviewItem[];
}
const initial: AiProgressState = {status:'idle',startedAt:0,elapsed:0,message:'',stages:[],preview:[]};
export function useAiProgress() {
  const [progress,setProgress] = useState<AiProgressState>(initial);
  const controller = useRef<AbortController|null>(null); const stream = useRef(''); const flush = useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => {mounted.current = false;controller.current?.abort();clearTimeout(flush.current);}; },[]);
  useEffect(() => {
    if (progress.status !== 'running') return;
    const timer = setInterval(() => setProgress(old => ({...old,elapsed:Date.now()-old.startedAt})),1000);
    return () => clearInterval(timer);
  },[progress.status]);
  const cancel = useCallback(() => {controller.current?.abort();},[]);
  const run = useCallback(async <T,>(url: string, body: unknown): Promise<T> => {
    controller.current?.abort(); clearTimeout(flush.current);
    const active = new AbortController(); controller.current = active; stream.current = '';
    const valid = () => mounted.current && controller.current === active;
    setProgress({...initial,status:'running',startedAt:Date.now(),message:'正在连接 AI 服务…'});
    const onProgress = (event: AiProgressUpdate) => {
      if (!valid() || active.signal.aborted) return;
      if (event.type === 'status') {
        if (event.stage === 'model_start') { stream.current = ''; clearTimeout(flush.current); flush.current = undefined; }
        setProgress(old => ({...old,message:event.message,...(event.current===undefined?{}:{current:event.current}),...(event.total===undefined?{}:{total:event.total}),...(event.stage === 'model_start'?{preview:[]}:{}),stages:old.stages.at(-1) === event.message ? old.stages : [...old.stages,event.message].slice(-12)}));
      }
      else {
        // Bound preview memory independently of the final, validated response.
        if (stream.current.length < 1_000_000) stream.current += event.text.slice(0,1_000_000-stream.current.length);
        if (!flush.current) flush.current = setTimeout(() => {flush.current=undefined;if (valid() && !active.signal.aborted) setProgress(old => ({...old,preview:aiReadablePreview(stream.current)}));},80);
      }
    };
    try {
      const value = await aiRequest<T>(url,body,{signal:active.signal,onProgress});
      if (active.signal.aborted || !valid()) throw new DOMException('已取消本次 AI 请求','AbortError');
      setProgress(old => ({...old,status:'completed',message:'处理完成，结果已校验',elapsed:Date.now()-old.startedAt,preview:[]}));
      return value;
    } catch (error) {
      if (valid()) setProgress(old => ({...old,status:active.signal.aborted?'cancelled':'failed',message:active.signal.aborted?'已取消本次处理，未应用未完成结果':'本次处理失败，未应用未完成结果',elapsed:Date.now()-old.startedAt,preview:aiReadablePreview(stream.current)}));
      throw active.signal.aborted ? new DOMException('已取消本次 AI 请求','AbortError') : error;
    } finally {
      if (valid()) { clearTimeout(flush.current); flush.current = undefined; }
    }
  },[]);
  return {run,cancel,progress};
}

export function aiFailureMessage(error: unknown) { return error instanceof Error && error.name === 'AbortError' ? '' : error instanceof Error ? error.message : 'AI 请求失败，请重试'; }
export function AiProgressPanel({value,cancel,previousResult=false}:{value:AiProgressState;cancel:()=>void;previousResult?:boolean}) {
  if (value.status === 'idle') return null;
  const running = value.status === 'running'; const failed = value.status === 'failed';
  return <section className={`ai-progress ai-progress-${value.status}`} aria-label="AI处理进度" aria-busy={running}>
    <div className="ai-progress-heading"><div role="status" aria-live="polite">{running?<LoaderCircle className="ai-progress-spinner" size={17}/>:failed?<AlertCircle size={17}/>:value.status==='completed'?<Check size={17}/>:<Square size={15}/>}<strong>{value.message}</strong><small>已用时 {Math.floor(value.elapsed/1000)} 秒</small></div>{running&&<button className="button" type="button" onClick={cancel}><Square size={13}/>取消本次处理</button>}</div>
    {running && value.total !== undefined && value.total > 0 && value.current !== undefined && <progress aria-label="AI工作阶段进度" value={value.current} max={value.total}/>}
    {value.stages.length>1&&<details className="ai-progress-stages"><summary>查看本次工作步骤</summary><ol>{value.stages.map((stage,index)=><li key={index}>{stage}</li>)}</ol></details>}
    {previousResult&&value.status!=='completed'&&<p className="muted">本次进度与预览显示在此处；下方保留的是上次已完成结果，待本次处理成功后再替换。</p>}
    {!!value.preview.length&&<div className="ai-stream-preview" aria-label="AI生成中预览"><p className="muted">{running?'生成中预览，待完整结果校验后再使用。':'本次未完成预览，仅供查看。'}{!running&&' 下方如有已完成结果，仍为上次结果。'}</p>{value.preview.map((item,index)=><div key={index}><strong>{item.label}</strong><div className="ai-stream-preview-text">{item.text}</div></div>)}</div>}
  </section>;
}
