/** Isolated document/diagnostics UI fixture. No working data or real AI calls. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { buildApp } from '../../server/index.js';

const app = await buildApp({ databasePath: ':memory:', seedPath: 'no-document-ui-seed', staticRoot: resolve('dist/web'), logger: false, dailyPushScheduler: false });
const requests: Array<{ kind: string; sourceName: string; count?: number; success: boolean }> = [];
const failed = new Set<string>();
app.get('/qa/ai-document', async () => ({ jobs: await api('/api/ai/document-jobs?page=1&pageSize=100', undefined, 'GET'), questions: await api('/api/questions?status=all&pageSize=200', undefined, 'GET'), runs: await api('/api/ai/runs?page=1&pageSize=100', undefined, 'GET'), requests }));
const provider = createServer(async (request, response) => {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const input = JSON.parse(body.messages[1].content), material = input.untrustedMaterial;
  const sourceName = material.sourceName || '', text = material.text || '';
  const planning = !!input.outputSchema.summary, kind = planning ? 'plan' : 'generate';
  const limit = Number(/最多(\d+)道/.exec(input.task)?.[1] || 1);
  const key = kind + ':' + sourceName;
  if ((planning && text.includes('QA_PLAN_RETRY') || !planning && text.includes('QA_GENERATE_RETRY')) && !failed.has(key)) {
    failed.add(key); requests.push({ kind, sourceName, count: limit, success: false }); response.writeHead(planning ? 429 : 503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'PRIVATE_PROVIDER_BODY_SHOULD_NOT_APPEAR' } })); return;
  }
  if (text.includes('QA_SLOW') && !failed.has(key)) { failed.add(key); await new Promise(done => setTimeout(done, 2000)); }
  requests.push({ kind, sourceName, count: limit, success: true });
  const concept = sourceName.includes('retry') ? '事务原子性' : sourceName.includes('precedence') ? '运算优先级' : '变量与值';
  const result = planning ? { title: `${concept}知识块`, summary: `该块说明${concept}及其适用场景，依据所选资料正文。`, topics: [concept] } : {
    questions: Array.from({ length: limit }, (_, index) => ({ title: `${concept}练习${index + 1}`, type: 'short_answer', stemMarkdown: `说明${concept}，并给出第${index + 1}个适用场景。`, answerMarkdown: `回答${concept}的定义及适用条件。`, explanationMarkdown: `根据所选资料，${concept}应结合具体条件理解。`, difficulty: 2 })), taxonomySuggestions: { domains: [], categories: [], tags: [] },
  };
  if (!response.destroyed) { response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' }); response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] })); }
});
await new Promise<void>(done => provider.listen(0, '127.0.0.1', done));
async function api(url: string, payload?: unknown, method: any = 'POST') { const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) }); assert.ok(response.statusCode < 400, `${url}: ${response.statusCode}`); return response.json(); }
await api('/api/domains', { id: 'document-computer', name: '计算机' });
await api('/api/categories', { id: 'document-python', domainId: 'document-computer', name: '教材基础' });
await api('/api/ai/settings', { enabled: true, baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}`, model: 'document-loopback', key: 'qa-placeholder', timeoutSeconds: 30, maxTokens: 4096, supportsImages: false, sendImages: false }, 'PUT');
const origin = await app.listen({ host: '127.0.0.1', port: 0 }); console.log('AI_DOCUMENT_READY ' + JSON.stringify({ origin }));
async function close() { await app.close(); await new Promise<void>(done => provider.close(() => done())); process.exit(0); }
process.on('SIGTERM', () => void close()); process.on('SIGINT', () => void close());
