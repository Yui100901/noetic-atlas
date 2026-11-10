import { exportPackageQuestionPreviewContext } from '../../server/modules/transfer/packages';
import initSqlJs from 'sql.js';
import { createLocalRuntime } from '../runtime';
import { configureAiTransport, type AiTransportResponse } from '../../shared/ai/ai-transport';
import { subscribeNativeAiProgress, AI_PROGRESS_HEADER } from '../../shared/ai/ai-progress';
import { taskSnapshot } from '../../server/modules/tasks/changes';
import type { Store } from '../../server/core/store';
import type { TaskInput, TaskResult } from '../../shared/tasks/tasks';

const requests = new Map<
  string,
  { resolve: (value: AiTransportResponse) => void; reject: (reason: Error) => void }
>();
configureAiTransport(
  (url, options) =>
    new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      requests.set(id, { resolve, reject });
      self.postMessage({
        type: 'ai-http',
        id,
        url,
        options: {
          method: options.method,
          headers: options.headers,
          body: options.body,
          timeoutMs: options.timeoutMs,
          maxResponseBytes: options.maxResponseBytes,
        },
      });
    }),
);
self.onmessage = async (event: MessageEvent) => {
  const message = event.data;
  if (message.type === 'ai-http-result') {
    const entry = requests.get(message.id);
    if (entry) {
      requests.delete(message.id);
      if (message.error) entry.reject(Error(message.error));
      else entry.resolve(message.value);
    }
    return;
  }
  if (message.type !== 'start') return;
  let store: Store | undefined,
    bytes = message.bytes as Uint8Array;
  const input = message.input as TaskInput;
  try {
    const sql = await initSqlJs({ locateFile: () => '/sql-wasm.wasm' });
    const runtime = await createLocalRuntime(
      sql,
      undefined,
      {
        load: async () => bytes,
        save: async (value) => {
          bytes = value;
        },
      },
      {
        dailyPushScheduler: false,
        onStore: (value) => {
          store = value;
        },
      },
    );
    const snapshot = taskSnapshot(store!, input.operation, input.body);
    const unsubscribe = subscribeNativeAiProgress('background-worker', (value) => {
      self.postMessage({
        type: 'progress',
        value: value.type === 'status' ? value : { delta: value.text },
      });
    });
    try {
      self.postMessage({
        type: 'progress',
        value: { stage: 'processing', message: '正在独立线程处理，可继续浏览其他页面' },
      });
      const response = await runtime.fetch(input.operation, {
        method: input.method || 'POST',
        headers: { 'Content-Type': 'application/json', [AI_PROGRESS_HEADER]: 'background-worker' },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      });
      const contentType = response.headers.get('Content-Type') || 'application/json',
        result: TaskResult = { status: response.status, contentType };
      let binary: Uint8Array<ArrayBuffer> | undefined;
      if (contentType.includes('json')) result.json = await response.json();
      else {
        binary = new Uint8Array(await response.arrayBuffer());
        result.binaryByteLength = binary.byteLength;
      }
      result.filename = response.headers
        .get('Content-Disposition')
        ?.match(/filename="([^"]+)"/)?.[1];
      const context =
        input.operation === '/api/packages/preview' && response.ok
          ? {
              packagePreview: exportPackageQuestionPreviewContext(
                store!,
                String((result.json as { fingerprint?: string })?.fingerprint || ''),
              ),
            }
          : undefined;
      self.postMessage(
        { type: 'result', execution: { result, binary, changes: snapshot.finish(), context } },
        { transfer: binary ? [binary.buffer] : [] },
      );
    } finally {
      unsubscribe();
      await runtime.close();
    }
  } catch {
    self.postMessage({ type: 'failure' });
  }
};
