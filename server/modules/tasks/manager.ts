import { z } from 'zod';
import { makeId, now } from '../../core/store.js';
import { ApiError, fail, parse } from '../../core/validation.js';
import {
  taskOperationAllowed,
  taskOperationTitle,
  terminalTask,
  type BackgroundTask,
  type TaskInput,
  type TaskResult,
} from '../../../shared/tasks/tasks.js';
import type { TaskExecutor, TaskStorage } from './contracts.js';

const inputSchema = z
  .object({
    operation: z.string().max(100000),
    method: z.enum(['GET', 'POST']).default('POST'),
    body: z.unknown().optional(),
    steps: z.array(z.unknown()).min(1).max(2000).optional(),
    title: z.string().max(160).optional(),
    returnTo: z.string().max(4000).optional(),
  })
  .strict();
const previewLimit = 16_000;
const feedbackOperation = '/api/question-feedback/ai-review';
type FeedbackTaskReply = {
  failed?: number;
  items?: Array<{
    id: string;
    status: string;
    failure?: { code: string; message: string };
    feedback?: { updatedAt?: string };
  }>;
};

/** Document processing deliberately returns a partial job with HTTP 200. The
 * queue must preserve that checkpoint, but must not claim its failed block is
 * complete or advance past it on restart. */
function markPartialFailure(input: TaskInput, result: TaskResult) {
  if (input.operation === feedbackOperation && result.status < 400) {
    const batch = result.json as FeedbackTaskReply | undefined;
    if (batch?.failed) {
      const failure = batch.items?.find((item) => item.status === 'failed')?.failure;
      result.status = 502;
      result.json = {
        ...batch,
        error: {
          code: failure?.code || 'AI_FEEDBACK_BATCH_FAILED',
          message: failure?.message || '部分反馈复核未完成，已保存成功结果与失败记录',
        },
      };
    }
    return;
  }
  const stage = input.operation.match(/^\/api\/ai\/document-jobs\/[^/]+\/(plan|generate)$/)?.[1];
  if (!stage || result.status >= 400) return;
  const body = input.body as { blockIds?: string[] } | undefined;
  const job = result.json as
    | {
        blocks?: Array<{
          id: string;
          planStatus?: string;
          generationStatus?: string;
          planFailure?: { code: string; message: string };
          generationFailure?: { code: string; message: string };
        }>;
      }
    | undefined;
  if (!Array.isArray(job?.blocks) || !Array.isArray(body?.blockIds)) return;
  const states = body.blockIds.map((id) => job.blocks!.find((block) => block.id === id));
  if (
    states.every(
      (block) =>
        block && (stage === 'plan' ? block.planStatus : block.generationStatus) === 'completed',
    )
  )
    return;
  const failed = states.find(
    (block) =>
      block && (stage === 'plan' ? block.planStatus : block.generationStatus) !== 'completed',
  );
  const failure = stage === 'plan' ? failed?.planFailure : failed?.generationFailure;
  result.status = 502;
  result.json = {
    ...job,
    error: {
      code: failure?.code || 'AI_DOCUMENT_STEP_INCOMPLETE',
      message: failure?.message || '资料块未完成处理；已完成结果已保留，可重试未完成步骤',
    },
  };
}
function validateInput(raw: unknown): TaskInput {
  const input = parse(inputSchema, raw) as TaskInput;
  if (!taskOperationAllowed(input.operation, input.method))
    fail(400, 'TASK_OPERATION_FORBIDDEN', '此操作不支持后台处理');
  if (input.steps && !/^\/api\/ai\/document-jobs\/[\w.:-]+\/(plan|generate)$/.test(input.operation))
    fail(400, 'TASK_STEPS_FORBIDDEN', '只有教材分块任务可以分段执行');
  if (input.returnTo && !/^#\/[^\u0000-\u001F\u007F<>"\\]*$/u.test(input.returnTo))
    fail(400, 'TASK_RETURN_INVALID', '任务返回位置无效');
  return input;
}
/** One device queue. Payloads/results are separate from lightweight summaries;
 * abandoning a view never owns or cancels the actual operation. */
export class BackgroundTaskManager {
  private tasks = new Map<string, BackgroundTask>();
  private active?: { id: string; controller: AbortController; previewText: string };
  private closed = false;
  private draining?: Promise<void>;
  private writes = new Map<string, Promise<void>>();
  private retrying = new Set<string>();
  constructor(
    readonly storage: TaskStorage,
    private executor: TaskExecutor,
  ) {}
  async initialize() {
    for (const task of await this.storage.list()) {
      if (['queued', 'running', 'committing'].includes(task.status)) {
        task.attempt ||= 1;
        const committed = await this.executor.committed(this.stepId(task));
        let result: TaskResult | undefined;
        try {
          result = committed ? await this.storage.result(task.id) : undefined;
        } catch {
          task.error = { code: 'TASK_CACHE_CORRUPT', message: '任务结果缓存损坏，请重新生成' };
        }
        if (result && result.status < 400) task.completedSteps++;
        task.status = task.completedSteps === task.total ? 'completed' : 'interrupted';
        task.message =
          task.status === 'completed'
            ? '结果已保存'
            : '应用退出中断了处理，可从已完成步骤继续；未完成的AI步骤可能重新调用模型。';
        task.cancellable = false;
        task.read = false;
        task.updatedAt = now();
        await this.storage.save(task);
      }
      this.tasks.set(task.id, task);
    }
  }
  list() {
    return [...this.tasks.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((value) => ({ ...value }));
  }
  get(id: string) {
    return this.tasks.get(id) || fail(404, 'TASK_NOT_FOUND', '后台任务不存在');
  }
  detail(id: string): BackgroundTask {
    const task = this.get(id);
    const previewText = this.active?.id === id ? this.active.previewText : '';
    return { ...task, ...(previewText ? { previewText } : {}) };
  }
  private stepId(task: BackgroundTask) {
    return `${task.id}:${task.completedSteps}:${task.attempt || 1}`;
  }
  private persist(task: BackgroundTask) {
    const snapshot = { ...task },
      previous = this.writes.get(task.id) || Promise.resolve();
    const write = previous.catch(() => {}).then(() => this.storage.save(snapshot));
    this.writes.set(task.id, write);
    return write;
  }
  async start(raw: unknown) {
    const input = validateInput(raw);
    if (this.closed) fail(503, 'TASK_QUEUE_CLOSED', '任务队列已关闭');
    const id = makeId('task'),
      date = now(),
      task: BackgroundTask = {
        id,
        title: input.title || taskOperationTitle(input.operation),
        operation: input.operation,
        method: input.method || 'POST',
        returnTo: input.returnTo || '#/tasks',
        status: 'queued',
        stage: 'queued',
        message: '等待前面的任务完成，可离开当前页面',
        current: 0,
        total: input.steps?.length || 1,
        completedSteps: 0,
        attempt: 1,
        cancellable: true,
        createdAt: date,
        updatedAt: date,
        read: false,
      };
    await this.storage.saveInput(id, input);
    await this.storage.save(task);
    this.tasks.set(id, task);
    this.kick();
    return { ...task };
  }
  private kick() {
    if (this.closed || this.draining) return;
    this.draining = this.drain()
      .catch(() => {
        /* Individual storage failures are reflected on the task; never leave an unhandled queue promise. */
      })
      .finally(() => {
        this.draining = undefined;
        if (!this.closed && this.list().some((t) => t.status === 'queued')) this.kick();
      });
  }
  private async drain() {
    for (;;) {
      const task = [...this.tasks.values()].find((value) => value.status === 'queued');
      if (!task || this.closed) return;
      const controller = new AbortController();
      const active = { id: task.id, controller, previewText: '' };
      this.active = active;
      let binaryStaged = false;
      try {
        task.status = 'running';
        task.stage = 'preparing';
        task.message = '正在准备独立工作副本';
        task.updatedAt = now();
        await this.persist(task);
        const input = validateInput(await this.storage.input(task.id)),
          steps = input.steps || [input.body];
        for (let index = task.completedSteps; index < steps.length; index++) {
          controller.signal.throwIfAborted();
          const stepId = this.stepId(task);
          if (await this.executor.committed(stepId)) {
            task.completedSteps++;
            continue;
          }
          const stepInput = {
            ...input,
            steps: undefined,
            body:
              task.attempt > 1 && /\/(plan|generate)$/.test(input.operation)
                ? { ...(steps[index] as object), retryFailed: true }
                : steps[index],
          };
          active.previewText = '';
          const execution = await this.executor.execute(
            stepId,
            stepInput,
            controller.signal,
            (value) => {
              if (controller.signal.aborted) return;
              if ('delta' in value) {
                if (active.previewText.length < previewLimit)
                  active.previewText += value.delta.slice(
                    0,
                    previewLimit - active.previewText.length,
                  );
                return;
              }
              if (value.stage === 'model_start') active.previewText = '';
              task.stage = value.stage;
              task.message = value.message;
              task.current = index;
              task.updatedAt = now();
              // The current stage is already visible in memory. A temporary
              // cache write failure must not be reported as a user cancellation.
              // Prepare, result staging, commit and checkpoints still await disk.
              void this.persist(task).catch(() => {});
            },
          );
          controller.signal.throwIfAborted();
          markPartialFailure(stepInput, execution.result);
          if (execution.binary) {
            if (!this.storage.saveBinary)
              throw new ApiError(
                500,
                'TASK_BINARY_STORAGE',
                '此设备无法保存后台文件，请重新启动应用',
              );
            task.stage = 'staging';
            task.message = '正在保存可下载文件，此阶段仍可取消';
            task.updatedAt = now();
            await this.persist(task);
            controller.signal.throwIfAborted();
            await this.storage.saveBinary(task.id, execution.binary, controller.signal);
            binaryStaged = true;
            execution.result.binaryByteLength = execution.binary.byteLength;
            execution.binary = undefined;
            controller.signal.throwIfAborted();
          }
          await this.storage.saveResult(task.id, execution.result);
          controller.signal.throwIfAborted();
          task.status = 'committing';
          task.stage = 'committing';
          task.cancellable = false;
          task.message = '校验并原子保存结果；此阶段完成前不能取消';
          task.updatedAt = now();
          await this.persist(task);
          await this.executor.commit(stepId, execution);
          if (execution.result.status >= 400) {
            const error = (execution.result.json as any)?.error;
            throw new ApiError(
              execution.result.status,
              error?.code || 'TASK_OPERATION_FAILED',
              error?.message || '操作失败，请查看处理记录',
            );
          }
          task.completedSteps++;
          task.current = task.completedSteps;
          task.status = 'running';
          task.cancellable = true;
          await this.persist(task);
        }
        task.status = 'completed';
        task.stage = 'complete';
        task.message = '处理完成，结果已保存，可查看或下载';
        task.cancellable = false;
        task.read = false;
      } catch (error) {
        task.status = controller.signal.aborted
          ? this.closed
            ? 'interrupted'
            : 'cancelled'
          : 'failed';
        task.cancellable = false;
        task.read = false;
        if (binaryStaged && task.completedSteps < task.total)
          await this.storage.deleteBinary?.(task.id).catch(() => {});
        task.error =
          error instanceof ApiError
            ? { code: error.code, message: error.message, status: error.status }
            : {
                code: controller.signal.aborted ? 'TASK_CANCELLED' : 'TASK_FAILED',
                message: controller.signal.aborted
                  ? this.closed
                    ? '应用退出中断了处理，已完成步骤保留，可继续重试。'
                    : '任务已取消，已完成步骤保留，未提交部分没有写入题库'
                  : '处理未完成，请检查存储空间或服务日志后重试',
              };
        task.message = task.error.message;
      } finally {
        task.updatedAt = now();
        try {
          await this.persist(task);
        } catch {
          task.status = 'failed';
          task.cancellable = false;
          task.error = {
            code: 'TASK_STORAGE_FAILED',
            message: '无法保存任务状态，请检查可用磁盘空间后重试',
          };
          task.message = task.error.message;
        }
        this.active = undefined;
      }
    }
  }
  async cancel(id: string) {
    const task = this.get(id);
    if (!task.cancellable || task.status === 'committing')
      fail(409, 'TASK_COMMITTING', '结果正在原子保存，请等待保存完成');
    if (this.active?.id === id) this.active.controller.abort();
    else {
      task.status = 'cancelled';
      task.cancellable = false;
      task.message = '任务已取消';
      task.updatedAt = now();
      await this.persist(task);
    }
    return { ...task };
  }
  async retry(id: string) {
    const task = this.get(id);
    if (
      this.closed ||
      this.retrying.has(id) ||
      !['failed', 'cancelled', 'interrupted'].includes(task.status)
    )
      fail(409, 'TASK_RETRY_INVALID', '任务当前不能重试');
    this.retrying.add(id);
    try {
      if (
        task.operation === feedbackOperation &&
        (await this.executor.committed(this.stepId(task)))
      ) {
        const result = await this.storage.result(id);
        const failed =
          (result?.json as FeedbackTaskReply | undefined)?.items?.filter(
            (item) => item.status === 'failed',
          ) || [];
        if (failed.length && failed.every((item) => item.feedback?.updatedAt)) {
          const input = await this.storage.input(id);
          await this.storage.saveInput(id, {
            ...input,
            body: {
              ids: failed.map((item) => item.id),
              expectedUpdatedAt: Object.fromEntries(
                failed.map((item) => [item.id, item.feedback!.updatedAt!]),
              ),
            },
          });
        }
      }
      if (this.closed) fail(503, 'TASK_QUEUE_CLOSED', '任务队列已关闭');
      task.status = 'queued';
      task.attempt = (task.attempt || 1) + 1;
      task.error = undefined;
      task.message = '等待继续未完成步骤';
      task.cancellable = true;
      task.read = false;
      task.updatedAt = now();
      await this.persist(task);
      this.kick();
      return { ...task };
    } finally {
      this.retrying.delete(id);
    }
  }
  async read(id: string) {
    const task = this.get(id);
    task.read = true;
    await this.persist(task);
    return { ...task };
  }
  async result(id: string): Promise<TaskResult> {
    const task = this.get(id);
    if (task.status !== 'completed') fail(409, 'TASK_RESULT_NOT_READY', '任务尚未完成');
    return (
      (await this.storage.result(id)) ||
      fail(410, 'TASK_RESULT_MISSING', '结果文件已清理，请重新生成')
    );
  }
  async download(id: string) {
    const result = await this.result(id);
    if (result.binaryByteLength === undefined)
      fail(404, 'TASK_FILE_NOT_AVAILABLE', '该任务没有独立下载文件');
    const data = this.storage.openBinary
      ? await this.storage.openBinary(id)
      : await this.storage.binary?.(id);
    if (!data) fail(410, 'TASK_RESULT_MISSING', '结果文件已清理，请重新生成');
    return { result, data };
  }
  async remove(id: string) {
    const task = this.get(id);
    if (this.retrying.has(id) || !terminalTask(task))
      fail(409, 'TASK_ACTIVE', '请先取消或等待任务完成');
    await this.writes.get(id)?.catch(() => {});
    await this.storage.remove(id);
    this.tasks.delete(id);
    this.writes.delete(id);
  }
  async close() {
    this.closed = true;
    this.active?.controller.abort();
    await this.draining;
    for (const task of this.tasks.values())
      if (task.status === 'queued') {
        task.status = 'interrupted';
        task.cancellable = false;
        task.read = false;
        await this.persist(task);
      }
    await Promise.allSettled(this.writes.values());
    await this.executor.close?.();
  }
}
