import { Worker } from 'node:worker_threads';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { resolve, dirname, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import type { Store } from '../../core/store.js';
import { ApiError } from '../../core/validation.js';
import { BackgroundTaskManager } from './manager.js';
import { DiskTaskStorage } from './disk-storage.js';
import { commitTaskChanges, taskWasCommitted } from './changes.js';
import type { TaskExecution } from './contracts.js';
import { restorePackageQuestionPreviewContext } from '../transfer/packages.js';

async function discardWorkDirectory(root: string, work: string) {
  if (dirname(resolve(work)) !== resolve(root) || !/^work-[a-z\d]+$/i.test(basename(work)))
    throw Error('Invalid task cleanup path');
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export async function createNodeTaskManager(
  store: Store,
  databasePath: string,
  directory?: string,
) {
  const ephemeral = !directory && databasePath === ':memory:';
  const root = resolve(
    directory ||
      (databasePath === ':memory:'
        ? await mkdtemp(join(tmpdir(), 'atlas-tasks-'))
        : join(dirname(resolve(databasePath)), '.tasks', basename(databasePath))),
  );
  await mkdir(root, { recursive: true, mode: 0o700 });
  // A killed process skips finally. Keep recent directories to avoid touching
  // another running process's private copy when it shares the same database.
  const staleBefore = Date.now() - 24 * 60 * 60_000;
  for (const entry of await readdir(root, { withFileTypes: true }))
    if (entry.isDirectory() && /^work-[a-z\d]+$/i.test(entry.name)) {
      const work = join(root, entry.name);
      try {
        if ((await stat(work)).mtimeMs < staleBefore) await discardWorkDirectory(root, work);
      } catch {
        /* Locked temporary data can be retried on next startup. */
      }
    }
  const manager = new BackgroundTaskManager(new DiskTaskStorage(root), {
    close: async () => {
      if (!ephemeral) return;
      if (dirname(root) !== resolve(tmpdir()) || !/^atlas-tasks-[a-z\d]+$/i.test(basename(root)))
        throw Error('Invalid task cache cleanup path');
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
    committed: async (id) => taskWasCommitted(store, id),
    commit: async (id, execution) => {
      if (execution.changes?.patches.length) commitTaskChanges(store, id, execution.changes);
      if (execution.context?.packagePreview)
        restorePackageQuestionPreviewContext(store, execution.context.packagePreview);
    },
    async execute(_id, input, signal, progress) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const work = await mkdtemp(join(root, 'work-'));
      try {
        signal.throwIfAborted();
        progress({ stage: 'snapshot', message: '正在创建一致性工作副本' });
        const path = join(work, 'working.sqlite');
        await store.database.backupTo(path);
        signal.throwIfAborted();
        return await new Promise<TaskExecution>((done, reject) => {
          const source = import.meta.url.endsWith('.ts');
          // Workers cannot inherit CLI-only flags (--input-type/--test), and a
          // source checkout needs its own TS loader rather than a stripped TS
          // entry whose internal .js imports have not been compiled yet.
          const worker = new Worker(
            new URL(source ? './worker.ts' : './worker.js', import.meta.url),
            {
              execArgv: source ? ['--import', import.meta.resolve('tsx')] : [],
              workerData: { path, input },
            },
          );
          let finished = false;
          const abort = () => {
            if (!finished) {
              finished = true;
              void worker
                .terminate()
                .finally(() => reject(new DOMException('任务已取消', 'AbortError')));
            }
          };
          signal.addEventListener('abort', abort, { once: true });
          const cleanup = () => signal.removeEventListener('abort', abort);
          worker.on('message', (message) => {
            if (finished) return;
            if (message.type === 'progress') progress(message.value);
            else if (message.type === 'result') {
              finished = true;
              cleanup();
              void worker.terminate().then(() => done(message.execution), reject);
            } else if (message.type === 'failure') {
              finished = true;
              cleanup();
              void worker
                .terminate()
                .finally(() =>
                  reject(
                    new ApiError(500, 'TASK_WORKER_FAILED', '后台处理失败，请检查任务输入后重试'),
                  ),
                );
            }
          });
          worker.on('error', () => {
            if (!finished) {
              finished = true;
              cleanup();
              reject(
                new ApiError(
                  500,
                  'TASK_WORKER_FAILED',
                  '独立处理进程无法运行，请检查可用内存或重新启动应用',
                ),
              );
            }
          });
          worker.on('exit', (code) => {
            if (!finished) {
              finished = true;
              cleanup();
              reject(new ApiError(500, 'TASK_WORKER_EXIT', '处理进程提前结束，请重试'));
            }
            void code;
          });
          if (signal.aborted) abort();
        });
      } finally {
        await discardWorkDirectory(root, work);
      }
    },
  });
  await manager.initialize();
  return manager;
}
