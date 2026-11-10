import { isNativeApp, nativeFetch, saveGeneratedFile } from '@platform';
import { base64ToBytes } from '../../../shared/assets/assets';
import {
  taskOperationAllowed,
  terminalTask,
  type BackgroundTask,
  type TaskInput,
  type TaskResult,
} from '../../../shared/tasks/tasks';

let enabled = false;
let tasks: BackgroundTask[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let refreshing: Promise<void> | undefined;
let revision = 0;
const listeners = new Set<() => void>();
export const isTasksEnabled = () => enabled;
export const getTasks = () => tasks;
export function subscribeTasks(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const publish = () => {
  for (const listener of listeners) listener();
};
export function taskFetch(path: string, options: RequestInit = {}) {
  return isNativeApp() ? nativeFetch(path, options) : fetch(path, options);
}
async function readError(response: Response) {
  const body = await response.json().catch(() => undefined);
  const error = body?.error;
  return Object.assign(Error(error?.message || `后台任务请求失败（${response.status}）`), {
    code: error?.code || 'TASK_REQUEST_FAILED',
    status: response.status,
    details: error?.details,
  });
}
async function json<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await taskFetch(path, {
    method,
    signal,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw await readError(response);
  return response.json();
}
function schedule() {
  clearTimeout(timer);
  if (enabled)
    timer = setTimeout(
      () => {
        void refreshTasks().catch(() => {});
      },
      tasks.some((task) => !terminalTask(task)) ? 1000 : 15000,
    );
}
export function setTasksEnabled(value: boolean) {
  if (enabled === value) return;
  enabled = value;
  revision++;
  if (value) void refreshTasks().catch(() => {});
  else {
    clearTimeout(timer);
    tasks = [];
    publish();
  }
}
export async function refreshTasks() {
  if (!enabled) return;
  if (refreshing) return refreshing;
  const currentRevision = revision;
  refreshing = json<BackgroundTask[]>('/api/tasks')
    .then((next) => {
      if (!enabled || currentRevision !== revision) return;
      const previous = new Map(tasks.map((task) => [task.id, task]));
      tasks = next;
      publish();
      for (const task of tasks) {
        const old = previous.get(task.id);
        if (
          old &&
          terminalTask(task) &&
          !task.read &&
          (old.status !== task.status || old.attempt !== task.attempt)
        ) {
          window.dispatchEvent(new CustomEvent('atlas-task-finished', { detail: task }));
        }
      }
    })
    .finally(() => {
      refreshing = undefined;
      schedule();
    });
  return refreshing;
}
export async function startBackgroundTask(input: TaskInput) {
  const task = await json<BackgroundTask>('/api/tasks', 'POST', {
    ...input,
    returnTo: input.returnTo || window.location.hash || '#/',
  });
  revision++;
  tasks = [task, ...tasks.filter((item) => item.id !== task.id)];
  publish();
  schedule();
  return task;
}
const taskPath = (id: string) => `/api/tasks/${encodeURIComponent(id)}`;
export const getTask = (id: string, signal?: AbortSignal) =>
  json<BackgroundTask>(taskPath(id), 'GET', undefined, signal);
export const taskResult = (id: string, signal?: AbortSignal) =>
  json<TaskResult>(`${taskPath(id)}/result`, 'GET', undefined, signal);
export const taskInput = (id: string, signal?: AbortSignal) =>
  json<TaskInput>(`${taskPath(id)}/input`, 'GET', undefined, signal);
export async function taskDownload(id: string, signal?: AbortSignal) {
  const response = await taskFetch(`${taskPath(id)}/download`, { signal });
  if (!response.ok) throw await readError(response);
  return response;
}
export async function downloadTaskFile(
  id: string,
  filename: string,
  mime: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (isNativeApp()) {
    const response = await taskDownload(id, signal);
    const bytes = new Uint8Array(await response.arrayBuffer());
    signal?.throwIfAborted();
    await saveGeneratedFile(filename, bytes, mime);
    return;
  }
  // Same-origin HTTP downloads stream from disk into the browser's downloader.
  const link = document.createElement('a');
  link.href = `${taskPath(id)}/download`;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
}
async function changeTask(id: string, action: 'cancel' | 'retry' | 'read') {
  const task = await json<BackgroundTask>(`${taskPath(id)}/${action}`, 'POST', {});
  revision++;
  if (action === 'retry' || action === 'read') {
    tasks = tasks.map((item) => (item.id === id ? task : item));
    publish();
  }
  schedule();
}
export const cancelTask = (id: string) => changeTask(id, 'cancel');
export const retryTask = (id: string) => changeTask(id, 'retry');
export const markTaskRead = (id: string) => changeTask(id, 'read');
export async function removeTask(id: string) {
  await json(taskPath(id), 'DELETE');
  revision++;
  tasks = tasks.filter((task) => task.id !== id);
  publish();
  schedule();
}
function nextPoll(signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const stop = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      stop();
      reject(new DOMException('已停止观察，任务仍保留在后台', 'AbortError'));
    };
    const timeout = setTimeout(() => {
      stop();
      resolve();
    }, 700);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
export async function waitForTaskResult(
  id: string,
  onProgress?: (task: BackgroundTask) => void,
  signal?: AbortSignal,
): Promise<TaskResult> {
  for (;;) {
    signal?.throwIfAborted();
    const task = await getTask(id, signal);
    onProgress?.(task);
    if (task.status === 'completed') return taskResult(id, signal);
    if (task.status === 'cancelled') throw new DOMException(task.message, 'AbortError');
    if (terminalTask(task))
      throw Object.assign(Error(task.error?.message || task.message), {
        code: task.error?.code || 'TASK_INTERRUPTED',
        status: task.error?.status || 409,
      });
    await nextPoll(signal);
  }
}
export async function waitForTask<T = unknown>(
  id: string,
  onProgress?: (task: BackgroundTask) => void,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const result = await waitForTaskResult(id, onProgress, options.signal);
  return result.json as T;
}

/** Aborting a request detaches its observer. The durable operation can be cancelled in the task center. */
export async function backgroundResponse(url: string, options: RequestInit): Promise<Response> {
  options.signal?.throwIfAborted();
  const body = typeof options.body === 'string' ? JSON.parse(options.body) : undefined;
  const task = await startBackgroundTask({
    operation: url,
    method: (options.method || 'GET').toUpperCase() as 'GET' | 'POST',
    body,
  });
  window.dispatchEvent(
    new CustomEvent('atlas-task-started', { detail: { id: task.id, operation: url } }),
  );
  const result = await waitForTaskResult(task.id, undefined, options.signal || undefined);
  options.signal?.throwIfAborted();
  if (result.binaryByteLength !== undefined)
    return taskDownload(task.id, options.signal || undefined);
  return new Response(
    result.binaryBase64
      ? base64ToBytes(result.binaryBase64).slice().buffer
      : JSON.stringify(result.json),
    {
      status: result.status,
      headers: { 'Content-Type': result.contentType },
    },
  );
}
export function shouldBackground(url: string, options: RequestInit) {
  return enabled && taskOperationAllowed(url, (options.method || 'GET').toUpperCase());
}
