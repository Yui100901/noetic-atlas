import type { TaskStorage } from '../../server/modules/tasks/contracts';
import type { BackgroundTask, TaskInput, TaskResult } from '../../shared/tasks/tasks';
/** Device-local task cache, separate from the learning DB and backup snapshot. */
export class IndexedTaskStorage implements TaskStorage {
  private database?: Promise<IDBDatabase>;
  constructor(private name = 'noetic-atlas-background-tasks') {}
  private open() {
    return (this.database ??= new Promise<IDBDatabase>((done, reject) => {
      const request = indexedDB.open(this.name, 2);
      request.onupgradeneeded = () => {
        for (const name of ['tasks', 'inputs', 'results', 'files'])
          if (!request.result.objectStoreNames.contains(name))
            request.result.createObjectStore(name);
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => request.result.close();
        done(request.result);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(Error('其他页面正在使用旧版任务缓存，请关闭后重试'));
    }));
  }
  private async read<T>(name: string, id?: string): Promise<T> {
    const db = await this.open();
    return new Promise((done, reject) => {
      const request =
        id === undefined
          ? db.transaction(name).objectStore(name).getAll()
          : db.transaction(name).objectStore(name).get(id);
      request.onsuccess = () => done(request.result as T);
      request.onerror = () => reject(request.error);
    });
  }
  private async write(name: string, id: string, value: unknown, remove = false) {
    const db = await this.open();
    await new Promise<void>((done, reject) => {
      const tx = db.transaction(name, 'readwrite');
      if (remove) tx.objectStore(name).delete(id);
      else tx.objectStore(name).put(value, id);
      tx.oncomplete = () => done();
      tx.onabort = tx.onerror = () => reject(tx.error || Error('无法保存后台任务'));
    });
  }
  list() {
    return this.read<BackgroundTask[]>('tasks');
  }
  save(task: BackgroundTask) {
    return this.write('tasks', task.id, task);
  }
  input(id: string) {
    return this.read<TaskInput>('inputs', id);
  }
  saveInput(id: string, input: TaskInput) {
    return this.write('inputs', id, input);
  }
  result(id: string) {
    return this.read<TaskResult | undefined>('results', id);
  }
  saveResult(id: string, result: TaskResult) {
    return this.write('results', id, result);
  }
  binary(id: string) {
    return this.read<Uint8Array | undefined>('files', id);
  }
  saveBinary(id: string, bytes: Uint8Array) {
    return this.write('files', id, bytes);
  }
  deleteBinary(id: string) {
    return this.write('files', id, null, true);
  }
  async remove(id: string) {
    const db = await this.open();
    const stores = ['tasks', 'inputs', 'results', 'files'];
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(stores, 'readwrite');
      for (const name of stores) transaction.objectStore(name).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || Error('无法删除后台任务缓存'));
    });
  }
}
