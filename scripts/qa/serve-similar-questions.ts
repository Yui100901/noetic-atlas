/** Disposable UI fixture: actual app routes, memory SQLite, loopback model. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { buildApp } from '../../server/index.js';

const app = await buildApp({ databasePath: ':memory:', seedPath: 'no-similar-ui-seed', staticRoot: resolve('dist/web'), dailyPushScheduler: false });
const calls: Array<{ requirements: string; sourceId: string; partId?: string; ids: string[]; success: boolean }> = [];
let paperId = '';
app.get('/qa/similar', async () => ({ paperId, paper: await api(`/api/papers/${paperId}`, undefined, 'GET'), calls, runs: await api('/api/ai/runs?page=1&pageSize=100', undefined, 'GET'), source: await api('/api/questions/SIM-S1', undefined, 'GET') }));
let failOnce = true;
const provider = createServer(async (request, response) => {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const input = JSON.parse(body.messages[1].content).untrustedMaterial;
  const failed = input.requirements.includes('QA_FAIL_ONCE') && failOnce;
  calls.push({ requirements: input.requirements, sourceId: input.source.questionId, partId: input.source.partId, ids: input.candidates.map((item: any) => item.questionId), success: !failed });
  await new Promise(done => setTimeout(done, 350));
  if (failed) { failOnce = false; response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'PRIVATE_SIMILAR_PROVIDER_PAYLOAD' } })); return; }
  const content = { items: input.candidates.slice(0, 3).map((item: any) => ({ questionId: item.questionId, reason: '同样考查事务原子性，可作为相同考点的不同问法练习。' })) };
  response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] }));
});
await new Promise<void>(done => provider.listen(0, '127.0.0.1', done));
async function api(url: string, payload?: unknown, method: any = 'POST') {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) });
  assert.ok(response.statusCode < 400, `${url}: ${response.statusCode} ${response.body.slice(0, 300)}`); return response.json();
}
await api('/api/domains', { id: 'similar-computer', name: '计算机' });
await api('/api/categories', { id: 'similar-database', domainId: 'similar-computer', name: '数据库事务' });
async function question(spec: Record<string, unknown>, publish = true) { const value = await api('/api/questions', spec); if (publish) await api('/api/questions/review', { ids: [value.id], action: 'approve', confirmed: true, expectedUpdatedAt: { [value.id]: value.updatedAt } }); }
await question({ id: 'SIM-S1', title: '事务原子性定义', stemMarkdown: '解释数据库事务的原子性。', answerMarkdown: '事务中的操作全部提交或全部回滚。', type: 'short_answer', categoryIds: ['similar-database'] });
for (let index = 1; index <= 15; index++) await question({ id: `SIM-C${String(index).padStart(2, '0')}`, title: `事务原子性变式${index}`, stemMarkdown: `事务原子性案例${index}：转账时发生错误，数据应如何处理？`, answerMarkdown: '全部回滚。', explanationMarkdown: '不能只完成一半。', type: index % 2 ? 'short_answer' : 'single_choice', ...(index % 2 ? {} : { options: [{ key: 'A', text: '回滚全部操作' }, { key: 'B', text: '仅保留扣款' }], correctAnswers: ['A'] }), categoryIds: ['similar-database'] });
await question({ id: 'SIM-TF', title: '结构答案判断题', stemMarkdown: '事务原子性允许仅完成部分操作。', type: 'true_false', correctAnswers: ['false'], categoryIds: ['similar-database'] });
await question({ id: 'SIM-FB', title: '结构答案填空题', stemMarkdown: '事务失败后应进行{{b1}}。', type: 'fill_blank', blanks: [{ id: 'b1', label: '机制', answers: ['回滚'], caseSensitive: false, trim: true }], categoryIds: ['similar-database'] });
await question({ id: 'SIM-PENDING', title: '事务原子性待审题', stemMarkdown: '事务原子性未审核资料。', answerMarkdown: '不可推荐。', type: 'short_answer', categoryIds: ['similar-database'] }, false);
await question({ id: 'SIM-ALONE', title: '孤立专有概念', stemMarkdown: '解释离散拓扑的一个孤立术语。', answerMarkdown: '用于验证没有候选的界面。', type: 'short_answer' });
await question({ id: 'SIM-G', title: '事务组合材料', stemMarkdown: '阅读数据库转账材料。', type: 'group', categoryIds: ['similar-database'], parts: [
  { id: 'p1', type: 'short_answer', title: '事务原子性小题', stemMarkdown: '解释事务原子性。', answerMarkdown: '全部提交或全部回滚。' },
  { id: 'p2', type: 'short_answer', title: '事务隔离性小题', stemMarkdown: '解释事务隔离性。', answerMarkdown: '限制并发事务相互可见性。' },
] });
const paper = await api('/api/papers', { title: '相似题界面验收题集', mode: 'manual', questionIds: ['SIM-S1', 'SIM-G'], scoring: { enabled: false } });
paperId = paper.id;
await api('/api/ai/settings', { enabled: true, baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}`, model: 'similar-loopback', key: 'qa-placeholder', timeoutSeconds: 30, maxTokens: 4096, supportsImages: false, sendImages: false }, 'PUT');
const origin = await app.listen({ host: '127.0.0.1', port: 0 }); console.log('SIMILAR_READY ' + JSON.stringify({ origin }));
async function close() { await app.close(); await new Promise<void>(done => provider.close(() => done())); process.exit(0); }
process.on('SIGTERM', () => void close()); process.on('SIGINT', () => void close());
