/** Actual routes with an isolated in-memory practice; never opens user data. */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { buildApp } from '../../server/index.js';

const app = await buildApp({ databasePath: ':memory:', seedPath: 'no-practice-timing-fixture', staticRoot: resolve('dist/web'), dailyPushScheduler: false });
let paperId = '', attemptId = '', failNextPause = false;
const calls: Array<{ action: string; sessionId: string; elapsedMilliseconds?: number }> = [];
app.addHook('preHandler', async (request, reply) => {
  if (/^\/api\/attempts\/[^/]+\/timing$/.test(request.url)) {
    const body = request.body as { action: string; sessionId: string; elapsedMilliseconds?: number }; calls.push(body);
    if (body.action === 'pause' && failNextPause) { failNextPause = false; return reply.code(503).send({ error: { code: 'QA_TIMING_UNAVAILABLE', message: '隔离验收：暂停暂时未保存' } }); }
  }
});
app.get('/qa/practice-timing', async () => { const value = await app.inject({ method: 'GET', url: `/api/attempts/${attemptId}` }); return { paperId, attemptId, calls, attempt: value.statusCode === 200 ? value.json() : null }; });
app.post('/qa/practice-timing/fail-pause', async () => { failNextPause = true; return { ok: true }; });
async function api(url: string, body?: unknown, method: any = 'POST') {
  const response = await app.inject({ method, url, ...(body === undefined ? {} : { payload: body }) });
  assert.ok(response.statusCode < 400, `${url}: ${response.statusCode} ${response.body.slice(0, 300)}`); return response.json();
}
const question = await api('/api/questions', { id: 'TIMING-Q', type: 'true_false', title: '普通练习计时验收', stemMarkdown: '普通练习离开后不应计时。', correctAnswers: ['true'] });
await api('/api/questions/review', { ids: [question.id], action: 'approve', confirmed: true, expectedUpdatedAt: { [question.id]: question.updatedAt } });
const paper = await api('/api/papers', { title: '普通练习暂停与恢复验收', mode: 'manual', questionIds: [question.id], scoring: { enabled: false } }); paperId = paper.id;
const attempt = await api(`/api/papers/${paperId}/attempts`, { mode: 'practice' }); attemptId = attempt.id;
const backend = await app.listen({ host: '127.0.0.1', port: 0 }); let origin = backend, dev: { close(): Promise<void> } | undefined;
if (process.env.QA_PRACTICE_DEV === '1') {
  const { createServer } = await import('vite');
  const proxy = { target: backend, changeOrigin: false };
  const vite = await createServer({ configFile: resolve('vite.config.ts'), logLevel: 'error', cacheDir: resolve('test-results/practice-timing-strict-ui/vite-cache'), optimizeDeps: { entries: [resolve('index.html')] }, server: { host: '127.0.0.1', port: 0, strictPort: false, proxy: { '/api': proxy, '/qa': proxy } } });
  await vite.listen();
  // Separate dev module transformation from the stopwatch assertions, as in
  // the existing source-loading QA harness. Do not alter interaction timeouts.
  const preparation = performance.now();
  await vite.environments.client.warmupRequest('/web/app/main.tsx');
  await vite.environments.client.waitForRequestsIdle();
  console.log('PRACTICE_TIMING_DEV_PREPARATION ' + JSON.stringify({ milliseconds: Math.round(performance.now() - preparation) }));
  dev = vite; origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
}
console.log('PRACTICE_TIMING_READY ' + JSON.stringify({ origin }));
const close = async () => { await dev?.close(); await app.close(); process.exit(0); };
process.on('SIGTERM', () => void close()); process.on('SIGINT', () => void close());
