import { parentPort, workerData } from 'node:worker_threads';
import { dirname } from 'node:path';
import { buildApp } from '../../index.js';
import type { Store } from '../../core/store.js';
import { taskSnapshot } from './changes.js';
import { AI_PROGRESS_HEADER, subscribeNativeAiProgress } from '../../../shared/ai/ai-progress.js';
import type { TaskInput, TaskResult } from '../../../shared/tasks/tasks.js';
import { exportPackageQuestionPreviewContext } from '../transfer/packages.js';
import type { TaskExecution } from './contracts.js';

const input = workerData.input as TaskInput;
// Use the task directory for migration scratch after the source loader has
// initialized its shared compile cache. Worker environment changes are local.
const workDirectory = dirname(workerData.path);
process.env.TMPDIR = workDirectory;
process.env.TEMP = workDirectory;
process.env.TMP = workDirectory;
let store: Store | undefined;
const app = await buildApp({
  databasePath: workerData.path,
  logger: false,
  native: true,
  dailyPushScheduler: false,
  onStore: (value) => {
    store = value;
  },
});
const before = taskSnapshot(store!, input.operation, input.body),
  progressId = 'task-progress';
const unsubscribe = subscribeNativeAiProgress(progressId, (event) => {
  parentPort?.postMessage({
    type: 'progress',
    value: event.type === 'status' ? event : { delta: event.text },
  });
});
let execution: TaskExecution | undefined;
let transferable: ArrayBuffer | undefined;
try {
  parentPort?.postMessage({
    type: 'progress',
    value: {
      stage: 'processing',
      message: input.operation.includes('/ai/')
        ? '正在分批处理AI任务'
        : '正在解析、校验并处理工作副本，可继续浏览其他页面',
    },
  });
  const response = await app.inject({
    url: input.operation,
    method: input.method || 'POST',
    ...(input.body === undefined ? {} : { payload: input.body as object }),
    headers: { [AI_PROGRESS_HEADER]: progressId },
  });
  const contentType = String(response.headers['content-type'] || 'application/json');
  const result: TaskResult = { status: response.statusCode, contentType };
  let binary: Uint8Array | undefined;
  if (contentType.includes('json')) result.json = response.json();
  else {
    const raw = response.rawPayload;
    binary =
      raw.byteOffset === 0 &&
      raw.buffer.byteLength === raw.byteLength &&
      raw.buffer instanceof ArrayBuffer
        ? raw
        : Uint8Array.from(raw);
    transferable = binary.buffer as ArrayBuffer;
  }
  const disposition = response.headers['content-disposition'];
  if (typeof disposition === 'string')
    result.filename = disposition.match(/filename="([^"]+)"/)?.[1];
  const packagePreview =
    input.operation === '/api/packages/preview' && result.status < 400
      ? exportPackageQuestionPreviewContext(
          store!,
          String((result.json as { fingerprint?: string })?.fingerprint || ''),
        )
      : undefined;
  execution = {
    result,
    binary,
    changes: before.finish(),
    ...(packagePreview ? { context: { packagePreview } } : {}),
  };
} catch {
  /* Never expose a private request, provider key or file path. */
} finally {
  unsubscribe();
  await app.close();
}
if (execution)
  parentPort?.postMessage({ type: 'result', execution }, transferable ? [transferable] : []);
else parentPort?.postMessage({ type: 'failure', code: 'TASK_WORKER_FAILED' });
