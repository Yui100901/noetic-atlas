/** Provider HTTP is separate from local /api fetch, so native clients can use
 * CapacitorHttp without routing credentials through a web CORS proxy. */
export interface AiTransportChunkInfo { status: number; contentType: string }
export interface AiTransportRequest {
  method: 'POST'; headers: Record<string, string>; body: string; timeoutMs: number;
  signal?: AbortSignal;
  /** Real bytes as received. A transport advertising streaming must invoke this
   * before its promise resolves, and return streamed:true when it has done so. */
  onChunk?: (chunk: Uint8Array, info: AiTransportChunkInfo) => void;
  maxResponseBytes?: number;
}
export interface AiTransportResponse { status: number; body: string; contentType?: string; streamed?: boolean }
export type AiTransport = (url: string, options: AiTransportRequest) => Promise<AiTransportResponse>;
let configured: AiTransport | undefined;
let configuredStreaming = false;
export function configureAiTransport(transport?: AiTransport, capabilities: { streaming?: boolean } = {}) {
  configured = transport; configuredStreaming = !!transport && capabilities.streaming === true;
}
export function aiTransportSupportsStreaming() { return !configured || configuredStreaming; }
export async function sendAiRequest(url: string, options: AiTransportRequest): Promise<AiTransportResponse> {
  if (options.signal?.aborted) throw new Error('AI_CANCELLED');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const interrupt = new Promise<never>((_resolve, reject) => {
    abortListener = () => { reject(new Error('AI_CANCELLED')); controller.abort(); };
    options.signal?.addEventListener('abort', abortListener, { once: true });
    timer = setTimeout(() => { reject(new Error('AI_TIMEOUT')); controller.abort(); }, options.timeoutMs);
  });
  const byteLimit = options.maxResponseBytes ?? 2 * 1024 * 1024;
  const sizeError = () => new Error(options.onChunk && byteLimit > 2 * 1024 * 1024 ? 'AI_STREAM_TOO_LARGE' : 'AI_RESPONSE_TOO_LARGE');
  let receivedBytes = 0;
  const onChunk = options.onChunk ? (chunk: Uint8Array, info: AiTransportChunkInfo) => {
    // Buffered native transports cannot necessarily interrupt their network
    // request. Late bytes are ignored after cancellation or timeout as well.
    if (controller.signal.aborted) return;
    receivedBytes += chunk.byteLength;
    if (receivedBytes > byteLimit) throw sizeError();
    options.onChunk!(chunk, info);
  } : undefined;
  const run = async (): Promise<AiTransportResponse> => {
    if (configured) return configured(url, { ...options, signal: controller.signal, onChunk });
    const response = await fetch(url, {
      method: options.method, headers: options.headers, body: options.body,
      signal: controller.signal, redirect: 'error',
    });
    const info = { status: response.status, contentType: response.headers.get('content-type') || '' };
    const reader = response.body?.getReader();
    if (!reader) return { ...info, body: '', streamed: !!onChunk };
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        if (controller.signal.aborted) throw new Error(options.signal?.aborted ? 'AI_CANCELLED' : 'AI_TIMEOUT');
        size += next.value.byteLength;
        if (size > byteLimit) throw sizeError();
        if (onChunk) onChunk(next.value, info); else chunks.push(next.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {}); throw error;
    } finally { reader.releaseLock(); }
    // Streamed responses never retain a second copy of the SSE wire payload.
    if (onChunk) return { ...info, body: '', streamed: true };
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { ...info, body: new TextDecoder().decode(bytes) };
  };
  try {
    const response = await Promise.race([run(), interrupt]);
    if (options.signal?.aborted) throw new Error('AI_CANCELLED');
    if (new TextEncoder().encode(response.body).length > byteLimit) throw sizeError();
    return response;
  } finally {
    if (timer) clearTimeout(timer);
    if (abortListener) options.signal?.removeEventListener('abort', abortListener);
  }
}
