import type { TaskExecution } from '../../server/modules/tasks/contracts';
import type { TaskInput, TaskProgress } from '../../shared/tasks/tasks';
import { sendAiRequest } from '../../shared/ai/ai-transport';
/** Plugins stay on the main thread. The isolated worker only handles content
 * and sends provider requests through the already configured native transport. */
export function executeNativeTask(
  bytes: Uint8Array,
  input: TaskInput,
  signal: AbortSignal,
  progress: (value: TaskProgress) => void,
): Promise<TaskExecution> {
  return new Promise((done, reject) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    let finished = false;
    const cleanup = () => {
      signal.removeEventListener('abort', abort);
      worker.terminate();
    };
    const abort = () => {
      if (!finished) {
        finished = true;
        cleanup();
        reject(new DOMException('任务已取消', 'AbortError'));
      }
    };
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event) => {
      const message = event.data;
      if (finished) return;
      if (message.type === 'progress') progress(message.value);
      else if (message.type === 'ai-http') {
        void sendAiRequest(message.url, { ...message.options, signal })
          .then((value) => {
            if (!finished) worker.postMessage({ type: 'ai-http-result', id: message.id, value });
          })
          .catch(() => {
            if (!finished)
              worker.postMessage({
                type: 'ai-http-result',
                id: message.id,
                error: 'AI_NETWORK_ERROR',
              });
          });
      } else if (message.type === 'result') {
        finished = true;
        cleanup();
        done(message.execution);
      } else if (message.type === 'failure') {
        finished = true;
        cleanup();
        reject(Error('后台处理未完成'));
      }
    };
    worker.onerror = () => {
      if (!finished) {
        finished = true;
        cleanup();
        reject(Error('独立处理线程无法运行，请检查可用内存'));
      }
    };
    worker.postMessage({ type: 'start', bytes, input }, [bytes.buffer as ArrayBuffer]);
    if (signal.aborted) abort();
  });
}
