/** Public execution updates contain work stages and answer text, never private
 * model reasoning, provider diagnostics, configuration or credentials. */
export type AiProgressUpdate =
  | { type: 'status'; stage: string; message: string; current?: number; total?: number }
  | { type: 'delta'; text: string };
export type AiStreamEvent<T = unknown> = AiProgressUpdate
  | { type: 'result'; result: T }
  | { type: 'error'; error: { code: string; message: string; statusCode?: number; details?: unknown } };
/** Telemetry never enters the stream. Only bounded metadata may be recorded. */
export type AiTelemetryEvent =
  | { type: 'provider_start'; model: string; inputBytes: number }
  | { type: 'provider_update'; phase?: string; outputBytes?: number; httpStatus?: number; finishReason?: string }
  | { type: 'provider_end'; ok: boolean; code?: string };
export interface AiExecutionContext { emit(event: AiProgressUpdate): void; signal?: AbortSignal; streaming?: boolean; telemetry?(event: AiTelemetryEvent): void }
export const AI_PROGRESS_HEADER = 'x-atlas-ai-progress';

// The Android API and UI share one process. This channel avoids extra local
// HTTP requests while its serialized SQLite mutation awaits durable storage.
// Desktop/web use actual SSE; native bridge transports can report real stages.
const nativeObservers = new Map<string, { listener: (event: AiProgressUpdate) => void; signal?: AbortSignal }>();
export function subscribeNativeAiProgress(id: string, listener: (event: AiProgressUpdate) => void, signal?: AbortSignal) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid AI progress identifier');
  const entry={listener,signal};nativeObservers.set(id, entry);
  return () => { if (nativeObservers.get(id) === entry) nativeObservers.delete(id); };
}
export function nativeAiProgress(id: string | undefined) { return id ? nativeObservers.get(id)?.listener : undefined; }
export function nativeAiProgressSignal(id: string | undefined) { return id ? nativeObservers.get(id)?.signal : undefined; }
