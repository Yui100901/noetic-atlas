import type {
  BackgroundTask,
  TaskInput,
  TaskProgress,
  TaskResult,
} from '../../../shared/tasks/tasks.js';
import type { TaskChangeSet } from './changes.js';
import type { PackageQuestionPreviewContext } from '../transfer/packages.js';
export interface TaskStorage {
  list(): Promise<BackgroundTask[]>;
  save(task: BackgroundTask): Promise<void>;
  input(id: string): Promise<TaskInput>;
  saveInput(id: string, input: TaskInput): Promise<void>;
  result(id: string): Promise<TaskResult | undefined>;
  saveResult(id: string, result: TaskResult): Promise<void>;
  binary?(id: string): Promise<Uint8Array | undefined>;
  openBinary?(id: string): Promise<ReadableStream<Uint8Array> | undefined>;
  saveBinary?(id: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  deleteBinary?(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}
export interface TaskExecution {
  result: TaskResult;
  binary?: Uint8Array;
  changes?: TaskChangeSet;
  context?: { packagePreview?: PackageQuestionPreviewContext };
}
export interface TaskExecutor {
  execute(
    id: string,
    input: TaskInput,
    signal: AbortSignal,
    progress: (value: TaskProgress) => void,
  ): Promise<TaskExecution>;
  /** Called only after the result has been staged durably. Must be atomic. */
  commit(id: string, execution: TaskExecution): Promise<void>;
  committed(id: string): Promise<boolean>;
  close?(): Promise<void>;
}
