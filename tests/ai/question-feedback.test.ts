import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createServer } from 'node:http';
import { Store, now, nextStamp } from '../../server/core/store.js';
import { ApiError, parse, questionSchema } from '../../server/core/validation.js';
import { registerAiRoutes } from '../../server/modules/ai/routes.js';
import { registerQuestionFeedbackRoutes } from '../../server/modules/quality-feedback/routes.js';
import { enrichQuestionsWithFeedback } from '../../server/modules/quality-feedback/service.js';
import { questionFeedbackSchema } from '../../server/modules/quality-feedback/schema.js';

const privateKey = 'feedback-key-private', privateNotes = 'private-study-note-never-send';
async function fixture(t: test.TestContext) {
  const store = new Store(':memory:');
  store.put('domains', 'cs', { id: 'cs', name: '计算机', description: '', sortOrder: 0 }); store.put('domains', 'en', { id: 'en', name: '英语', description: '', sortOrder: 1 });
  for (const did of ['cs', 'en']) store.put('categories', did + '-cat', { id: did + '-cat', domainId: did, parentId: null, name: did, description: '', sortOrder: 0 });
  const q = (id: string, changes = {}) => parse(questionSchema, { id, title: 'Python变量命名', type: 'short_answer', stemMarkdown: 'Python变量名能否以数字开头？', answerMarkdown: '不能以数字开头。', explanationMarkdown: '变量命名规则不允许第一位是数字。', categoryIds: ['cs-cat'], sourceDocument: 'C:/private/source.md', sourceAnchor: 'local-private-anchor', status: 'published', createdAt: now(), updatedAt: now(), ...changes });
  store.put('questions', 'Q1', q('Q1')); store.put('questions', 'Q2', q('Q2', { answerMarkdown: '可以以数字开头。' }));
  store.put('questions', 'EN1', q('EN1', { title: '英语句法', stemMarkdown: '解释英语主谓结构。', categoryIds: ['en-cat'] }));
  const part = (id: string) => ({ id, title: `变量子题${id}`, type: 'short_answer', stemMarkdown: '解释变量命名。', answerMarkdown: '遵循命名规则。', explanationMarkdown: '区分变量名和值。' });
  store.put('questions', 'G1', q('G1', { title: '程序阅读', type: 'group', parts: [part('one'), part('two')] }));
  store.put('study', 'Q1', { ...store.study('Q1'), notes: privateNotes });
  const requests: any[] = []; let handler: (body: any, index: number) => any = body => ({ verdict: 'valid', reason: '原题解析与反馈所指出的问题需要核对。', suggestion: '核实原始资料后修正答案。', comparisons: body.untrustedMaterial.candidates.length ? [{ candidateId: body.untrustedMaterial.candidates[0].candidateId, relation: 'conflict', reason: '两题条件接近，但参考答案不一致。' }] : [] });
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const completion = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const input = JSON.parse(completion.messages[1].content); requests.push(input);
    const output = handler(input, requests.length);
    if (output.httpStatus) { response.writeHead(output.httpStatus, { 'Content-Type': 'application/json', Connection: 'close' }); response.end(JSON.stringify({ error: { message: `${privateKey}: provider-private-details` } })); }
    else { response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' }); response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] })); }
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  store.database.putRecord('ai_settings', 'local', { enabled: true, baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}`, key: privateKey, model: 'local-feedback-review', maxTokens: 4096, timeoutSeconds: 10, supportsImages: false, sendImages: false, updatedAt: now() });
  const app = Fastify(); app.setErrorHandler((error, _request, reply) => error instanceof ApiError ? reply.code(error.status).send({ error: { code: error.code, message: error.message, details: error.details } }) : reply.code(500).send({ error: { code: 'TEST_FAILURE' } }));
  registerAiRoutes(app, store); registerQuestionFeedbackRoutes(app, store);
  const api = async (url: string, payload?: unknown, status = 200) => { const response = await app.inject({ url, method: payload === undefined ? 'GET' : 'POST', ...(payload === undefined ? {} : { payload }) }); assert.equal(response.statusCode, status, response.body); return response.json(); };
  const report = (questionId = 'Q1', changes = {}) => api('/api/question-feedback', { questionId, kind: 'answer', description: '答案与解析可能矛盾，请复核。', ...changes }, 201);
  t.after(async () => { await app.close(); store.database.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); });
  return { store, api, report, requests, handler(value: typeof handler) { handler = value; } };
}

test('feedback is private pending metadata, preserves publication and marks only applicable group leaves', async t => {
  const f = await fixture(t), before = f.store.database.records('questions');
  const whole = await f.report('G1', { kind: 'ambiguous' }), leaf = await f.report('G1', { partId: 'one' });
  await f.report('Q1');
  assert.equal(whole.status, 'pending'); assert.equal(leaf.partId, 'one'); assert.equal(questionFeedbackSchema.safeParse(f.store.database.getRecord('question_feedback', leaf.id)).success, true);
  const summary = (await f.api('/api/question-feedback/summaries', { questionIds: ['G1', 'Q1', 'EN1'] })).summaries;
  assert.equal(summary.G1.openCount, 2); assert.equal(summary.G1.wholeCount, 1); assert.deepEqual(summary.G1.partCounts, { one: 1 });
  assert.equal(summary.EN1.openCount, 0);
  const children = enrichQuestionsWithFeedback(f.store, [{ id: 'G1::one', sourceQuestionId: 'G1', partId: 'one' }, { id: 'G1::two', sourceQuestionId: 'G1', partId: 'two' }]);
  assert.equal(children[0]!.feedbackSummary.openCount, 2); assert.equal(children[1]!.feedbackSummary.openCount, 1);
  assert.deepEqual(f.store.database.records('questions'), before); assert.equal(f.requests.length, 0);
});

test('feedback validates source and versions, and only explicit resolution removes suspicion', async t => {
  const f = await fixture(t);
  await f.api('/api/question-feedback', { questionId: 'Q1', kind: 'answer', description: '' }, 400);
  await f.api('/api/question-feedback', { questionId: 'Q1', partId: 'one', kind: 'answer', description: '无此小题' }, 404);
  await f.api('/api/question-feedback', { questionId: 'Q1', kind: 'answer', description: '旧版本', expectedUpdatedAt: '2000-01-01T00:00:00.000Z' }, 409);
  const feedback = await f.report();
  await f.api(`/api/question-feedback/${feedback.id}/resolve`, { status: 'dismissed', note: '', expectedUpdatedAt: feedback.updatedAt }, 400);
  const confirmed = await f.api(`/api/question-feedback/${feedback.id}/resolve`, { status: 'confirmed', note: '核对后确认存在问题', expectedUpdatedAt: feedback.updatedAt });
  assert.equal((await f.api('/api/question-feedback/summaries', { questionIds: ['Q1'] })).summaries.Q1.confirmedCount, 1);
  await f.api(`/api/question-feedback/${feedback.id}/resolve`, { status: 'resolved', note: '已修正', expectedUpdatedAt: feedback.updatedAt }, 409);
  await f.api(`/api/question-feedback/${feedback.id}/resolve`, { status: 'resolved', note: '已核查并修正', expectedUpdatedAt: confirmed.updatedAt });
  assert.equal((await f.api('/api/question-feedback/summaries', { questionIds: ['Q1'] })).summaries.Q1.openCount, 0);
  assert.equal(f.store.get<any>('questions', 'Q1').status, 'published');
});

test('feedback queue paginates and filters by text, domain, kind and group identity', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 23; i++) await f.report(i % 2 ? 'Q1' : 'EN1', { kind: i < 5 ? 'explanation' : 'answer', description: `反馈序号${i}` });
  const first = await f.api('/api/question-feedback?page=1&pageSize=10'); assert.equal(first.total, 23); assert.equal(first.items.length, 10);
  const third = await f.api('/api/question-feedback?page=3&pageSize=10'); assert.equal(third.items.length, 3);
  assert.equal((await f.api('/api/question-feedback?domainId=cs')).total, 11);
  assert.equal((await f.api('/api/question-feedback?kind=explanation')).total, 5);
  assert.equal((await f.api('/api/question-feedback?search=' + encodeURIComponent('反馈序号22'))).total, 1);
  await f.api('/api/question-feedback?partId=one', undefined, 400);
  await f.api('/api/question-feedback?pageSize=15', undefined, 400);
});

test('local similar candidates use search projections and bounded source reads without a full question loop', async t => {
  const f = await fixture(t), feedback = await f.report();
  for (let i = 0; i < 90; i++) f.store.put('questions', `OTHER-${i}`, { ...f.store.get<any>('questions', 'Q1'), id: `OTHER-${i}`, title: '完全无关的地理题', stemMarkdown: `无关地理材料${i}`, answerMarkdown: '无关', explanationMarkdown: '无关' });
  f.store.database.projections.refreshAll();
  const originalAll = f.store.all.bind(f.store), originalRecords = f.store.database.records.bind(f.store.database);
  f.store.all = ((table: any) => { assert.notEqual(table, 'questions', 'candidate lookup cannot materialize all questions'); return originalAll(table); }) as typeof f.store.all;
  f.store.database.records = ((table: any) => { assert.notEqual(table, 'questions', 'candidate lookup cannot parse every source body'); return originalRecords(table); }) as typeof f.store.database.records;
  const result = await f.api(`/api/question-feedback/${feedback.id}/candidates`);
  assert.equal(result.sourceChanged, false); assert.ok(result.items.length <= 8); assert.ok(result.items.some((item: any) => item.questionId === 'Q2'));
  assert.ok(result.items.every((item: any) => item.questionId !== 'Q1')); assert.match(result.scope, /未查询外网/);
});

test('AI reviews feedback with local answer conflicts, excludes private study material and never applies corrections', async t => {
  const f = await fixture(t), feedback = await f.report(), questions = f.store.database.records('questions'), studies = f.store.database.records('study');
  const result = await f.api('/api/question-feedback/ai-review', { ids: [feedback.id], expectedUpdatedAt: { [feedback.id]: feedback.updatedAt } });
  assert.equal(result.status, 'completed'); assert.equal(result.completed, 1); assert.equal(result.items[0].feedback.review.verdict, 'valid');
  assert.equal(result.items[0].feedback.status, 'pending'); assert.equal(result.items[0].feedback.review.comparisons[0].relation, 'conflict');
  assert.equal(result.items[0].feedback.review.comparisons[0].questionId, 'Q2');
  const run = await f.api('/api/ai/runs/' + result.items[0].runId); assert.equal(run.kind, 'feedback_review'); assert.equal(run.feedbackId, feedback.id); assert.equal(run.status, 'completed');
  const sent = JSON.stringify(f.requests); assert.ok(!sent.includes(privateNotes)); assert.ok(!sent.includes('C:/private')); assert.ok(!sent.includes('local-private-anchor'));
  assert.deepEqual(f.store.database.records('questions'), questions); assert.deepEqual(f.store.database.records('study'), studies);
  await f.api(`/api/ai/runs/${run.id}/apply`, { confirmed: true, appendNotes: true }, 400);
});

test('batch review retains successful items and failed audit reasons, then retries only selected failures', async t => {
  const f = await fixture(t), good = await f.report(), bad = await f.report('Q1', { description: 'FAIL这条反馈需复查' });
  f.handler(input => input.untrustedMaterial.feedback.description.includes('FAIL') ? { httpStatus: 429 } : { verdict: 'uncertain', reason: '本地资料不足以证明。', suggestion: '补充来源。', comparisons: [] });
  const result = await f.api('/api/question-feedback/ai-review', { ids: [good.id, bad.id], expectedUpdatedAt: { [good.id]: good.updatedAt, [bad.id]: bad.updatedAt } });
  assert.equal(result.status, 'partial'); assert.equal(result.completed, 1); assert.equal(result.failed, 1); assert.equal(result.items[0].feedback.review.verdict, 'uncertain');
  const failed = result.items[1].feedback; assert.equal(failed.status, 'pending'); assert.match(failed.lastFailure.failure.message, /HTTP 429/);
  const audit = await f.api('/api/ai/runs/' + failed.lastFailure.auditId); assert.equal(audit.status, 'failed'); assert.equal(audit.feedbackId, bad.id); assert.equal(audit.result, undefined);
  assert.ok(!JSON.stringify(result).includes(privateKey)); assert.ok(!JSON.stringify(audit).includes('provider-private-details'));
  f.handler(() => ({ verdict: 'invalid', reason: '当前材料没有支持该反馈的证据。', suggestion: '', comparisons: [] }));
  const retried = await f.api('/api/question-feedback/ai-review', { ids: [bad.id], expectedUpdatedAt: { [bad.id]: failed.updatedAt } });
  assert.equal(retried.completed, 1); assert.equal(retried.items[0].feedback.lastFailure, undefined); assert.equal(f.requests.length, 3);
  assert.equal((await f.api('/api/ai/runs?status=failed')).length, 1); assert.equal((await f.api('/api/question-feedback/' + good.id)).review.verdict, 'uncertain');
});

test('AI candidate hallucination and concurrent source changes are rejected with failed history', async t => {
  const f = await fixture(t); let feedback = await f.report();
  f.handler(() => ({ verdict: 'valid', reason: '候选对比。', suggestion: '', comparisons: [{ candidateId: 'invented-candidate', relation: 'conflict', reason: '不应接受这个候选。' }] }));
  let result = await f.api('/api/question-feedback/ai-review', { ids: [feedback.id], expectedUpdatedAt: { [feedback.id]: feedback.updatedAt } });
  assert.equal(result.failed, 1); assert.equal(result.items[0].failure.code, 'AI_FEEDBACK_CANDIDATE_INVALID'); assert.equal(result.items[0].feedback.review, undefined);
  feedback = await f.report();
  f.handler(() => { const question = f.store.get<any>('questions', 'Q1'); f.store.put('questions', 'Q1', { ...question, stemMarkdown: '用户刚修改的问题', updatedAt: nextStamp(question.updatedAt) }); return { verdict: 'valid', reason: '旧材料结论。', suggestion: '', comparisons: [] }; });
  result = await f.api('/api/question-feedback/ai-review', { ids: [feedback.id], expectedUpdatedAt: { [feedback.id]: feedback.updatedAt } });
  assert.equal(result.items[0].failure.code, 'AI_FEEDBACK_SOURCE_CHANGED'); assert.equal(result.items[0].feedback.sourceChanged, true); assert.equal(result.items[0].feedback.review, undefined);
  assert.equal((await f.api('/api/ai/runs?status=failed')).length, 2);
});

test('stale feedback or a concurrent user resolution is not overwritten by batch failure metadata', async t => {
  const f = await fixture(t), feedback = await f.report();
  const confirmed = await f.api(`/api/question-feedback/${feedback.id}/resolve`, { status: 'confirmed', note: '核对中', expectedUpdatedAt: feedback.updatedAt });
  let result = await f.api('/api/question-feedback/ai-review', { ids: [feedback.id], expectedUpdatedAt: { [feedback.id]: feedback.updatedAt } });
  assert.equal(result.items[0].failure.code, 'AI_FEEDBACK_VERSION_CONFLICT'); assert.equal(result.items[0].feedback.updatedAt, confirmed.updatedAt); assert.equal(result.items[0].feedback.lastFailure, undefined); assert.equal(f.requests.length, 0);
  f.handler(() => { const current = f.store.database.getRecord<any>('question_feedback', feedback.id)!; f.store.database.putRecord('question_feedback', feedback.id, { ...current, status: 'resolved', note: '用户已手动解决', updatedAt: nextStamp(current.updatedAt) }); return { verdict: 'valid', reason: '迟到建议', suggestion: '', comparisons: [] }; });
  result = await f.api('/api/question-feedback/ai-review', { ids: [feedback.id], expectedUpdatedAt: { [feedback.id]: confirmed.updatedAt } });
  assert.equal(result.failed, 1); assert.equal(result.items[0].feedback.status, 'resolved'); assert.equal(result.items[0].feedback.note, '用户已手动解决'); assert.equal(result.items[0].feedback.lastFailure, undefined);
});

test('missing images or truncated source are uncertain and malformed batches fail before provider calls', async t => {
  const f = await fixture(t), q = f.store.get<any>('questions', 'Q1');
  f.store.put('questions', 'Q1', { ...q, stemMarkdown: '判断图中变量。 ![图](https://example.invalid/figure.png)', updatedAt: nextStamp(q.updatedAt) });
  const feedback = await f.report(); f.handler(() => ({ verdict: 'valid', reason: '模型声称成立', suggestion: '', comparisons: [] }));
  const result = await f.api('/api/question-feedback/ai-review', { ids: [feedback.id], expectedUpdatedAt: { [feedback.id]: feedback.updatedAt } });
  assert.equal(result.items[0].feedback.review.verdict, 'uncertain'); assert.match(result.items[0].feedback.review.reason, /图片未发送/);
  const before = f.requests.length;
  await f.api('/api/question-feedback/ai-review', { ids: [feedback.id, feedback.id], expectedUpdatedAt: { [feedback.id]: feedback.updatedAt } }, 400);
  await f.api('/api/question-feedback/ai-review', { ids: [feedback.id], expectedUpdatedAt: {} }, 400);
  await f.api('/api/question-feedback/ai-review', { ids: Array.from({ length: 21 }, (_, i) => `feedback-${i}`), expectedUpdatedAt: {} }, 400);
  assert.equal(f.requests.length, before);
});
