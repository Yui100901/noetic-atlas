import type { FastifyReply, FastifyRequest } from 'fastify';
import { AI_PROGRESS_HEADER, nativeAiProgress, nativeAiProgressSignal, type AiExecutionContext, type AiStreamEvent } from '../../../shared/ai/ai-progress.js';
import { ApiError, fail } from '../../core/validation.js';

/** Check after any provider await and immediately before publishing a run or
 * changing a question. A disconnected client must not complete background edits. */
export function assertAiActive(context?: AiExecutionContext) {
  if (context?.signal?.aborted) fail(499, 'AI_CANCELLED', 'AI 任务已取消，未保存本次结果');
}

function acceptsEvents(value: string | undefined) {
  return value?.split(',').some(part => {
    const [mime, ...parameters] = part.trim().toLowerCase().split(';');
    return mime === 'text/event-stream' && !parameters.some(p => /^\s*q\s*=\s*0(?:\.0*)?\s*$/.test(p));
  }) ?? false;
}

/** JSON remains the default contract. Web and desktop can opt into SSE;
 * Android uses an in-process progress observer while still awaiting its full
 * JSON response and durable database commit in mobile/runtime. */
export async function runAiAction<T>(request: FastifyRequest, reply: FastifyReply, operation: (context?: AiExecutionContext) => Promise<T>, options: { native?: boolean } = {}): Promise<T | void> {
  if (options.native) {
    const header = request.headers[AI_PROGRESS_HEADER];
    const progressId = typeof header === 'string' ? header : undefined;
    const listener = nativeAiProgress(progressId), signal = nativeAiProgressSignal(progressId);
    const context: AiExecutionContext | undefined = listener ? { signal, emit: event => { try { listener(event); } catch { /* An observer cannot fail a database operation. */ } } } : undefined;
    assertAiActive(context);
    context?.emit({ type: 'status', stage: 'preparing', message: '正在准备 AI 任务' });
    return operation(context);
  }
  if (!acceptsEvents(request.headers.accept)) return operation();

  const controller = new AbortController();
  const raw = reply.raw;
  const abort = () => { if (!raw.writableFinished) controller.abort(); };
  raw.on('close', abort);
  request.raw.on('aborted', abort);
  // Retain security headers installed by the application hooks. Raw response
  // access is confined to this optional HTTP transport, never business logic.
  reply.hijack();
  for (const [name, value] of Object.entries(reply.getHeaders())) if (value !== undefined) raw.setHeader(name, value);
  raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-store, no-transform', 'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no' });
  raw.flushHeaders();
  const send = (event: AiStreamEvent<T>) => {
    if (!controller.signal.aborted && !raw.destroyed && !raw.writableEnded) raw.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const context: AiExecutionContext = { signal: controller.signal, emit: send };
  const heartbeat = setInterval(() => { if (!raw.destroyed && !raw.writableEnded) raw.write(': keep-alive\n\n'); }, 15_000);
  heartbeat.unref?.();
  try {
    assertAiActive(context);
    send({ type: 'status', stage: 'preparing', message: '正在准备 AI 任务' });
    const result = await operation(context);
    assertAiActive(context);
    send({ type: 'result', result });
  } catch (error) {
    if (!controller.signal.aborted) {
      // Never expose provider response bodies, stack traces, source material,
      // keys or raw validation details in the public event channel.
      const safe = error instanceof ApiError
        ? { code: error.code, message: error.message, statusCode: error.status }
        : { code: 'INTERNAL_ERROR', message: 'AI 任务未完成，请检查本地服务日志', statusCode: 500 };
      send({ type: 'error', error: safe });
    }
  } finally {
    clearInterval(heartbeat);
    raw.off('close', abort);
    request.raw.off('aborted', abort);
    if (!raw.destroyed && !raw.writableEnded) raw.end();
  }
}
