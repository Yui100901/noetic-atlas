import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { z } from 'zod';
import { Store } from '../../server/core/store.js';
import { ApiError } from '../../server/core/validation.js';
import { auditAiOperation } from '../../server/modules/ai/audit.js';
import { aiFailedRunSchema, aiDiagnosticsSchema } from '../../server/modules/ai/audit-schema.js';
import { requestAiJson, type PrivateAiSettings } from '../../server/modules/ai/provider.js';
import { registerAiUsageRoutes, aiUsageStatistics } from '../../server/modules/ai/usage-routes.js';
import { aiHistoryPage, aiHistoryQuerySchema } from '../../server/modules/ai/history.js';
import { configureAiTransport, type AiTransport } from '../../shared/ai/ai-transport.js';
import {
  AI_TOKEN_FIELDS,
  reportedTokenUsage,
  attemptAiUsage,
  emptyAiUsage,
  addAiUsage,
} from '../../shared/ai/usage.js';
import type { AiDiagnostics } from '../../shared/ai/ai.js';
import { storedCompletedAiRunSchema } from '../../server/modules/ai/run-schema.js';
import { exportData, importData } from '../../server/modules/transfer/migration.js';

const settings: PrivateAiSettings = {
  enabled: true,
  baseUrl: 'https://usage-fixture.invalid/v1',
  model: 'fixture-model',
  key: 'usage-private-canary',
  supportsImages: false,
  sendImages: false,
  timeoutSeconds: 2,
  maxTokens: 1000,
  updatedAt: '2026-11-05T00:00:00Z',
};
const validator = z.object({ value: z.string() });
const envelope = (usage?: unknown, content = '{"value":"ok"}', finish = 'stop') =>
  JSON.stringify({ usage, choices: [{ message: { content }, finish_reason: finish }] });
const frame = (value: unknown) => 'data: ' + JSON.stringify(value) + '\n\n';
const choice = (content: string, finish_reason: string | null = null) => ({
  choices: [{ index: 0, delta: { content }, finish_reason }],
});
async function fixture(t: test.TestContext, transport: AiTransport, streaming = false) {
  const store = new Store(':memory:');
  configureAiTransport(transport, { streaming });
  t.after(() => {
    configureAiTransport();
    store.database.close();
  });
  let diagnostics: AiDiagnostics | undefined;
  const call = () => requestAiJson(settings, 'synthetic task', {}, {}, validator, [], context);
  let context: Parameters<typeof requestAiJson>[6];
  const run = async (operation = call) =>
    auditAiOperation(
      store,
      'explain',
      async (execution) => {
        context = execution;
        return operation();
      },
      { emit() {}, streaming },
      {
        onComplete(value) {
          diagnostics = value;
        },
      },
    );
  return { store, run, call, diagnostics: () => diagnostics };
}

test('supplier usage supports common aliases, actual zero and detail fields without summing or accepting arbitrary metadata', () => {
  const parsed = reportedTokenUsage({
    prompt_tokens: 10,
    completion_tokens: 4,
    total_tokens: 14,
    prompt_tokens_details: { cached_tokens: 6 },
    completion_tokens_details: { reasoning_tokens: 2 },
    prompt_cache_miss_tokens: 4,
    key: 'private-canary',
  });
  assert.equal(parsed?.inputTokens, 10);
  assert.equal(parsed?.totalTokens, 14);
  assert.equal(parsed?.cacheReadInputTokens, 6);
  assert.equal(parsed?.cacheMissInputTokens, 4);
  assert.equal(parsed?.reasoningTokens, 2);
  assert.ok(!JSON.stringify(parsed).includes('private-canary'));
  assert.equal(
    reportedTokenUsage({ input_tokens: 0, output_tokens: 0, total_tokens: 0 })?.totalTokens,
    0,
  );
  assert.equal(
    reportedTokenUsage({ inputTokens: 3, outputTokens: 2, totalTokens: 5 })?.totalTokens,
    5,
  );
  assert.equal(
    reportedTokenUsage({
      promptTokenCount: 3,
      candidatesTokenCount: 4,
      totalTokenCount: 8,
      thoughtsTokenCount: 1,
    })?.totalTokens,
    8,
  );
  assert.equal(
    reportedTokenUsage({ prompt_tokens: '100', completion_tokens: -1, total_tokens: Infinity }),
    undefined,
  );
  const partial = reportedTokenUsage({
    input_tokens: 12,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 7,
  });
  assert.equal(partial?.inputTokens, 12);
  assert.equal(partial?.totalTokens, null);
});

test('buffered and native-compatible provider responses retain supplier usage even when subsequent validation fails', async (t) => {
  const f = await fixture(t, async () => ({
    status: 200,
    body: envelope({
      prompt_tokens: 11,
      completion_tokens: 4,
      total_tokens: 15,
      prompt_cache_hit_tokens: 8,
    }),
  }));
  await f.run();
  const value = f.diagnostics()!;
  assert.equal(value.usage?.totalTokens, 15);
  assert.equal(value.usage?.status, 'complete');
  assert.equal(value.provider, 'https://usage-fixture.invalid');
  assert.equal(value.attempts[0].usageFinal, true);
  assert.equal(aiDiagnosticsSchema.safeParse(value).success, true);
  configureAiTransport(async () => ({
    status: 200,
    body: envelope({ input_tokens: 7, output_tokens: 9, total_tokens: 16 }, 'not-json'),
  }));
  await assert.rejects(f.run(), (e: any) => e.code === 'AI_INVALID_JSON');
  const failed = f.store.all<any>('ai_runs')[0];
  assert.equal(failed.diagnostics.usage.totalTokens, 16);
  assert.equal(failed.diagnostics.usage.status, 'complete');
  assert.equal(aiFailedRunSchema.safeParse(failed).success, true);
  assert.ok(!JSON.stringify(failed).includes(settings.key));
});

test('SSE usage-only frames and repeated cumulative counts use the final report once, without leaking usage into answer events', async (t) => {
  const events: unknown[] = [];
  const f = await fixture(
    t,
    async (_url, options) => {
      const sent = JSON.parse(options.body);
      assert.equal(sent.stream_options.include_usage, true);
      const payload =
        frame({
          ...choice('{"value":"ok"}'),
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        }) +
        frame(choice('', 'stop')) +
        frame({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }) +
        frame({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }) +
        'data: [DONE]\n\n';
      options.onChunk!(new TextEncoder().encode(payload), {
        status: 200,
        contentType: 'text/event-stream',
      });
      return { status: 200, body: '', streamed: true };
    },
    true,
  );
  const result = await auditAiOperation(
    f.store,
    'explain',
    (execution) => requestAiJson(settings, 'task', {}, {}, validator, [], execution),
    {
      emit(event) {
        events.push(event);
      },
      streaming: true,
    },
    {
      onComplete(value) {
        assert.equal(value.usage?.totalTokens, 7);
        assert.equal(value.usage?.reportedCalls, 1);
        assert.equal(value.usage?.status, 'complete');
      },
    },
  );
  assert.equal(result.value, 'ok');
  assert.ok(!JSON.stringify(events).includes('prompt_tokens'));
  assert.ok(!JSON.stringify(events).includes('provider_usage'));
});

test('interrupted or cancelled SSE retains known interim usage as partial while absent reports remain unknown', async (t) => {
  const f = await fixture(
    t,
    async (_url, options) => {
      options.onChunk!(
        new TextEncoder().encode(
          frame({
            ...choice('{"value":"ok"}'),
            usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
          }),
        ),
        { status: 200, contentType: 'text/event-stream' },
      );
      return { status: 200, body: '', streamed: true };
    },
    true,
  );
  await assert.rejects(f.run(), (e: any) => e.code === 'AI_OUTPUT_TRUNCATED');
  let failed = f.store.all<any>('ai_runs')[0];
  assert.equal(failed.diagnostics.usage.totalTokens, 7);
  assert.equal(failed.diagnostics.usage.status, 'partial');
  assert.equal(failed.diagnostics.usage.completeCalls, 0);
  configureAiTransport(async () => ({ status: 200, body: envelope() }));
  await f.run();
  assert.equal(f.diagnostics()?.usage?.status, 'unknown');
  assert.equal(f.diagnostics()?.usage?.totalTokens, null);
  configureAiTransport(async () => ({
    status: 200,
    body: envelope({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }),
  }));
  await f.run();
  assert.equal(f.diagnostics()?.usage?.totalTokens, 0);
  assert.equal(f.diagnostics()?.usage?.status, 'complete');
});

test('multiple provider attempts include known usage from all calls while exposing missing coverage', async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => ({
    status: 200,
    body: envelope(
      ++calls === 2 ? undefined : { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    ),
  }));
  await f.run(async () => {
    await f.call();
    await f.call();
    return f.call();
  });
  const usage = f.diagnostics()!.usage!;
  assert.equal(usage.calls, 3);
  assert.equal(usage.reportedCalls, 2);
  assert.equal(usage.completeCalls, 2);
  assert.equal(usage.totalTokens, 30);
  assert.equal(usage.status, 'partial');
});

test('aggregated usage survives the bounded attempt diagnostic log without losing earlier call totals', async (t) => {
  const f = await fixture(t, async () => ({
    status: 200,
    body: envelope({ input_tokens: 1, output_tokens: 1, total_tokens: 2 }),
  }));
  await f.run(async () => {
    for (let i = 0; i < 202; i++) await f.call();
    return { value: 'all' };
  });
  assert.equal(f.diagnostics()?.attempts.length, 200);
  assert.equal(f.diagnostics()?.usage?.calls, 202);
  assert.equal(f.diagnostics()?.usage?.totalTokens, 404);
});

test('statistics filter time/model/task across the full selection and preserve missing historical coverage', async (t) => {
  const store = new Store(':memory:'),
    app = Fastify();
  t.after(async () => {
    await app.close();
    store.database.close();
  });
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code(error instanceof ApiError ? error.status : 500)
      .send({ error: { message: error.message } }),
  );
  registerAiUsageRoutes(app, store);
  const usage = attemptAiUsage(
    reportedTokenUsage({ input_tokens: 10, output_tokens: 2, total_tokens: 12 }),
    true,
  );
  for (const [id, kind, model, createdAt, status] of [
    ['first', 'explain', 'model-a', '2026-11-05T00:00:00Z', 'completed'],
    ['second', 'grade', 'model-a', '2026-11-05T08:30:00+08:00', 'failed'],
    ['third', 'explain', 'model-b', '2026-11-06T00:00:00Z', 'completed'],
    ['old', 'explain', 'model-a', '2026-11-05T01:00:00Z', 'completed'],
  ])
    store.database.putRecord('ai_runs', id, {
      id,
      kind,
      model,
      createdAt,
      status,
      result: { privateResult: 'SHOULD_NOT_BE_MATERIALIZED' },
      _context: { private: 'HIDDEN_CONTEXT' },
      ...(id === 'old'
        ? {}
        : { diagnostics: { provider: 'https://fixture.invalid', providerCalls: 1, usage } }),
    });
  const response = await app.inject(
    '/api/ai/usage?model=model-a&from=2026-11-05T00%3A00%3A00Z&before=2026-11-06T00%3A00%3A00Z&page=1&pageSize=10',
  );
  assert.equal(response.statusCode, 200);
  const report = response.json();
  assert.equal(report.runs, 3);
  assert.equal(report.failedRuns, 1);
  assert.equal(report.unknownCallRuns, 1);
  assert.equal(report.usage.totalTokens, 24);
  assert.equal(report.usage.status, 'partial');
  assert.equal(report.groups.length, 3);
  assert.ok(!response.body.includes('SHOULD_NOT_BE_MATERIALIZED'));
  assert.ok(!response.body.includes('HIDDEN_CONTEXT'));
  const filtered = aiUsageStatistics(
    store,
    aiHistoryQuerySchema.parse({ model: 'model-a', kind: 'grade' }),
  );
  assert.equal(filtered.runs, 1);
  assert.equal(filtered.usage.totalTokens, 12);
  const page = aiHistoryPage(
    store,
    aiHistoryQuerySchema.parse({
      model: 'model-a',
      kind: 'grade',
      from: '2026-11-05T00:00:00Z',
      before: '2026-11-05T01:00:00Z',
      page: 1,
      pageSize: 10,
    }),
    (value) => value,
  ) as any;
  assert.equal(page.total, 1);
  assert.equal(
    (
      await app.inject(
        '/api/ai/usage?from=2026-11-06T00%3A00%3A00Z&before=2026-11-05T00%3A00%3A00Z',
      )
    ).statusCode,
    400,
  );
});

test('saved successful connection tests validate and usage schemas reject opaque private fields', async (t) => {
  const f = await fixture(t, async () => ({
    status: 200,
    body: envelope({ input_tokens: 1, output_tokens: 1, total_tokens: 2 }),
  }));
  await auditAiOperation(f.store, 'connection_test', async (execution) => {
    await requestAiJson(settings, 'task', {}, {}, validator, [], execution);
    return { ok: true, message: 'connected', model: settings.model };
  });
  const saved = f.store.all<any>('ai_runs')[0];
  assert.equal(storedCompletedAiRunSchema.safeParse(saved).success, true);
  assert.equal(saved.diagnostics.usage.totalTokens, 2);
  assert.equal(
    aiDiagnosticsSchema.safeParse({
      ...saved.diagnostics,
      usage: { ...saved.diagnostics.usage, key: 'opaque-secret' },
    }).success,
    false,
  );
  for (const field of AI_TOKEN_FIELDS)
    assert.ok(
      saved.diagnostics.usage[field] === null || typeof saved.diagnostics.usage[field] === 'number',
    );
  assert.equal(addAiUsage(emptyAiUsage(), attemptAiUsage()).status, 'unknown');
});

test('a completion without a final usage report keeps an earlier counter partial', async (t) => {
  const f = await fixture(
    t,
    async (_url, options) => {
      const payload =
        frame({
          ...choice('{"value":"ok"}'),
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        }) +
        frame(choice('', 'stop')) +
        'data: [DONE]\n\n';
      options.onChunk!(new TextEncoder().encode(payload), {
        status: 200,
        contentType: 'text/event-stream',
      });
      return { status: 200, body: '', streamed: true };
    },
    true,
  );
  await f.run();
  assert.equal(f.diagnostics()?.usage?.totalTokens, 6);
  assert.equal(f.diagnostics()?.usage?.status, 'partial');
  assert.equal(f.diagnostics()?.usage?.completeCalls, 0);
});

test('an explicitly unsupported usage option retries once and records both attempts with honest coverage', async (t) => {
  let calls = 0;
  const f = await fixture(
    t,
    async (_url, options) => {
      const sent = JSON.parse(options.body);
      if (++calls === 1) {
        assert.deepEqual(sent.stream_options, { include_usage: true });
        return {
          status: 400,
          body: JSON.stringify({
            error: { message: 'Unsupported parameter: stream_options.include_usage' },
          }),
        };
      }
      assert.equal(sent.stream_options, undefined);
      const payload =
        frame(choice('{"value":"ok"}', 'stop')) +
        frame({ choices: [], usage: { input_tokens: 9, output_tokens: 2, total_tokens: 11 } }) +
        'data: [DONE]\n\n';
      options.onChunk!(new TextEncoder().encode(payload), {
        status: 200,
        contentType: 'text/event-stream',
      });
      return { status: 200, body: '', streamed: true };
    },
    true,
  );
  await f.run();
  assert.equal(calls, 2);
  const value = f.diagnostics()!;
  assert.equal(value.providerCalls, 2);
  assert.equal(value.attempts[0].code, 'AI_USAGE_OPTION_UNSUPPORTED');
  assert.equal(value.usage?.totalTokens, 11);
  assert.equal(value.usage?.reportedCalls, 1);
  assert.equal(value.usage?.status, 'partial');
  assert.equal(aiDiagnosticsSchema.safeParse(value).success, true);
});

test('other provider errors do not trigger a compatibility retry or leak their response body', async (t) => {
  let calls = 0;
  const f = await fixture(
    t,
    async () => {
      calls++;
      return {
        status: 400,
        body: JSON.stringify({
          error: { message: 'Unknown parameter max_tokens; PRIVATE_ERROR_BODY' },
        }),
      };
    },
    true,
  );
  await assert.rejects(f.run(), (error: any) => error.code === 'AI_PROVIDER_ERROR');
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(f.store.all('ai_runs')).includes('PRIVATE_ERROR_BODY'));
});

test('cancellation retains supplier-reported interim usage without inventing a final total', async (t) => {
  const controller = new AbortController();
  const f = await fixture(
    t,
    async (_url, options) => {
      options.onChunk!(
        new TextEncoder().encode(
          frame({ ...choice('{"value":'), usage: { input_tokens: 5, output_tokens: 1 } }),
        ),
        { status: 200, contentType: 'text/event-stream' },
      );
      controller.abort();
      throw new Error('AI_CANCELLED');
    },
    true,
  );
  await assert.rejects(
    auditAiOperation(
      f.store,
      'explain',
      (context) => requestAiJson(settings, 'task', {}, {}, validator, [], context),
      { emit() {}, streaming: true, signal: controller.signal },
    ),
    (error: any) => error.code === 'AI_CANCELLED',
  );
  const saved = f.store.all<any>('ai_runs')[0];
  assert.equal(saved.status, 'cancelled');
  assert.equal(saved.diagnostics.usage.inputTokens, 5);
  assert.equal(saved.diagnostics.usage.totalTokens, null);
  assert.equal(saved.diagnostics.usage.status, 'partial');
});

test('private usage records retain strict restore contracts while ordinary JSON migration excludes them', async (t) => {
  const f = await fixture(t, async () => ({
    status: 200,
    body: envelope({ input_tokens: 3, output_tokens: 1, total_tokens: 4 }),
  }));
  await auditAiOperation(f.store, 'connection_test', async (execution) => {
    await requestAiJson(settings, 'task', {}, {}, validator, [], execution);
    return { ok: true, message: 'connected', model: settings.model };
  });
  configureAiTransport(async () => ({
    status: 200,
    body: envelope({ input_tokens: 7, output_tokens: 2, total_tokens: 9 }, 'invalid'),
  }));
  await assert.rejects(f.run());
  const exported = exportData(f.store),
    target = new Store(':memory:');
  t.after(() => target.database.close());
  importData(target, exported);
  assert.equal(target.all<any>('ai_runs').length, 0);
  assert.equal(f.store.all<any>('ai_runs').length, 2);
  assert.deepEqual(
    f.store
      .all<any>('ai_runs')
      .map((run) => run.diagnostics.usage.totalTokens)
      .sort(),
    [4, 9],
  );
  assert.ok(!JSON.stringify(exported).includes(settings.key));
  for (const run of f.store.all<any>('ai_runs'))
    assert.equal(
      (run.status === 'completed' ? storedCompletedAiRunSchema : aiFailedRunSchema).safeParse(run)
        .success,
      true,
    );
});

test('a malformed final usage field cannot promote an earlier interim count to complete', async (t) => {
  const f = await fixture(
    t,
    async (_url, options) => {
      const payload =
        frame({
          ...choice('{"value":"ok"}'),
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        }) +
        frame(choice('', 'stop')) +
        frame({
          choices: [],
          usage: { prompt_tokens: 5, completion_tokens: -1, total_tokens: 6 },
        }) +
        'data: [DONE]\n\n';
      options.onChunk!(new TextEncoder().encode(payload), {
        status: 200,
        contentType: 'text/event-stream',
      });
      return { status: 200, body: '', streamed: true };
    },
    true,
  );
  await f.run();
  assert.equal(f.diagnostics()?.usage?.outputTokens, 1);
  assert.equal(f.diagnostics()?.usage?.status, 'partial');
});
