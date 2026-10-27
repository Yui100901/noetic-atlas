/** Optional one-call acceptance against the configured model. Reads only the
 * private settings from the working DB; every application write uses :memory:.
 * Sends synthetic public programming examples, never user questions or notes.
 * Run: node --import tsx scripts/qa/check-similar-live.ts */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildApp } from '../../server/index.js';
import { DatabaseConnection } from '../../server/database/connection.js';
import type { PrivateAiSettings } from '../../server/modules/ai/provider.js';

const output = resolve('test-results/similar-live', 'run-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid);
await mkdir(output, { recursive: true });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const readSettings = () => { const db = new DatabaseConnection(resolve('data/noetic-atlas.sqlite'), false); try { return db.getRecord<PrivateAiSettings>('ai_settings', 'local'); } finally { db.close(); } };
const settings = readSettings(); assert.ok(settings?.baseUrl && settings.model && settings.key, 'EXISTING_AI_CONFIGURATION_REQUIRED');
const settingsHash = hash(settings), providerHost = new URL(settings.baseUrl).hostname;
const secret = settings.key, redact = (text: string) => secret ? text.replaceAll(secret, '[redacted]') : text;
const originalFetch = globalThis.fetch; let providerCalls = 0;
globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
  const address = new URL(args[0] instanceof Request ? args[0].url : String(args[0]));
  assert.equal(address.hostname, providerHost, 'UNEXPECTED_EXTERNAL_REQUEST');
  assert.ok(++providerCalls <= 1, 'REAL_PROVIDER_REQUEST_BUDGET_EXCEEDED');
  return originalFetch(...args);
};
const app = await buildApp({ databasePath: ':memory:', seedPath: 'no-similar-live-seed', dailyPushScheduler: false, staticRoot: 'no-live-static-root' });
const checks: string[] = []; let failure: string | undefined;
try {
  const api = async (url: string, payload?: unknown, method: 'GET' | 'POST' | 'PUT' = 'POST') => {
    const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
    assert.ok(response.statusCode < 400, `${url}: ${response.statusCode} ${redact(response.body).slice(0, 1200)}`);
    return response.json();
  };
  const configs = await api('/api/ai/settings', undefined, 'GET');
  await api('/api/ai/settings', { ...Object.fromEntries(Object.entries(configs).filter(([key]) => !['hasKey', 'updatedAt'].includes(key))), enabled: true, baseUrl: settings.baseUrl, model: settings.model, key: secret, timeoutSeconds: Math.min(settings.timeoutSeconds, 120), supportsImages: false, sendImages: false }, 'PUT');
  const questions = [
    { id: 'SIM-LIVE-ROOT', title: 'Go互斥锁与竞态', stemMarkdown: '多个goroutine共同增加一个计数器，如何使用sync.Mutex避免数据竞争？', answerMarkdown: '在读改写共享计数器时对同一互斥锁执行Lock和Unlock。' },
    { id: 'SIM-LIVE-LOCK', title: 'Go互斥锁保护共享变量', stemMarkdown: '两个goroutine并发读写共享map，说明sync.Mutex的作用与锁保护范围。', answerMarkdown: '所有相关共享map操作必须受同一互斥锁保护。' },
    { id: 'SIM-LIVE-CHANNEL', title: 'Go通道与并发通信', stemMarkdown: '多个goroutine通过channel汇总各自计数，如何避免同时写共享计数器？', answerMarkdown: '由单一goroutine接收并汇总计数。' },
    { id: 'SIM-LIVE-SLICE', title: 'Go切片长度与容量', stemMarkdown: 'Go中len和cap的区别是什么？', answerMarkdown: 'len是当前元素数，cap是可用底层数组容量。' },
  ];
  for (const input of questions) {
    const question = await api('/api/questions', { ...input, type: 'short_answer', categoryIds: [], tagIds: [] });
    await api('/api/questions/review', { ids: [question.id], action: 'approve', confirmed: true, expectedUpdatedAt: { [question.id]: question.updatedAt } });
  }
  const before = await api('/api/questions/SIM-LIVE-ROOT', undefined, 'GET');
  const run = await api('/api/ai/similar-questions', { questionId: 'SIM-LIVE-ROOT', requirements: '优先推荐考查互斥锁保护共享数据的题；并发通信可作补充，不推荐切片基础。', confirmed: true });
  assert.equal(run.kind, 'similar_questions'); assert.equal(run.status, 'completed');
  assert.ok(run.result.items.length > 0); assert.ok(run.result.items.some((item: any) => item.questionId === 'SIM-LIVE-LOCK'));
  assert.ok(!run.result.items.some((item: any) => item.questionId === 'SIM-LIVE-ROOT'));
  assert.ok(run.result.items.every((item: any) => run.result.candidates.some((candidate: any) => candidate.id === item.questionId) && item.reason.trim()));
  checks.push('真实模型从现有候选中推荐互斥锁题，并给出非空理由；题号均属于候选');
  assert.equal(run.diagnostics.providerCalls, 1); assert.equal(providerCalls, 1);
  const stored = await api('/api/ai/runs/' + run.id, undefined, 'GET'); assert.deepEqual(stored.result, run.result);
  const history = await api('/api/ai/runs?kind=similar_questions&page=1&pageSize=10', undefined, 'GET'); assert.equal(history.total, 1);
  assert.deepEqual(await api('/api/questions/SIM-LIVE-ROOT', undefined, 'GET'), before);
  checks.push('成功记录和诊断可重读，原题及学习状态保持不变');
  await writeFile(resolve(output, 'result.json'), redact(JSON.stringify(run, null, 2)));
} catch (error) { failure = redact(String(error instanceof Error ? error.stack || error.message : error)); }
finally { globalThis.fetch = originalFetch; await app.close(); }
const settingsUnchanged = hash(readSettings()) === settingsHash;
const report = { passed: checks.length, checks, providerCalls, provider: providerHost, model: settings.model, database: ':memory:', settingsUnchanged, ...(failure ? { failure } : {}) };
const text = redact(JSON.stringify(report, null, 2)); assert.ok(!text.includes(secret));
await writeFile(resolve(output, 'report.json'), text); console.log(text);
assert.ok(settingsUnchanged, 'WORKING_CONFIGURATION_CHANGED'); assert.equal(failure, undefined);
