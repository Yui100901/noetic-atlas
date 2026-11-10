import { mkdir, open, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import type { TaskStorage } from './contracts.js';
import type { BackgroundTask, TaskInput, TaskResult } from '../../../shared/tasks/tasks.js';
import { ApiError } from '../../core/validation.js';

const statuses = new Set([
  'queued',
  'running',
  'committing',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
const transientRenameCodes = new Set(['EACCES', 'EPERM', 'EBUSY']);

async function replaceFile(temporary: string, path: string, signal?: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      await rename(temporary, path);
      return;
    } catch (error) {
      // Windows file scanners may briefly hold the destination after a write.
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || attempt === 4 || !code || !transientRenameCodes.has(code))
        throw error;
      await delay(30 * (attempt + 1), undefined, { signal });
    }
  }
}
function validSummary(value: unknown, id: string): value is BackgroundTask {
  if (!value || typeof value !== 'object') return false;
  const task = value as BackgroundTask;
  return (
    task.id === id &&
    typeof task.title === 'string' &&
    typeof task.operation === 'string' &&
    statuses.has(task.status) &&
    typeof task.createdAt === 'string' &&
    Number.isFinite(Date.parse(task.createdAt)) &&
    typeof task.updatedAt === 'string' &&
    Number.isFinite(Date.parse(task.updatedAt)) &&
    Number.isInteger(task.total) &&
    task.total > 0 &&
    Number.isInteger(task.completedSteps) &&
    task.completedSteps >= 0 &&
    task.completedSteps <= task.total
  );
}

/** Private task cache adjacent to the installation DB, never public assets. */
export class DiskTaskStorage implements TaskStorage {
  constructor(readonly root: string) {}
  private path(id: string, kind: string) {
    if (!/^task-[a-f0-9-]{36}$/.test(id)) throw Error('Invalid task identifier');
    const target = resolve(this.root, `${id}.${kind}`);
    if (dirname(target) !== resolve(this.root)) throw Error('Invalid task path');
    return target;
  }
  private async readBytes(path: string) {
    try {
      return await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
  private async write(path: string, data: string | Uint8Array, signal?: AbortSignal) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = path + '.tmp';
    try {
      await writeFile(temporary, data, { mode: 0o600, signal });
      await replaceFile(temporary, path, signal);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
  private async load<T>(id: string, kind: string): Promise<T | undefined> {
    const bytes = await this.readBytes(this.path(id, kind + '.json'));
    return bytes ? (JSON.parse(bytes.toString('utf8')) as T) : undefined;
  }
  private put(id: string, kind: string, data: unknown) {
    return this.write(this.path(id, kind + '.json'), JSON.stringify(data));
  }
  async list() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const result: BackgroundTask[] = [];
    for (const name of await readdir(this.root))
      if (/^task-[a-f0-9-]{36}\.task\.json$/.test(name)) {
        const id = name.slice(0, -'.task.json'.length);
        try {
          const task = await this.load<BackgroundTask>(id, 'task');
          if (!task) continue;
          if (!validSummary(task, id)) throw Error('Invalid task metadata');
          result.push(task);
        } catch (error) {
          // One interrupted write must not prevent the app from starting. Retain
          // the original file and surface a removable failure in the task center.
          if ((error as NodeJS.ErrnoException).code === 'EACCES') throw error;
          const date = new Date().toISOString();
          result.push({
            id,
            title: '任务缓存损坏',
            operation: '',
            method: 'POST',
            returnTo: '#/tasks',
            status: 'failed',
            stage: 'recovery',
            message: '任务缓存无法读取，请移除此记录并重新提交任务',
            current: 0,
            total: 1,
            completedSteps: 0,
            attempt: 1,
            cancellable: false,
            createdAt: date,
            updatedAt: date,
            read: false,
            error: {
              code: 'TASK_CACHE_CORRUPT',
              message: '任务缓存无法读取，请移除此记录并重新提交任务',
            },
          });
        }
      }
    return result;
  }
  save(task: BackgroundTask) {
    return this.put(task.id, 'task', task);
  }
  async input(id: string) {
    try {
      const input = await this.load<TaskInput>(id, 'input');
      if (!input || typeof input.operation !== 'string') throw Error('Task input missing');
      return input;
    } catch {
      throw new ApiError(410, 'TASK_INPUT_MISSING', '任务输入缓存已缺失或损坏，请重新提交原操作');
    }
  }
  saveInput(id: string, input: TaskInput) {
    return this.put(id, 'input', input);
  }
  result(id: string) {
    return this.load<TaskResult>(id, 'result');
  }
  saveResult(id: string, result: TaskResult) {
    return this.put(id, 'result', result);
  }
  binary(id: string) {
    return this.readBytes(this.path(id, 'result.bin'));
  }
  async openBinary(id: string) {
    try {
      const file = await open(this.path(id, 'result.bin'), 'r');
      return Readable.toWeb(file.createReadStream(), {
        strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength },
      }) as ReadableStream<Uint8Array>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
  saveBinary(id: string, bytes: Uint8Array, signal?: AbortSignal) {
    return this.write(this.path(id, 'result.bin'), bytes, signal);
  }
  deleteBinary(id: string) {
    return rm(this.path(id, 'result.bin'), { force: true });
  }
  async remove(id: string) {
    for (const kind of ['input.json', 'result.json', 'result.bin', 'task.json'])
      await rm(this.path(id, kind), { force: true });
  }
}
