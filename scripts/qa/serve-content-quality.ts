/** Disposable quality-workbench fixture. Never opens the user's data directory. */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { buildApp } from '../../server/index.js';
const app = await buildApp({ databasePath: ':memory:', seedPath: 'no-quality-qa-seed', staticRoot: resolve('dist/web'), logger: false, dailyPushScheduler: false });
app.get('/qa/content-quality', async () => ({ questions: await api('/api/questions?status=all&pageSize=100'), issues: await api('/api/content-quality/issues?status=all&pageSize=100'), scans: await api('/api/content-quality/scans?pageSize=100'), feedback: await api('/api/question-feedback?status=all&pageSize=100'), backup: await api('/api/export') }));
async function api(url: string, payload?: unknown, method: any = payload === undefined ? 'GET' : 'POST') { const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) }); assert.ok(response.statusCode < 400, `${url}: ${response.statusCode} ${response.body.slice(0, 400)}`); return response.json(); }
await api('/api/domains', { id: 'quality-computer', name: '计算机' }); await api('/api/categories', { id: 'quality-core', domainId: 'quality-computer', name: '通用基础' });
for (let index = 0; index < 23; index++) {
  const added = await api('/api/questions', { id: 'QUALITY-' + String(index).padStart(2, '0'), title: `质量验收 ${index}`, type: 'short_answer', stemMarkdown: `解释唯一概念 ${index}。`, answerMarkdown: `参考说明 ${index}。`, explanationMarkdown: '', categoryIds: ['quality-core'], sourceRefs: [{ label: '待替换的来源占位地址', url: 'https://example.org/quality-' + index }] });
  await api('/api/questions/review', { ids: [added.id], action: 'approve', confirmed: true, expectedUpdatedAt: { [added.id]: added.updatedAt } });
}
const pending = await api('/api/questions', { id: 'QUALITY-PENDING', title: '待审核题同样可扫描', type: 'true_false', stemMarkdown: '事务原子性是否保证整体提交？', answerMarkdown: '正确', correctAnswers: ['true'], explanationMarkdown: '整体提交或回滚。', categoryIds: ['quality-core'] }); assert.equal(pending.status, 'pending');
const origin = await app.listen({ host: '127.0.0.1', port: 0 }); console.log('CONTENT_QUALITY_READY ' + JSON.stringify({ origin }));
async function close() { await app.close(); process.exit(0); } process.on('SIGTERM', () => void close()); process.on('SIGINT', () => void close());
