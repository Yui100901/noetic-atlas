import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { requestAiJson, type PrivateAiSettings } from '../../server/modules/ai/provider.js';
import { configureAiTransport } from '../../shared/ai/ai-transport.js';
import { createSseParser, type SseEvent } from '../../shared/ai/sse.js';
import type { AiExecutionContext, AiProgressUpdate } from '../../shared/ai/ai-progress.js';

const settings: PrivateAiSettings = {
  enabled: true, baseUrl: 'http://127.0.0.1:1', model: 'local-stream-fixture', key: 'fixture-secret-not-for-errors',
  supportsImages: false, sendImages: false, timeoutSeconds: 2, maxTokens: 1000, updatedAt: '2026-10-23T00:00:00.000Z',
};
const schema = z.object({ value: z.string() });
const event = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\r\n\r\n`;
const complete = (content: string) => event({ content }) + event({}, 'stop') + 'data: [DONE]\r\n\r\n';
const jsonEnvelope = (value: unknown) => JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] });
const context = (events: AiProgressUpdate[], signal?: AbortSignal): AiExecutionContext => ({ emit: update => events.push(update), signal });
function code(expected: string) { return (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected; }
async function provider(t: test.TestContext, handler: (request: IncomingMessage, response: ServerResponse, body: any) => Promise<void> | void) {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    try { await handler(request, response, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch (error) { if (!response.destroyed) response.destroy(error as Error); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { ...settings, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` };
}

test('SSE parser decodes split UTF-8, CRLF, CR, comments, event names and multiple data lines', () => {
  const events: SseEvent[] = [], parser = createSseParser(item => events.push(item));
  const bytes = new TextEncoder().encode('\uFEFF: 心跳\r\nid: 7\r\nevent: delta\r\ndata: 汉字🌍\r\ndata: 第二行\r\n\r\n:data hidden\rdata: 尾帧');
  for (const byte of bytes) parser.push(Uint8Array.of(byte));
  parser.finish();
  assert.deepEqual(events, [{ event: 'delta', id: '7', data: '汉字🌍\n第二行' }, { event: 'message', id: '7', data: '尾帧' }]);
});

test('real HTTP SSE publishes content before final response, preserves byte splits and excludes hidden reasoning', async t => {
  let finish!: () => void, first!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const seen = new Promise<void>(resolve => { first = resolve; });
  const events: AiProgressUpdate[] = [];
  const config = await provider(t, async (_request, response, body) => {
    assert.equal(body.stream, true);
    response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
    response.write(': keepalive\r\n\r\n');
    response.write(event({ reasoning_content: 'private hidden chain must never appear' }));
    const bytes = Buffer.from(event({ content: '{"value":"汉' }));
    const split = bytes.indexOf(Buffer.from('汉')) + 1;
    response.write(bytes.subarray(0, split)); await delay(5); response.write(bytes.subarray(split));
    await gate;
    response.end(event({ content: '字🌍"}' }) + event({}, 'stop') + 'data: [DONE]\r\n\r\n');
  });
  let settled = false;
  const result = requestAiJson(config, 'stream test', {}, {}, schema, [], { emit(update) { events.push(update); if (update.type === 'delta') first(); } }).finally(() => { settled = true; });
  await seen;
  assert.equal(settled, false, 'delta must arrive while response is still open');
  assert.equal(events.filter(e => e.type === 'delta').map(e => e.text).join(''), '{"value":"汉');
  finish();
  assert.deepEqual(await result, { value: '汉字🌍' });
  assert.ok(!JSON.stringify(events).includes('private hidden chain'));
  assert.equal(events[0]?.type === 'status' && events[0].stage, 'model_start');
});

test('SSE allows a missing DONE after explicit stop and an EOF final frame', async t => {
  const config = await provider(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(event({ content: '{"value":"complete"}' }) + event({}, 'stop').trimEnd());
  });
  assert.deepEqual(await requestAiJson(config, 'test', {}, {}, schema, [], context([])), { value: 'complete' });
});

test('SSE truncation, refusal, malformed frames, provider errors and schema failures never produce a result', async t => {
  const cases = [
    { name: 'missing finish', body: event({ content: '{"value":"looks complete"}' }), error: 'AI_OUTPUT_TRUNCATED' },
    { name: 'DONE without finish', body: event({ content: '{"value":"looks complete"}' }) + 'data: [DONE]\n\n', error: 'AI_OUTPUT_TRUNCATED' },
    { name: 'length finish', body: event({ content: '{"value":"looks complete"}' }, 'length'), error: 'AI_OUTPUT_TRUNCATED' },
    { name: 'interrupted finish', body: event({}, 'insufficient_system_resource'), error: 'AI_OUTPUT_TRUNCATED' },
    { name: 'refusal', body: event({ refusal: 'provider secret diagnostics' }), error: 'AI_REFUSED' },
    { name: 'content filter', body: event({}, 'content_filter'), error: 'AI_REFUSED' },
    { name: 'broken frame', body: 'data: {"choices":\n\n', error: 'AI_INVALID_JSON' },
    { name: 'provider error', body: 'data: {"error":{"message":"fixture-secret-not-for-errors"}}\n\n', error: 'AI_PROVIDER_ERROR' },
    { name: 'invalid final JSON', body: complete('broken'), error: 'AI_INVALID_JSON' },
    { name: 'invalid schema', body: complete('{"value":5}'), error: 'AI_INVALID_OUTPUT' },
    { name: 'reasoning only', body: event({ reasoning_content: 'private reasoning' }) + event({}, 'stop'), error: 'AI_EMPTY_RESPONSE' },
  ];
  for (const item of cases) await t.test(item.name, async sub => {
    const config = await provider(sub, (_request, response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' }); response.end(item.body); });
    const events: AiProgressUpdate[] = [];
    await assert.rejects(requestAiJson(config, 'test', {}, {}, schema, [], context(events)), error => {
      assert.ok(!String(error).includes(settings.key)); return code(item.error)(error);
    });
    assert.ok(!JSON.stringify(events).includes('provider secret diagnostics'));
    assert.ok(!JSON.stringify(events).includes(settings.key));
  });
});

test('provider ignoring stream:true returns ordinary JSON without simulated typing', async t => {
  const config = await provider(t, (_request, response, body) => {
    assert.equal(body.stream, true); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(jsonEnvelope({ value: 'buffered' }));
  });
  const events: AiProgressUpdate[] = [];
  assert.deepEqual(await requestAiJson(config, 'test', {}, {}, schema, [], context(events)), { value: 'buffered' });
  assert.equal(events.some(e => e.type === 'delta'), false);
  assert.ok(events.some(e => e.type === 'status' && e.stage === 'buffered_response'));
});

test('buffered native transport requests stream:false and displays factual transport status', async t => {
  t.after(() => configureAiTransport());
  configureAiTransport(async (_url, options) => {
    assert.equal(JSON.parse(options.body).stream, false); assert.equal(options.onChunk, undefined);
    return { status: 200, body: jsonEnvelope({ value: 'native buffered' }) };
  });
  const events: AiProgressUpdate[] = [];
  assert.deepEqual(await requestAiJson(settings, 'test', {}, {}, schema, [], context(events)), { value: 'native buffered' });
  assert.ok(events.some(e => e.type === 'status' && e.stage === 'buffered_transport'));
  assert.equal(events.some(e => e.type === 'delta'), false);
});

test('stream-capable configured transport opts into real byte progress', async t => {
  t.after(() => configureAiTransport());
  configureAiTransport(async (_url, options) => {
    assert.equal(JSON.parse(options.body).stream, true);
    options.onChunk!(new TextEncoder().encode(complete('{"value":"native live"}')), { status: 200, contentType: 'text/event-stream' });
    return { status: 200, body: '', streamed: true };
  }, { streaming: true });
  const events: AiProgressUpdate[] = [];
  assert.deepEqual(await requestAiJson(settings, 'test', {}, {}, schema, [], context(events)), { value: 'native live' });
  assert.ok(events.some(e => e.type === 'delta'));
});

test('external cancellation aborts a live fetch and excludes late content', async t => {
  const controller = new AbortController(), events: AiProgressUpdate[] = [];
  const config = await provider(t, async (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(event({ content: '{"value":"early' }));
    await delay(50); if (!response.destroyed) response.end(event({ content: 'late"}' }) + event({}, 'stop'));
  });
  await assert.rejects(requestAiJson(config, 'test', {}, {}, schema, [], {
    signal: controller.signal, emit(update) { events.push(update); if (update.type === 'delta') controller.abort(); },
  }), code('AI_CANCELLED'));
  await delay(60);
  assert.ok(!JSON.stringify(events).includes('late'));
});

test('buffered native cancellation discards its late response even when transport cannot stop', async t => {
  t.after(() => configureAiTransport());
  let requestStarted!: () => void;
  const started = new Promise<void>(resolve => { requestStarted = resolve; });
  let networkSignal: AbortSignal | undefined;
  configureAiTransport(async (_url, options) => {
    networkSignal = options.signal; requestStarted(); await delay(40); return { status: 200, body: jsonEnvelope({ value: 'too late' }) };
  });
  const controller = new AbortController(), events: AiProgressUpdate[] = [];
  const result = requestAiJson(settings, 'test', {}, {}, schema, [], context(events, controller.signal));
  await started; controller.abort();
  await assert.rejects(result, code('AI_CANCELLED'));
  assert.equal(networkSignal?.aborted, true);
  const count = events.length; await delay(50); assert.equal(events.length, count);
});

test('provider timeout and HTTP errors remain classified without exposing response bodies', async t => {
  await t.test('timeout', async sub => {
    const config = await provider(sub, async (_request, response) => { await delay(100); if (!response.destroyed) response.end(jsonEnvelope({ value: 'late' })); });
    await assert.rejects(requestAiJson({ ...config, timeoutSeconds: 0.02 }, 'test', {}, {}, schema, [], context([])), code('AI_TIMEOUT'));
  });
  await t.test('HTTP error', async sub => {
    const config = await provider(sub, (_request, response) => { response.writeHead(401); response.end(`secret ${settings.key}`); });
    const events: AiProgressUpdate[] = [];
    await assert.rejects(requestAiJson(config, 'test', {}, {}, schema, [], context(events)), error => {
      assert.ok(!String(error).includes(settings.key)); return code('AI_PROVIDER_ERROR')(error);
    });
    assert.ok(!JSON.stringify(events).includes(settings.key));
  });
});

test('SSE metadata may exceed 2 MiB while answer text retains the 2 MiB cap', async t => {
  await t.test('large wire metadata and small answer', async sub => {
    const config = await provider(sub, (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (let i = 0; i < 3; i++) response.write(`data: ${JSON.stringify({ usage: { metadata: 'x'.repeat(800_000) }, choices: [] })}\n\n`);
      response.end(complete('{"value":"small"}'));
    });
    assert.deepEqual(await requestAiJson(config, 'test', {}, {}, schema, [], context([])), { value: 'small' });
  });
  await t.test('large answer', async sub => {
    const config = await provider(sub, (_request, response) => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end(complete(JSON.stringify({ value: 'x'.repeat(2 * 1024 * 1024) }))); });
    await assert.rejects(requestAiJson(config, 'test', {}, {}, schema, [], context([])), code('AI_RESPONSE_TOO_LARGE'));
  });
});

test('input limit and an already cancelled request fail before provider transport', async t => {
  t.after(() => configureAiTransport()); let calls = 0;
  configureAiTransport(async () => { calls++; return { status: 200, body: jsonEnvelope({ value: 'unexpected' }) }; });
  await assert.rejects(requestAiJson(settings, 'test', {}, { text: 'x'.repeat(600_001) }, schema, [], context([])), code('AI_INPUT_TOO_LARGE'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(requestAiJson(settings, 'test', {}, {}, schema, [], context([], controller.signal)), code('AI_CANCELLED'));
  assert.equal(calls, 0);
});

test('independent stream wire limit stops excessive metadata before decoding it', async t => {
  t.after(() => configureAiTransport());
  configureAiTransport(async (_url, options) => {
    options.onChunk!(new Uint8Array(32 * 1024 * 1024 + 1), { status: 200, contentType: 'text/event-stream' });
    return { status: 200, body: '', streamed: true };
  }, { streaming: true });
  await assert.rejects(requestAiJson(settings, 'test', {}, {}, schema, [], context([])), code('AI_STREAM_TOO_LARGE'));
});
