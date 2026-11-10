import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { listenOnLoopback } from '../../server/http/loopback.js';

test('local dynamic HTTP listeners are reachable through Fetch and stay on loopback', async () => {
  const server = createServer((_request, reply) => reply.end('ready'));
  try {
    await listenOnLoopback(
      (port) =>
        new Promise<void>((resolve, reject) => {
          const failed = (error: Error) => reject(error);
          server.once('error', failed);
          server.listen(port, '127.0.0.1', () => {
            server.off('error', failed);
            resolve();
          });
        }),
    );
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    assert.equal(address.address, '127.0.0.1');
    assert.equal(await (await fetch(`http://127.0.0.1:${address.port}`)).text(), 'ready');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('local port contention/reservations retry, but unrelated startup errors fail immediately', async () => {
  let calls = 0;
  const result = await listenOnLoopback(async (port) => {
    calls++;
    assert.ok(port >= 20000 && port < 60000);
    if (calls < 3)
      throw Object.assign(new Error('reserved'), { code: calls === 1 ? 'EACCES' : 'EADDRINUSE' });
    return 'listening';
  });
  assert.equal(result, 'listening');
  assert.equal(calls, 3);
  const failure = new Error('app initialization failed');
  await assert.rejects(
    listenOnLoopback(async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
});

test('port exhaustion is bounded and retains the final bind error', async () => {
  let calls = 0;
  const failure = Object.assign(new Error('no available bind'), { code: 'EADDRINUSE' });
  await assert.rejects(
    listenOnLoopback(async () => {
      calls++;
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(calls, 20);
});
