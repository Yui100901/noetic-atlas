import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { BackgroundTask, TaskInput, TaskResult } from '../../shared/tasks/tasks.js';
import { BackgroundTaskManager } from '../../server/modules/tasks/manager.js';
import type {
  TaskExecution,
  TaskExecutor,
  TaskStorage,
} from '../../server/modules/tasks/contracts.js';
import {
  commitTaskChanges,
  taskSnapshot,
  taskWasCommitted,
} from '../../server/modules/tasks/changes.js';
import { Store } from '../../server/core/store.js';
import { fixtureQuestion } from '../fixtures/learning-seed.js';

class MemoryStorage implements TaskStorage {
  summaries = new Map<string, BackgroundTask>();
  inputs = new Map<string, TaskInput>();
  outputs = new Map<string, TaskResult>();
  async list() {
    return structuredClone([...this.summaries.values()]);
  }
  async save(task: BackgroundTask) {
    this.summaries.set(task.id, structuredClone(task));
  }
  async input(id: string) {
    return structuredClone(this.inputs.get(id)!);
  }
  async saveInput(id: string, input: TaskInput) {
    this.inputs.set(id, structuredClone(input));
  }
  async result(id: string) {
    return structuredClone(this.outputs.get(id));
  }
  async saveResult(id: string, result: TaskResult) {
    this.outputs.set(id, structuredClone(result));
  }
  async remove(id: string) {
    this.summaries.delete(id);
    this.inputs.delete(id);
    this.outputs.delete(id);
  }
}
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function eventually(check: () => boolean, message: string) {
  const end = performance.now() + 4000;
  while (!check()) {
    if (performance.now() > end) assert.fail(message);
    await delay(5);
  }
}
function abortable<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('cancelled', 'AbortError'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    value.then(
      (result) => {
        signal.removeEventListener('abort', abort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}
const success = (value: unknown = { ok: true }): TaskExecution => ({
  result: { status: 200, contentType: 'application/json', json: value },
});
function fixture(
  t: test.TestContext,
  execute: TaskExecutor['execute'],
  commit?: TaskExecutor['commit'],
) {
  const storage = new MemoryStorage(),
    committed = new Set<string>(),
    calls: string[] = [];
  const executor: TaskExecutor = {
    execute: async (...args) => {
      calls.push(args[0]);
      return execute(...args);
    },
    commit: async (id, execution) => {
      await commit?.(id, execution);
      committed.add(id);
    },
    committed: async (id) => committed.has(id),
  };
  const manager = new BackgroundTaskManager(storage, executor);
  t.after(() => manager.close());
  return { storage, committed, calls, executor, manager };
}

test('device queue owns execution after the caller has returned; queued work is ordered and summaries omit payloads', async (t) => {
  const firstGate = deferred(),
    entered: string[] = [];
  const f = fixture(t, async (id, input, signal, progress) => {
    entered.push(id);
    progress({ stage: 'processing', message: '可离开页面' });
    if ((input.body as any)?.first) await abortable(firstGate.promise, signal);
    return success({ body: input.body });
  });
  await f.manager.initialize();
  const first = await f.manager.start({
    operation: '/api/packages/preview',
    body: { first: true, dataBase64: 'private-payload' },
    returnTo: '#/sharing',
  });
  const second = await f.manager.start({
    operation: '/api/packages/export',
    body: { kind: 'share' },
  });
  await eventually(() => entered.length === 1, 'first task started independently');
  assert.equal(f.manager.get(second.id).status, 'queued');
  assert.ok(!JSON.stringify(f.manager.list()).includes('private-payload'));
  assert.equal(f.storage.inputs.size, 2);
  firstGate.resolve();
  await eventually(
    () => f.manager.list().every((task) => task.status === 'completed'),
    'both tasks complete without an editor owner',
  );
  assert.deepEqual(entered, [`${first.id}:0:1`, `${second.id}:0:1`]);
  assert.equal((await f.manager.result(first.id)).status, 200);
  assert.equal(f.manager.get(first.id).read, false);
  await f.manager.read(first.id);
  assert.equal(f.manager.get(first.id).read, true);
});

test('a transient progress-cache error cannot cancel or prevent committing a task', async (t) => {
  const progressSaved = deferred();
  const f = fixture(t, async (_id, _input, signal, progress) => {
    progress({ stage: 'model_start', message: '等待模型' });
    await progressSaved.promise;
    signal.throwIfAborted();
    return success();
  });
  const save = f.storage.save.bind(f.storage);
  f.storage.save = async (task) => {
    if (task.stage === 'model_start' && task.status === 'running') {
      // Let the failed advisory write settle before the executor finishes.
      setImmediate(() => progressSaved.resolve());
      throw Error('transient file lock');
    }
    await save(task);
  };
  const task = await f.manager.start({ operation: '/api/ai/paper-plan' });
  await eventually(() => f.manager.get(task.id).status === 'completed', 'work completes');
  assert.equal(f.committed.size, 1);
  assert.equal((await f.manager.result(task.id)).status, 200);
});

test('explicit cancellation of queued and running tasks never commits their staged operations', async (t) => {
  const gate = deferred();
  const f = fixture(t, async (_id, _input, signal) => {
    await abortable(gate.promise, signal);
    return success();
  });
  const running = await f.manager.start({
    operation: '/api/ai/paper-plan',
    body: { prompt: 'fixture' },
  });
  const queued = await f.manager.start({
    operation: '/api/packages/import',
    body: { confirmed: true },
  });
  await eventually(() => f.calls.length === 1, 'running task entered executor');
  await f.manager.cancel(queued.id);
  await f.manager.cancel(running.id);
  await eventually(
    () => f.manager.get(running.id).status === 'cancelled',
    'running cancellation is observed',
  );
  assert.equal(f.manager.get(queued.id).status, 'cancelled');
  assert.equal(f.calls.length, 1);
  assert.equal(f.committed.size, 0);
  assert.equal(f.storage.outputs.size, 0);
  await assert.rejects(() => f.manager.result(running.id), { code: 'TASK_RESULT_NOT_READY' });
});

test('staged result is durable before atomic commit and cancellation is refused during commit', async (t) => {
  const commitGate = deferred();
  const f = fixture(
    t,
    async () => success({ stable: true }),
    async () => {
      await commitGate.promise;
    },
  );
  const task = await f.manager.start({ operation: '/api/packages/import' });
  await eventually(() => f.manager.get(task.id).status === 'committing', 'commit phase reached');
  assert.equal((await f.storage.result(task.id))!.status, 200);
  assert.equal(f.manager.get(task.id).cancellable, false);
  await assert.rejects(() => f.manager.cancel(task.id), { code: 'TASK_COMMITTING' });
  assert.equal(f.committed.size, 0);
  commitGate.resolve();
  await eventually(() => f.manager.get(task.id).status === 'completed', 'atomic commit finishes');
  assert.equal(f.committed.size, 1);
});

test('cancellation during result staging stops the commit and model preview is never persisted', async (t) => {
  const staging = deferred();
  const allowStage = deferred();
  const f = fixture(t, async (_id, _input, _signal, progress) => {
    progress({ delta: 'previous response' });
    progress({ stage: 'model_start', message: '新模型批次' });
    progress({ delta: '新输出'.repeat(8000) });
    return success();
  });
  const originalSave = f.storage.saveResult.bind(f.storage);
  f.storage.saveResult = async (id, result) => {
    staging.resolve();
    await allowStage.promise;
    await originalSave(id, result);
  };
  const task = await f.manager.start({ operation: '/api/ai/explain' });
  await staging.promise;
  try {
    const detail = f.manager.detail(task.id);
    assert.equal(detail.previewText?.length, 16000);
    assert.ok(detail.previewText?.startsWith('新输出'));
    assert.equal(f.manager.list()[0]?.previewText, undefined);
    assert.equal(f.storage.summaries.get(task.id)?.previewText, undefined);
    await f.manager.cancel(task.id);
  } finally {
    allowStage.resolve();
  }
  await eventually(
    () => f.manager.get(task.id).status === 'cancelled',
    'cancellation wins before commit',
  );
  assert.equal(f.committed.size, 0);
  await assert.rejects(() => f.manager.result(task.id), { code: 'TASK_RESULT_NOT_READY' });
});

test('segmented retry keeps committed blocks, resumes the failed block and uses a new attempt identity', async (t) => {
  const attempted: Array<{ id: string; body: any }> = [];
  let failed = false;
  const f = fixture(t, async (id, input) => {
    attempted.push({ id, body: input.body });
    if ((input.body as any).block === 2 && !failed) {
      failed = true;
      throw Error('one interrupted provider batch');
    }
    return success({ block: (input.body as any).block });
  });
  const task = await f.manager.start({
    operation: '/api/ai/document-jobs/book-job/generate',
    steps: [{ block: 1 }, { block: 2 }, { block: 3 }],
  });
  await eventually(() => f.manager.get(task.id).status === 'failed', 'second block fails');
  assert.equal(f.manager.get(task.id).completedSteps, 1);
  assert.equal(f.committed.size, 1);
  await f.manager.retry(task.id);
  await eventually(() => f.manager.get(task.id).status === 'completed', 'remaining blocks resume');
  assert.deepEqual(
    attempted.map((item) => item.body.block),
    [1, 2, 2, 3],
  );
  assert.deepEqual(
    attempted.slice(2).map((item) => item.body.retryFailed),
    [true, true],
  );
  assert.deepEqual(
    attempted.map((item) => item.id),
    [`${task.id}:0:1`, `${task.id}:1:1`, `${task.id}:1:2`, `${task.id}:2:2`],
  );
  assert.equal(f.manager.get(task.id).completedSteps, 3);
  assert.equal(f.committed.size, 3);
});

test('a failed operation is not exposed as a completed result even when its failure audit was committed', async (t) => {
  const f = fixture(t, async () => ({
    result: {
      status: 429,
      contentType: 'application/json',
      json: { error: { code: 'AI_RATE_LIMIT', message: '供应商限流，请稍后重试' } },
    },
  }));
  const task = await f.manager.start({ operation: '/api/ai/import', body: { text: 'fixture' } });
  await eventually(() => f.manager.get(task.id).status === 'failed', 'failure stays visible');
  assert.equal(f.manager.get(task.id).error?.code, 'AI_RATE_LIMIT');
  assert.equal(f.manager.get(task.id).completedSteps, 0);
  assert.equal(f.committed.size, 1);
  await assert.rejects(() => f.manager.result(task.id), { code: 'TASK_RESULT_NOT_READY' });
});

test('restart recognizes already committed staged results and leaves uncommitted work interrupted', async (t) => {
  const f = fixture(t, async () => success());
  const date = '2026-11-07T00:00:00.000Z';
  const summary = (id: string, status: BackgroundTask['status']): BackgroundTask => ({
    id,
    title: '恢复任务',
    operation: '/api/packages/import',
    method: 'POST',
    returnTo: '#/tasks',
    status,
    stage: 'committing',
    message: '',
    current: 0,
    total: 1,
    completedSteps: 0,
    attempt: 1,
    cancellable: false,
    createdAt: date,
    updatedAt: date,
    read: false,
  });
  await f.storage.save(summary('saved', 'committing'));
  await f.storage.saveResult('saved', success({ durable: true }).result);
  f.committed.add('saved:0:1');
  await f.storage.save(summary('stopped', 'running'));
  await f.storage.saveInput('stopped', { operation: '/api/packages/import' });
  await f.manager.initialize();
  assert.equal(f.manager.get('saved').status, 'completed');
  assert.equal(f.manager.get('saved').completedSteps, 1);
  assert.deepEqual((await f.manager.result('saved')).json, { durable: true });
  assert.equal(f.manager.get('stopped').status, 'interrupted');
  assert.equal(f.calls.length, 0);
  await f.manager.retry('stopped');
  await eventually(
    () => f.manager.get('stopped').status === 'completed',
    'interrupted work can explicitly resume',
  );
  assert.deepEqual(f.calls, ['stopped:0:2']);
});

test('task admission rejects non-whitelisted operations and arbitrary segmented writes before execution', async (t) => {
  const f = fixture(t, async () => success());
  for (const input of [
    { operation: '/api/ai/settings', body: { key: 'must-not-be-stored' } },
    { operation: 'https://example.com/api/packages/import' },
    { operation: '/api/packages/import', steps: [{}] },
    { operation: '/api/packages/import', returnTo: 'https://example.com' },
  ])
    await assert.rejects(() => f.manager.start(input));
  assert.equal(f.storage.inputs.size, 0);
  assert.equal(f.calls.length, 0);
});

function stores(t: test.TestContext) {
  const original = new Store(':memory:'),
    worker = new Store(':memory:');
  t.after(() => {
    original.database.close();
    worker.database.close();
  });
  for (const store of [original, worker])
    store.put(
      'questions',
      'SOURCE',
      fixtureQuestion('SOURCE', 'short_answer', { categoryIds: [], tagIds: [] }),
    );
  original.put('study', 'SOURCE', {
    questionId: 'SOURCE',
    favorite: true,
    mastery: 2,
    notes: '原笔记',
    nextReviewAt: null,
    lastReviewedAt: null,
    wrongCount: 1,
  });
  return { original, worker };
}
test('AI explanation tracks only its referenced asset and keeps unrelated PDF storage changes', (t) => {
  const { original, worker } = stores(t);
  for (const store of [original, worker]) {
    store.put('questions', 'SOURCE', {
      ...store.require<any>('questions', 'SOURCE'),
      stemMarkdown: '解释 ![题图](/api/assets/question-image/content)',
    });
    store.put('assets', 'question-image', {
      id: 'question-image',
      mimeType: 'image/png',
      dataBase64: 'AA==',
    });
  }
  const snapshot = taskSnapshot(worker, '/api/ai/explain', { questionId: 'SOURCE' });
  assert.deepEqual(snapshot.guards.find((guard) => guard.table === 'assets')?.ids, [
    'question-image',
  ]);
  worker.put('ai_runs', 'run-fixture', { id: 'run-fixture', status: 'completed' });
  const changes = snapshot.finish();
  original.put('assets', 'another-pdf', {
    id: 'another-pdf',
    mimeType: 'application/pdf',
    dataBase64: 'AA==',
  });
  commitTaskChanges(original, 'source-assets:0:1', changes);
  assert.ok(original.get('assets', 'another-pdf'));
  original.put('assets', 'question-image', {
    id: 'question-image',
    mimeType: 'image/png',
    dataBase64: 'AQ==',
  });
  assert.throws(() => commitTaskChanges(original, 'changed-assets:0:1', changes), {
    code: 'TASK_SOURCE_CHANGED',
  });
});
test('source question changes reject a worker result atomically while concurrent learning edits survive', (t) => {
  const { original, worker } = stores(t),
    snapshot = taskSnapshot(worker, '/api/ai/review');
  worker.put('questions', 'SOURCE', {
    ...worker.require<any>('questions', 'SOURCE'),
    title: '后台建议修订',
  });
  const changes = snapshot.finish();
  original.put('questions', 'SOURCE', {
    ...original.require<any>('questions', 'SOURCE'),
    title: '用户已经修订',
  });
  original.put('study', 'SOURCE', {
    ...original.require<any>('study', 'SOURCE'),
    notes: '处理中继续编辑的笔记',
  });
  assert.throws(() => commitTaskChanges(original, 'stale:0:1', changes), {
    code: 'TASK_SOURCE_CHANGED',
  });
  assert.equal(original.require<any>('questions', 'SOURCE').title, '用户已经修订');
  assert.equal(original.require<any>('study', 'SOURCE').notes, '处理中继续编辑的笔记');
  assert.equal(taskWasCommitted(original, 'stale:0:1'), false);
});

test('valid worker patches preserve unrelated learning state and a commit marker prevents duplicate replay', (t) => {
  const { original, worker } = stores(t),
    snapshot = taskSnapshot(worker, '/api/ai/review');
  worker.put('questions', 'SOURCE', {
    ...worker.require<any>('questions', 'SOURCE'),
    title: '已核对修订',
  });
  const changes = snapshot.finish();
  original.put('study', 'SOURCE', {
    ...original.require<any>('study', 'SOURCE'),
    notes: '并发学习笔记',
    wrongCount: 3,
  });
  commitTaskChanges(original, 'once:0:1', changes);
  assert.equal(original.require<any>('questions', 'SOURCE').title, '已核对修订');
  assert.equal(original.require<any>('study', 'SOURCE').notes, '并发学习笔记');
  assert.equal(original.require<any>('study', 'SOURCE').wrongCount, 3);
  assert.equal(taskWasCommitted(original, 'once:0:1'), true);
  original.put('questions', 'SOURCE', {
    ...original.require<any>('questions', 'SOURCE'),
    title: '提交后的新编辑',
  });
  commitTaskChanges(original, 'once:0:1', changes);
  assert.equal(original.require<any>('questions', 'SOURCE').title, '提交后的新编辑');
});
