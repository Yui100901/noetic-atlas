import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { buildApp } from '../../server/index.js';
import type { Store } from '../../server/core/store.js';
import { createNodeTaskManager } from '../../server/modules/tasks/node-manager.js';
import { DiskTaskStorage } from '../../server/modules/tasks/disk-storage.js';
import { BackgroundTaskManager } from '../../server/modules/tasks/manager.js';
import { registerTaskRoutes } from '../../server/modules/tasks/routes.js';
import {
  commitTaskChanges,
  taskCommitKey,
  taskSnapshot,
  taskWasCommitted,
} from '../../server/modules/tasks/changes.js';
import type { TaskInput, BackgroundTask } from '../../shared/tasks/tasks.js';
import { buildDataPackage, readDataPackage } from '../../shared/packages/data-package.js';
import { fixtureQuestion, learningSeed } from '../fixtures/learning-seed.js';
import {
  exportPackageQuestionPreviewContext,
  restorePackageQuestionPreviewContext,
} from '../../server/modules/transfer/packages.js';

async function waitFor(check: () => boolean, message: string, timeout = 120_000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) assert.fail(message);
    await delay(10);
  }
}
async function fixture(t: test.TestContext, disk = false) {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-worker-test-'));
  const databasePath = disk ? join(directory, 'source.sqlite') : ':memory:';
  let store!: Store;
  const app = await buildApp({
    databasePath,
    logger: false,
    dailyPushScheduler: false,
    onStore: (value) => {
      store = value;
    },
  });
  const manager = await createNodeTaskManager(store, databasePath, join(directory, 'tasks'));
  registerTaskRoutes(app, manager);
  t.after(async () => {
    await manager.close();
    await app.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });
  const call = async (url: string, payload?: unknown, expected = 200) => {
    const response = await app.inject({
      url,
      method: payload === undefined ? 'GET' : 'POST',
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    assert.equal(response.statusCode, expected, response.body);
    return response.json();
  };
  await call('/api/import', { mode: 'merge', data: learningSeed() });
  const run = async (input: TaskInput, status: BackgroundTask['status'] = 'completed') => {
    const started = await manager.start(input);
    await waitFor(
      () =>
        ['completed', 'failed', 'cancelled', 'interrupted'].includes(
          manager.get(started.id).status,
        ),
      'worker finishes',
    );
    const result = manager.get(started.id);
    assert.equal(result.status, status, JSON.stringify(result));
    return result;
  };
  return { directory, store, app, manager, call, run };
}
async function migrationPackage(id: string) {
  const seed = learningSeed();
  seed.questions = [fixtureQuestion(id, 'short_answer')];
  return Buffer.from(
    await buildDataPackage({
      kind: 'migration',
      title: '隔离测试题',
      payloads: [{ path: 'data/questions.json', data: seed }],
    }),
  ).toString('base64');
}

for (const disk of [false, true])
  test(`real worker imports a new question into ${disk ? 'disk' : 'memory'} source, previews and exports a manifest package`, async (t) => {
    const f = await fixture(t, disk),
      dataBase64 = await migrationPackage('WORKER-NEW');
    const previewTask = await f.run({ operation: '/api/packages/preview', body: { dataBase64 } });
    const preview = (await f.manager.result(previewTask.id)).json as any;
    assert.equal(preview.counts.questions.added, 1);
    assert.equal(
      f.store.get('questions', 'WORKER-NEW'),
      undefined,
      'preview has no content side effects',
    );
    const imported = await f.run({
      operation: '/api/packages/import',
      body: {
        dataBase64,
        expectedFingerprint: preview.fingerprint,
        confirmed: true,
        confirmedTrusted: true,
      },
    });
    assert.equal(f.store.require<any>('questions', 'WORKER-NEW').status, 'published');
    assert.equal(taskWasCommitted(f.store, `${imported.id}:0:1`), true);
    assert.equal(f.store.all('questions').length, 7);
    const exportTask = await f.run({
      operation: '/api/packages/export',
      body: { kind: 'share', selection: { kind: 'questions', id: 'WORKER-NEW' } },
    });
    const output = (await f.manager.result(exportTask.id)).json as any;
    const opened = await readDataPackage(Buffer.from(output.dataBase64, 'base64'));
    assert.equal(opened.manifest.kind, 'share');
    assert.ok(output.byteLength > 0);
    if (!disk) {
      const sharePreviewTask = await f.run({
        operation: '/api/packages/preview',
        body: { dataBase64: output.dataBase64 },
      });
      const sharePreview = (await f.manager.result(sharePreviewTask.id)).json as any;
      const incoming = await f.call(
        `/api/packages/import-question?fingerprint=${sharePreview.fingerprint}&index=0`,
      );
      assert.equal(
        incoming.id,
        'WORKER-NEW',
        'private preview context survives worker termination',
      );
      assert.ok(
        !JSON.stringify(await f.manager.result(sharePreviewTask.id)).includes('stemMarkdown'),
        'task result does not duplicate every full question',
      );
      const context = exportPackageQuestionPreviewContext(f.store, sharePreview.fingerprint)!;
      // An expired handoff must not resurrect an expired preview.
      const expiredFingerprint = '0'.repeat(64);
      restorePackageQuestionPreviewContext(f.store, {
        ...context,
        fingerprint: expiredFingerprint,
        createdAt: Date.now() - 11 * 60_000,
      });
      const expired = await f.call(
        `/api/packages/import-question?fingerprint=${expiredFingerprint}&index=0`,
        undefined,
        409,
      );
      assert.equal(expired.error.code, 'IMPORT_PREVIEW_EXPIRED');
    }
    const files = await readdir(join(f.directory, 'tasks'));
    assert.equal(
      files.some((name) => name.startsWith('work-')),
      false,
      'temporary SQLite copies are removed',
    );
  });

test('worker preserves stale-preview and unresolved-similar admission checks without partial content writes', async (t) => {
  const f = await fixture(t),
    dataBase64 = await migrationPackage('STALE-NEW');
  const preview = await f.call('/api/packages/preview', { dataBase64 });
  f.store.put(
    'questions',
    'STALE-NEW',
    fixtureQuestion('STALE-NEW', 'short_answer', { title: '预览之后已建立的本地题' }),
  );
  const failed = await f.run(
    {
      operation: '/api/packages/import',
      body: {
        dataBase64,
        expectedFingerprint: preview.fingerprint,
        confirmed: true,
        confirmedTrusted: true,
      },
    },
    'failed',
  );
  assert.equal(failed.error?.code, 'PACKAGE_PREVIEW_STALE');
  assert.equal(f.store.require<any>('questions', 'STALE-NEW').title, '预览之后已建立的本地题');
  const file = await f.call('/api/packages/export', {
    kind: 'share',
    selection: { kind: 'questions', id: 'FIXTURE-SHORT-1' },
  });
  const opened = await readDataPackage(Buffer.from(file.dataBase64, 'base64'));
  const payload = structuredClone(opened.payloads[0]!.data) as any;
  payload.questions[0].id = 'SIMILAR-NEW';
  payload.questions[0].answerMarkdown = '更新后的不同参考答案';
  const similarBase64 = Buffer.from(
    await buildDataPackage({
      kind: 'share',
      title: '相似题审核',
      payloads: [{ path: 'data/share.json', data: payload }],
    }),
  ).toString('base64');
  const similar = await f.call('/api/packages/preview', { dataBase64: similarBase64 });
  assert.ok(similar.dedup.counts.similar > 0);
  const rejected = await f.run(
    {
      operation: '/api/packages/import',
      body: {
        dataBase64: similarBase64,
        expectedFingerprint: similar.fingerprint,
        confirmed: true,
      },
    },
    'failed',
  );
  assert.equal(rejected.error?.code, 'IMPORT_SIMILAR_REVIEW_REQUIRED');
  assert.equal(f.store.get('questions', 'SIMILAR-NEW'), undefined);
});

async function aiFixture(t: test.TestContext) {
  const f = await fixture(t);
  let calls = 0,
    fail = false,
    failFeedback = false,
    hold: Promise<void> | undefined,
    release: () => void = () => {};
  const provider = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const completion = JSON.parse(raw),
      input = JSON.parse(completion.messages[1].content);
    calls++;
    await hold;
    if (
      fail ||
      (failFeedback && input.untrustedMaterial.feedback?.description?.includes('RETRY'))
    ) {
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'TEST_PRIVATE_PROVIDER_DETAIL' } }));
      return;
    }
    const output = input.untrustedMaterial.feedback
      ? {
          verdict: 'uncertain',
          reason: '需要核对原始材料。',
          suggestion: '补充证据。',
          comparisons: [],
        }
      : input.task.includes('总结本次资料块')
        ? { title: '变量', summary: '变量是名称与值之间的绑定关系。', topics: ['变量', '赋值'] }
        : {
            explanationMarkdown: '变量关联一个值。',
            followUpsMarkdown: '作用域限制可见性。',
            pitfallsMarkdown: '变量不等同于固定地址。',
          };
    const content = JSON.stringify(output);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 20, total_tokens: 32 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  f.store.put('ai_settings', 'local', {
    enabled: true,
    baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}`,
    key: 'TEST_ONLY_NO_REAL_SECRET',
    model: 'worker-mock',
    maxTokens: 4096,
    timeoutSeconds: 10,
    supportsImages: false,
    sendImages: false,
    updatedAt: new Date().toISOString(),
  });
  t.after(async () => {
    release();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  });
  return {
    ...f,
    calls: () => calls,
    fail: (value: boolean) => {
      fail = value;
    },
    failFeedback: (value: boolean) => {
      failFeedback = value;
    },
    hold: () => {
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        release();
        hold = undefined;
      };
    },
  };
}

test('a real SQLite background export stores binary separately and streams an intact downloadable file', async (t) => {
  const f = await fixture(t, true);
  const task = await f.run({ operation: '/api/backup.sqlite', method: 'GET' });
  const result = await f.manager.result(task.id);
  assert.ok(result.binaryByteLength && result.binaryByteLength > 100);
  assert.equal(result.binaryBase64, undefined);
  assert.equal(
    taskWasCommitted(f.store, `${task.id}:0:1`),
    false,
    'read-only export does not mark the live SQLite database',
  );
  const response = await f.app.inject({ url: `/api/tasks/${task.id}/download` });
  assert.equal(response.statusCode, 200, response.body.slice(0, 300));
  assert.equal(response.headers['content-type'], 'application/vnd.sqlite3');
  assert.equal(Number(response.headers['content-length']), result.binaryByteLength);
  assert.equal(response.rawPayload.subarray(0, 16).toString('utf8'), 'SQLite format 3\0');
  assert.deepEqual(response.rawPayload, await f.manager.storage.binary!(task.id));
  await f.manager.remove(task.id);
  assert.equal(await f.manager.storage.binary!(task.id), undefined);
});

test('background feedback retry preserves the successful case and reviews only the failed case again', async (t) => {
  const f = await aiFixture(t);
  const report = (questionId: string, description: string) =>
    f.call('/api/question-feedback', { questionId, kind: 'answer', description }, 201);
  const good = await report('FIXTURE-SHORT-1', '请核对参考答案的完整性。');
  const bad = await report('FIXTURE-BOOL', 'RETRY 此条反馈首次返回限流。');
  f.failFeedback(true);
  const task = await f.run(
    {
      operation: '/api/question-feedback/ai-review',
      body: {
        ids: [good.id, bad.id],
        expectedUpdatedAt: { [good.id]: good.updatedAt, [bad.id]: bad.updatedAt },
      },
    },
    'failed',
  );
  assert.equal(f.calls(), 2);
  const success = f.store.database.getRecord<any>('question_feedback', good.id);
  const failed = f.store.database.getRecord<any>('question_feedback', bad.id);
  assert.equal(success.review.verdict, 'uncertain');
  assert.match(failed.lastFailure.failure.message, /429/);
  assert.notEqual(
    f.store.database.getRecord<any>('quality_issues', good.qualityIssueId).updatedAt,
    good.updatedAt,
  );
  f.failFeedback(false);
  await f.manager.retry(task.id);
  await waitFor(
    () => ['completed', 'failed'].includes(f.manager.get(task.id).status),
    'feedback retry finishes',
  );
  assert.equal(f.manager.get(task.id).status, 'completed', JSON.stringify(f.manager.get(task.id)));
  assert.equal(f.calls(), 3);
  assert.equal(
    f.store.database.getRecord<any>('question_feedback', good.id).review.runId,
    success.review.runId,
  );
  assert.equal(f.store.database.getRecord<any>('question_feedback', bad.id).lastFailure, undefined);
});

test('a real AI worker keeps foreground APIs responsive and unrelated attempts do not invalidate its result', async (t) => {
  const f = await aiFixture(t),
    release = f.hold();
  const task = await f.manager.start({
    operation: '/api/ai/explain',
    body: { questionId: 'FIXTURE-SHORT-1' },
  });
  await waitFor(() => f.calls() === 1, 'mock AI entered');
  const start = performance.now();
  await f.call('/api/questions/FIXTURE-BOOL');
  assert.ok(
    performance.now() - start < 1000,
    'foreground API is responsive while worker is waiting',
  );
  const paper = await f.call(
    '/api/papers',
    { title: '并发练习', mode: 'manual', questionIds: ['FIXTURE-BOOL'] },
    201,
  );
  await f.call(`/api/papers/${paper.id}/attempts`, {}, 201);
  release();
  await waitFor(
    () => ['completed', 'failed'].includes(f.manager.get(task.id).status),
    'AI worker finishes',
  );
  assert.equal(f.manager.get(task.id).status, 'completed', JSON.stringify(f.manager.get(task.id)));
  assert.equal(f.store.all<any>('ai_runs').filter((run) => run.status === 'completed').length, 1);
});

test('cancelling a real worker discards its SQLite copy and shutdown is safe while work is pending', async (t) => {
  const f = await aiFixture(t),
    release = f.hold();
  const task = await f.manager.start({
    operation: '/api/ai/explain',
    body: { questionId: 'FIXTURE-SHORT-1' },
  });
  await waitFor(() => f.calls() === 1, 'mock AI entered');
  await f.manager.cancel(task.id);
  release();
  await waitFor(() => f.manager.get(task.id).status === 'cancelled', 'worker cancelled');
  assert.equal(f.store.all('ai_runs').length, 0);
  assert.equal(f.store.all('questions').length, 6);
  assert.equal(taskWasCommitted(f.store, `${task.id}:0:1`), false);
  const pending = await f.manager.start({
    operation: '/api/packages/export',
    body: { kind: 'question-template' },
  });
  await f.manager.close();
  assert.equal(f.manager.get(pending.id).status, 'interrupted');
  assert.equal(
    (await readdir(join(f.directory, 'tasks'))).some((name) => name.startsWith('work-')),
    false,
  );
  await assert.rejects(
    () =>
      f.manager.start({ operation: '/api/packages/export', body: { kind: 'question-template' } }),
    { code: 'TASK_QUEUE_CLOSED' },
  );
});

test('failed provider calls retain safe AI audits, and partial document failures do not advance a checkpoint', async (t) => {
  const f = await aiFixture(t);
  f.fail(true);
  const failure = await f.run(
    { operation: '/api/ai/explain', body: { questionId: 'FIXTURE-SHORT-1' } },
    'failed',
  );
  assert.match(failure.error!.code, /AI_/);
  assert.equal(f.store.all<any>('ai_runs').filter((run) => run.status === 'failed').length, 1);
  assert.ok(!JSON.stringify(f.manager.list()).includes('TEST_PRIVATE_PROVIDER_DETAIL'));
  const job = await f.call(
    '/api/ai/document-jobs',
    {
      confirmed: true,
      sourceName: '隔离教材',
      sections: [{ label: 'A', text: '变量是名称和值之间的绑定关系。' }],
      categoryIds: ['fixture-basic'],
      questionsPerBlock: 1,
      maxQuestions: 1,
    },
    201,
  );
  const task = await f.run(
    {
      operation: `/api/ai/document-jobs/${job.id}/plan`,
      steps: [{ blockIds: [job.blocks[0].id] }],
    },
    'failed',
  );
  assert.equal(task.completedSteps, 0);
  assert.equal(f.store.require<any>('ai_import_jobs', job.id).blocks[0].planStatus, 'failed');
  assert.equal(f.store.all<any>('ai_runs').filter((run) => run.status === 'failed').length, 2);
  f.fail(false);
  await f.manager.retry(task.id);
  await waitFor(
    () => ['completed', 'failed'].includes(f.manager.get(task.id).status),
    'document retry finishes',
  );
  assert.equal(f.manager.get(task.id).status, 'completed', JSON.stringify(f.manager.get(task.id)));
  assert.equal(f.store.require<any>('ai_import_jobs', job.id).blocks[0].planStatus, 'completed');
  assert.equal(f.manager.get(task.id).completedSteps, 1);
});

test('disk task cache recovery retains corrupt files, resumes only explicit retries and honors durable markers once', async (t) => {
  const f = await fixture(t),
    storage = new DiskTaskStorage(join(f.directory, 'recovery'));
  const id = 'task-11111111-1111-4111-8111-111111111111',
    broken = 'task-22222222-2222-4222-8222-222222222222',
    date = new Date().toISOString();
  const task: BackgroundTask = {
    id,
    title: '恢复测试',
    operation: '/api/packages/export',
    method: 'POST',
    returnTo: '#/tasks',
    status: 'committing',
    stage: 'committing',
    message: '',
    current: 0,
    total: 1,
    completedSteps: 0,
    attempt: 1,
    cancellable: false,
    createdAt: date,
    updatedAt: date,
    read: true,
  };
  await storage.save(task);
  await storage.saveResult(id, {
    status: 200,
    contentType: 'application/json',
    json: { durable: true },
  });
  f.store.database.run(
    f.store.database.query
      .insertInto('metadata')
      .values({ key: taskCommitKey(`${id}:0:1`), value: date }),
  );
  await writeFile(join(storage.root, `${broken}.task.json`), '{broken');
  let calls = 0;
  const recovered = new BackgroundTaskManager(storage, {
    execute: async () => {
      calls++;
      throw Error('never execute during startup');
    },
    commit: async () => {},
    committed: async (key) => taskWasCommitted(f.store, key),
  });
  t.after(() => recovered.close());
  await recovered.initialize();
  assert.equal(recovered.get(id).status, 'completed');
  assert.equal(recovered.get(id).read, false);
  assert.equal(recovered.get(broken).error?.code, 'TASK_CACHE_CORRUPT');
  assert.equal(calls, 0);
  assert.equal(await readFile(join(storage.root, `${broken}.task.json`), 'utf8'), '{broken');
  const snapshot = taskSnapshot(f.store, '/api/ai/explain', { questionId: 'FIXTURE-SHORT-1' });
  const changes = snapshot.finish();
  commitTaskChanges(f.store, 'idempotent:0:1', changes);
  commitTaskChanges(f.store, 'idempotent:0:1', changes);
  assert.equal(
    f.store.database.one(
      f.store.database.query
        .selectFrom('metadata')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('key', '=', taskCommitKey('idempotent:0:1')),
    )!.count,
    1,
  );
});
