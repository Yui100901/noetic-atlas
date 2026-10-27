/** Actual application routes with disposable data and loopback-only model. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { buildApp } from '../../server/index.js';

const app = await buildApp({ databasePath: ':memory:', seedPath: 'no-feedback-qa-seed', staticRoot: resolve('dist/web'), logger: false, dailyPushScheduler: false });
let paperId = '', attemptId = ''; const calls: Array<{ feedback: string; candidates: number; success: boolean }> = []; let failOnce = true;
app.get('/qa/question-feedback', async () => ({ paperId, attemptId, questions: await api('/api/questions?status=all&pageSize=200', undefined, 'GET'), feedback: await api('/api/question-feedback?status=all&pageSize=100', undefined, 'GET'), runs: await api('/api/ai/runs?page=1&pageSize=100', undefined, 'GET'), attempt: await api('/api/attempts/' + attemptId, undefined, 'GET'), calls }));
const provider = createServer(async (request, response) => {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')), input = JSON.parse(body.messages[1].content), material = input.untrustedMaterial;
  const description = material.feedback.description, candidates = material.candidates || [];
  if (description.includes('QA_FAIL_ONCE') && failOnce) { failOnce = false; calls.push({ feedback: description, candidates: candidates.length, success: false }); response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'PRIVATE_FEEDBACK_PROVIDER_ERROR' } })); return; }
  calls.push({ feedback: description, candidates: candidates.length, success: true });
  const result = { verdict: 'valid', reason: '根据题干、参考答案和站内候选比对，反馈所述矛盾值得核查。', suggestion: '核对原题答案与解析的一致性，再由用户确认处理。', comparisons: candidates.slice(0, 1).map((candidate: any) => ({ candidateId: candidate.candidateId, relation: 'conflict', reason: '候选表达同一考点但答案不同，请比较具体选项与前提。' })) };
  response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' }); response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }));
});
await new Promise<void>(done => provider.listen(0, '127.0.0.1', done));
async function api(url: string, payload?: unknown, method: any = 'POST') { const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }) }); assert.ok(response.statusCode < 400, `${url}: ${response.statusCode} ${response.body.slice(0, 300)}`); return response.json(); }
await api('/api/domains', { id: 'feedback-computer', name: '计算机' }); await api('/api/categories', { id: 'feedback-python', domainId: 'feedback-computer', name: 'Python基础' });
const specs = [
  { id: 'FEED-S1', title: '表达式优先级', type: 'single_choice', stemMarkdown: '表达式2 + 3 * 4的值是多少？', options: [{ key: 'A', text: '14' }, { key: 'B', text: '20' }], correctAnswers: ['B'], answerMarkdown: '20', explanationMarkdown: '先计算乘法3*4，再加2，应为14。' },
  { id: 'FEED-SIM', title: '表达式优先级对照', type: 'single_choice', stemMarkdown: '表达式2 + 3 * 4的值是多少？', options: [{ key: 'A', text: '14' }, { key: 'B', text: '20' }], correctAnswers: ['A'], answerMarkdown: '14', explanationMarkdown: '先乘法，后加法。' },
  { id: 'FEED-G', title: '事务公共材料', type: 'group', stemMarkdown: '阅读转账事务：先扣款，再入账。', parts: [{ id: 'p1', title: '原子性小题', type: 'short_answer', stemMarkdown: '解释事务原子性。', answerMarkdown: '全部提交或全部回滚。', explanationMarkdown: '不能留下只扣款未入账的状态。' }, { id: 'p2', title: '隔离性小题', type: 'short_answer', stemMarkdown: '解释事务隔离性。', answerMarkdown: '限制并发事务相互可见性。', explanationMarkdown: '与整体提交不同。' }] },
  { id: 'FEED-HISTORY', title: '分页记录用题', type: 'true_false', stemMarkdown: '本条用于隔离界面分页验收。', correctAnswers: ['true'], answerMarkdown: 'true' },
];
for (const spec of specs) { const question = await api('/api/questions', { ...spec, categoryIds: ['feedback-python'] }); await api('/api/questions/review', { ids: [question.id], action: 'approve', confirmed: true, expectedUpdatedAt: { [question.id]: question.updatedAt } }); }
for (let index = 0; index < 11; index++) { const feedback = await api('/api/question-feedback', { questionId: 'FEED-HISTORY', kind: 'other', description: '隔离分页历史反馈' + index }); await api(`/api/question-feedback/${feedback.id}/resolve`, { status: 'dismissed', note: '此条仅验证已处理反馈的分页。', expectedUpdatedAt: feedback.updatedAt }); }
const paper = await api('/api/papers', { title: '反馈快照验收题集', mode: 'manual', questionIds: ['FEED-S1', 'FEED-G'], scoring: { enabled: false } }); paperId = paper.id;
const attempt = await api(`/api/papers/${paperId}/attempts`, {}); attemptId = attempt.id; await api(`/api/attempts/${attemptId}/submit`, { answers: { 'FEED-S1': { value: 'B' } } });
await api('/api/ai/settings', { enabled: true, baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}`, model: 'feedback-loopback', key: 'qa-placeholder', timeoutSeconds: 30, maxTokens: 4096, supportsImages: false, sendImages: false }, 'PUT');
const origin = await app.listen({ host: '127.0.0.1', port: 0 }); console.log('QUESTION_FEEDBACK_READY ' + JSON.stringify({ origin }));
async function close() { await app.close(); await new Promise<void>(done => provider.close(() => done())); process.exit(0); }
process.on('SIGTERM', () => void close()); process.on('SIGINT', () => void close());
