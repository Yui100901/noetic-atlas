import type { Attempt } from '../../../shared/models/types';
import type { AiRun } from '../../../shared/ai/ai';
import { ApiError, idPath, send } from '../../shared/lib/api';
import { AI_PROGRESS_HEADER, subscribeNativeAiProgress, type AiProgressUpdate, type AiStreamEvent } from '../../../shared/ai/ai-progress';
import { isNativeApp, nativeFetch } from '@platform';
import { createSseParser } from '../../../shared/ai/sse';
import { aiResponseErrorInfo, type AiErrorPayload } from './ai-error';

// View contracts mirror the local AI service; provider credentials never enter results.
export type { AiSettings as AiSettingsView, AiExplanation as AiExplanationResult, AiGradeItem, AiGradeResult, AiImportResult, AiReviewItem, AiReviewResult } from '../../../shared/ai/ai';
/** Result tools only receive completed runs. History uses the complete AiRun union. */
export type AiRunView<Result = unknown> = Extract<AiRun<Result>, { status: 'completed' }>;
export const aiRunApply = <Result=unknown>(id:string, options:{applyScores?:boolean;appendNotes?:boolean;questionIds?:string[]}) => send<{attempt?:Attempt;run:AiRunView<Result>}>(`/api/ai/runs/${idPath(id)}/apply`, 'POST', { confirmed:true, ...options });

export interface AiRequestOptions { onProgress?: (event: AiProgressUpdate) => void; signal?: AbortSignal }
function aborted(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException('已取消本次 AI 请求', 'AbortError'); }
function responseError(error: AiErrorPayload | undefined, status = 500) {
  const info=aiResponseErrorInfo(error,status);
  return new ApiError(info.message,info.code,info.status,info.details);
}

/** SSE is an HTTP transport only. Native local requests use the same progress
 * events in process, and never keep an extra SQLite request open for polling. */
export async function aiRequest<T>(url: string, body: unknown, options: AiRequestOptions = {}): Promise<T> {
  const {signal, onProgress} = options; aborted(signal);
  const headers = new Headers({'Content-Type': 'application/json', Accept: 'text/event-stream'});
  let unsubscribe: (() => void) | undefined;
  if (isNativeApp()) {
    const id = crypto.randomUUID();
    headers.set('Accept', 'application/json'); headers.set(AI_PROGRESS_HEADER, id);
    unsubscribe = subscribeNativeAiProgress(id, event => { if (!signal?.aborted) onProgress?.(event); }, signal);
  }
  const forward = (event: AiProgressUpdate) => { aborted(signal); onProgress?.(event); };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancelReader = () => { void reader?.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', cancelReader, {once:true});
  try {
    const response = await (isNativeApp() ? nativeFetch : fetch)(url, {method:'POST', headers, body:JSON.stringify(body), signal});
    aborted(signal);
    if (!response.ok) {
      let payload: any; try { payload = await response.json(); } catch { /* Keep the HTTP status if the proxy returned HTML. */ }
      throw responseError(payload?.error, response.status);
    }
    if (!response.headers.get('Content-Type')?.toLowerCase().includes('text/event-stream')) {
      const result = await response.json(); aborted(signal); return result as T;
    }
    if (!response.body) throw new ApiError('AI 流式响应为空，请重试', 'AI_STREAM_INCOMPLETE', 502);
    reader = response.body.getReader();
    let received = false; let result: T | undefined; let bytes = 0;
    const parser = createSseParser(({data:payload}) => {
      if (!payload || received) return;
      let event: AiStreamEvent<T>; try { event = JSON.parse(payload); } catch { throw new ApiError('AI 进度响应格式错误，请重试', 'AI_STREAM_INVALID', 502); }
      if (!event || typeof event !== 'object' || typeof event.type !== 'string') throw new ApiError('AI 进度响应格式错误，请重试', 'AI_STREAM_INVALID', 502);
      if (event.type === 'error') throw responseError(event.error, event.error?.statusCode || 502);
      if (event.type === 'result') {
        if (!Object.hasOwn(event,'result')) throw new ApiError('AI 完成响应缺少结果，请重试', 'AI_STREAM_INVALID', 502);
        received = true; result = event.result;
      }
      else if (event.type === 'status' && typeof event.message === 'string' && typeof event.stage === 'string') forward(event);
      else if (event.type === 'delta' && typeof event.text === 'string') forward(event);
    });
    while (!received) {
      const chunk = await reader.read(); aborted(signal);
      if (chunk.done) { parser.finish(); break; }
      // Includes the final structured result, while bounding a broken stream
      // whose frame delimiters never arrive.
      bytes += chunk.value.byteLength;
      if (bytes > 16_000_000) throw new ApiError('AI 进度响应过大，请缩小本次范围后重试', 'AI_STREAM_INVALID', 502);
      parser.push(chunk.value);
    }
    aborted(signal);
    if (!received) throw new ApiError('AI 响应意外中断，未应用未完成结果，请重试', 'AI_STREAM_INCOMPLETE', 502);
    return result as T;
  } finally {
    signal?.removeEventListener('abort', cancelReader); unsubscribe?.();
    if (reader) { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
}
