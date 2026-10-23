import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Store, nextStamp } from '../../server/core/store.js';
import { registerAiRoutes } from '../../server/modules/ai/routes.js';
import { paperIntentSchema, recommendPaper } from '../../server/modules/ai/planner.js';
import { aiPaperPlanInputSchema } from '../../server/modules/ai/schema.js';
import { ApiError, parse, questionSchema } from '../../server/core/validation.js';
import type { AiExecutionContext } from '../../shared/ai/ai-progress.js';

const stamp = '2026-10-23T00:00:00.000Z';
const baseQuestion = parse(questionSchema, { title: '事务知识', type: 'short_answer', stemMarkdown: '解释事务边界', answerMarkdown: 'private-answer-secret', explanationMarkdown: 'private-explanation-secret', categoryIds: ['cs-cat'], tagIds: ['base'], status: 'published', createdAt: stamp, updatedAt: stamp });
const q = (id: string, changes = {}) => ({ ...baseQuestion, id, title: `事务知识 ${id}`, ...changes });
type RequestInfo = { task: string; material: any; body: any; text: string };
type Handler = (info: RequestInfo, index: number) => unknown | Promise<unknown>;
const defaultSelect = ({ material }: RequestInfo) => ({ title: '学习练习卷', description: '逐步巩固知识', items: material.candidates.slice(0, material.requestedCount).map((candidate: any) => ({ questionId: candidate.id, reason: '检验对应知识点及应用边界' })) });

async function fixture(t: test.TestContext, questions: ReturnType<typeof q>[] = []) {
  const store = new Store(':memory:');
  for (const [id, name] of [['cs', '计算机'], ['en', '英语']]) store.put('domains', id!, { id, name, description: '', sortOrder: 0 });
  for (const [id, domainId] of [['cs-cat', 'cs'], ['en-cat', 'en']]) store.put('categories', id!, { id, domainId, parentId: null, name: id === 'cs-cat' ? '后端开发' : '英语词汇', description: '', sortOrder: 0 });
  for (const id of ['base', 'advanced']) store.put('tags', id, { id, name: id, domainId: 'cs', color: '#123456', description: '', kind: 'topic' });
  store.transaction(() => { for (const question of questions) store.put('questions', question.id, question); });
  const requests: RequestInfo[] = [];
  let intent: unknown = { count: null }, selection: Handler = defaultSelect, before: Handler | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const input = JSON.parse(body.messages[1].content);
      const info = { task: input.task, material: input.untrustedMaterial, body, text: body.messages[1].content };
      requests.push(info); const index = requests.length - 1;
      await before?.(info, index);
      const result = info.task.includes('理解组卷') ? intent : await selection(info, index);
      response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }));
    } catch { if (!response.destroyed) { response.writeHead(503, { Connection: 'close' }); response.end('local fixture failure'); } }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const settings = { enabled: true, key: 'local-fixture-only', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: 'local-planner', maxTokens: 4096, timeoutSeconds: 10, supportsImages: false, sendImages: false, updatedAt: stamp };
  store.database.putRecord('ai_settings', 'local', settings);
  const app = Fastify(); app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) return reply.code(error.status).send({ error: { code: error.code, message: error.message, details: error.details } });
    return reply.code(500).send({ error: { message: String(error) } });
  });
  registerAiRoutes(app, store);
  t.after(async () => { await app.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.db.close(); });
  const api = async (url: string, payload?: unknown, expected = 200) => {
    const response = await app.inject({ method: payload === undefined ? 'GET' : 'POST', url, ...(payload === undefined ? {} : { payload }) });
    assert.equal(response.statusCode, expected, response.body); return response.json();
  };
  return { store, settings, app, requests, api, intent(value: unknown) { intent = value; }, select(handler: Handler) { selection = handler; }, before(handler: Handler) { before = handler; },
    direct(input: unknown, execution?: AiExecutionContext) { return recommendPaper(store, settings, aiPaperPlanInputSchema.parse(input), text => text.slice(0, 4000), execution); } };
}

test('AI recommends over 300 questions in bounded batches without body-wide reads and creates only after confirmation', async t => {
  const f = await fixture(t, Array.from({ length: 400 }, (_, i) => q(`Q-${i}`)));
  f.store.questions = () => { throw new Error('Planner must use metadata, not all full question bodies'); };
  const run = await f.api('/api/ai/paper-plan', { prompt: '整理365题事务复习', count: 365 });
  assert.equal(run.result.items.length, 365); assert.equal(new Set(run.result.items.map((item: any) => item.questionId)).size, 365);
  assert.ok(run.result.retrieval.batches > 1); assert.equal(f.store.all('papers').length, 0);
  const selections = f.requests.filter(request => !request.task.includes('理解组卷'));
  assert.ok(selections.every(request => request.material.requestedCount <= 28));
  assert.ok(selections.every(request => Buffer.byteLength(request.text) < 600_000));
  assert.equal(run._context, undefined);
  const questionIds = run.result.items.map((item: any) => item.questionId);
  await f.api(`/api/ai/runs/${run.id}/paper`, { title: '未确认卷', questionIds }, 400);
  assert.equal(f.store.all('papers').length, 0);
  const saved = await f.api(`/api/ai/runs/${run.id}/paper`, { confirmed: true, title: '365题事务复习', questionIds }, 201);
  assert.equal(saved.paper.questionCount, 365); assert.equal(saved.paper.questions.length, 365);
  await f.api(`/api/ai/runs/${run.id}/paper`, { confirmed: true, title: '不能重复创建', questionIds }, 409);
});

test('prompt-only retrieval resolves domain, type and count across more than 1000 metadata entries', async t => {
  const questions = [
    ...Array.from({ length: 1150 }, (_, i) => q(`A-English-${i}`, { categoryIds: ['en-cat'], title: `英语词汇 ${i}` })),
    ...Array.from({ length: 40 }, (_, i) => q(`Z-CS-${i}`, { type: 'single_choice', options: [{ key: 'A', text: '对' }, { key: 'B', text: '错' }], correctAnswers: ['A'] })),
    q('Pending-CS', { status: 'pending' }),
  ];
  const f = await fixture(t, questions);
  f.intent({ count: 7, domainIds: ['cs'], types: ['single_choice'], keywords: ['事务'], summary: '七道计算机事务单选' });
  f.store.questions = () => { throw new Error('No full bank read'); };
  const run = await f.api('/api/ai/paper-plan', { prompt: '从计算机领域整理7道事务单选题' });
  assert.equal(run.result.requestedCount, 7); assert.equal(run.result.candidateCount, 40);
  assert.ok(run.result.items.every((item: any) => item.questionId.startsWith('Z-CS-')));
  assert.equal(f.requests[0]?.material.manualCount, null); assert.equal(run.result.retrieval.interpreted, true);
  assert.equal(run.result.retrieval.availableCount, 1190); assert.equal(run.result.retrieval.matchedCount, 40);
  f.intent({ count: 999, domainIds: ['cs'], types: ['single_choice'] });
  const manual = await f.api('/api/ai/paper-plan', { prompt: '提示词写999题，但采用手动指定5题', count: 5 });
  assert.equal(manual.result.requestedCount, 5);
  assert.equal(f.requests.at(-2)?.material.manualCount, 5);
});

test('manual constraints intersect prompt constraints and never expand to another domain', async t => {
  const f = await fixture(t, [q('CS-1'), q('EN-1', { categoryIds: ['en-cat'] })]);
  f.intent({ count: 1, domainIds: ['en'] });
  const result = await f.api('/api/ai/paper-plan', { prompt: '只要英语题', filters: { domainId: 'cs' } }, 422);
  assert.equal(result.error.code, 'AI_PAPER_INSUFFICIENT_QUESTIONS');
  assert.equal(f.requests.length, 1); assert.equal(f.store.database.records('ai_runs').length, 0);
});

test('manual tag filters and prompt type filters both remain effective', async t => {
  const choice = { type: 'true_false', correctAnswers: ['true'], options: [] };
  const f = await fixture(t, [q('wanted', { ...choice, tagIds: ['base', 'advanced'] }), q('wrong-tag', choice), q('wrong-type', { tagIds: ['advanced'] })]);
  f.intent({ count: 1, types: ['true_false'] });
  const run = await f.api('/api/ai/paper-plan', { prompt: '判断题', filters: { tagIds: ['advanced'] } });
  assert.deepEqual(run.result.items.map((item: any) => item.questionId), ['wanted']);
});

test('missing count defaults to 20, explicit count wins, and an oversized inferred count fails before selection', async t => {
  const f = await fixture(t, Array.from({ length: 35 }, (_, i) => q(`Q-${i}`)));
  const automatic = await f.api('/api/ai/paper-plan', { prompt: '给我一份事务复习卷' });
  assert.equal(automatic.result.requestedCount, 20);
  f.intent({ count: 999 });
  const explicit = await f.api('/api/ai/paper-plan', { prompt: '即使提示词写999题，使用手动题量', count: 12 });
  assert.equal(explicit.result.items.length, 12);
  const before = f.requests.length;
  const rejected = await f.api('/api/ai/paper-plan', { prompt: '整理999题' }, 422);
  assert.equal(rejected.error.code, 'AI_PAPER_COUNT_TOO_LARGE'); assert.equal(f.requests.length, before + 1);
});

test('unspecified intent bounds accept null while enums, integer limits and unexpected fields remain strict', async t => {
  const intent = paperIntentSchema.parse({ count: null, collection: null, difficultyMin: null, difficultyMax: null });
  assert.equal(intent.collection, undefined); assert.equal(intent.difficultyMin, undefined); assert.equal(intent.difficultyMax, undefined);
  for (const invalid of [{ collection: 'unknown' }, { difficultyMin: 0 }, { difficultyMax: 5 }, { difficultyMin: 1.5 }, { types: ['单选题'] }, { ignored: 'unexpected' }]) assert.equal(paperIntentSchema.safeParse(invalid).success, false);
  const f = await fixture(t, [q('Q-1')]);
  f.intent({ count: 1, collection: null, difficultyMin: null, difficultyMax: null });
  const run = await f.api('/api/ai/paper-plan', { prompt: '给我一题，不限定难度' });
  assert.equal(run.result.items.length, 1);
  const definition = JSON.parse(f.requests[0]!.text).outputSchema;
  assert.match(definition.types[0], /single_choice/); assert.ok(Object.hasOwn(definition, 'collection')); assert.ok(Object.hasOwn(definition, 'difficultyMin'));
});

test('unknown intent references, fake question IDs and cross-batch duplicates leave no partial run', async t => {
  await t.test('unknown intent reference', async sub => {
    const f = await fixture(sub, [q('Q-1')]); f.intent({ count: 1, domainIds: ['invented-domain'] });
    assert.equal((await f.api('/api/ai/paper-plan', { prompt: '不存在的领域' }, 502)).error.code, 'AI_PAPER_FILTER_INVALID');
    assert.equal(f.store.database.records('ai_runs').length, 0);
  });
  await t.test('fake selected ID', async sub => {
    const f = await fixture(sub, [q('Q-1')]); f.select(() => ({ title: '伪造', description: '', items: [{ questionId: 'invented-question', reason: '错误' }] }));
    assert.equal((await f.api('/api/ai/paper-plan', { prompt: '一题', count: 1 }, 502)).error.code, 'AI_PAPER_SELECTION_INVALID');
    assert.equal(f.store.database.records('ai_runs').length, 0);
  });
  await t.test('duplicate across successful first batch', async sub => {
    const f = await fixture(sub, Array.from({ length: 150 }, (_, i) => q(`Q-${i}`)));
    f.select(info => {
      const result = defaultSelect(info);
      if (info.material.previouslySelected.length) result.items[0]!.questionId = info.material.previouslySelected[0];
      return result;
    });
    assert.equal((await f.api('/api/ai/paper-plan', { prompt: '101题事务练习', count: 101 }, 502)).error.code, 'AI_PAPER_SELECTION_INVALID');
    assert.equal(f.requests.length, 2); assert.equal(f.store.database.records('ai_runs').length, 0); assert.equal(f.store.all('papers').length, 0);
  });
});

test('group questions honor the 500 answer-slot limit including expanded child questions', async t => {
  const group = (id: string, length: number) => q(id, { type: 'group', parts: Array.from({ length }, (_, i) => ({ id: `part-${i}`, title: `问题${i}`, type: 'short_answer', stemMarkdown: '解释代码', answerMarkdown: '答案', explanationMarkdown: '解析', options: [], correctAnswers: [], weight: 1 })) });
  await t.test('500 slots accepted', async sub => {
    const f = await fixture(sub, Array.from({ length: 17 }, (_, i) => group(`G-${i}`, i === 16 ? 20 : 30)));
    const run = await f.api('/api/ai/paper-plan', { prompt: '整理17道组合题', count: 17 });
    const result = await f.api(`/api/ai/runs/${run.id}/paper`, { confirmed: true, title: '500小题组合卷', questionIds: run.questionIds }, 201);
    assert.equal(result.paper.answerCount, 500);
  });
  await t.test('510 slots rejected', async sub => {
    const f = await fixture(sub, Array.from({ length: 17 }, (_, i) => group(`G-${i}`, 30)));
    assert.equal((await f.api('/api/ai/paper-plan', { prompt: '整理17道组合题', count: 17 }, 422)).error.code, 'AI_PAPER_TOO_MANY_PARTS');
    assert.equal(f.store.database.records('ai_runs').length, 0); assert.equal(f.store.all('papers').length, 0);
  });
});

test('candidate request budgets include Unicode bytes and never send answers, notes, source paths or images', async t => {
  const f = await fixture(t, Array.from({ length: 120 }, (_, i) => q(`Q-${i}`, {
    stemMarkdown: '多字节题干'.repeat(1600) + '\n![private-image](https://private.invalid/secret-image.png)',
    sourceDocument: 'C:/private/project/questions.md', sourceAnchor: 'private-anchor',
  })));
  f.store.put('study', 'Q-0', { ...f.store.study('Q-0'), notes: 'private-user-note' });
  const run = await f.api('/api/ai/paper-plan', { prompt: '101题递进练习', count: 101 });
  assert.equal(run.result.items.length, 101);
  for (const request of f.requests) {
    assert.ok(Buffer.byteLength(request.text) < 600_000, `request must fit input byte limit: ${Buffer.byteLength(request.text)}`);
    for (const secret of ['private-answer-secret', 'private-explanation-secret', 'C:/private/project', 'private-anchor', 'private-user-note', 'private.invalid', 'secret-image.png']) assert.ok(!request.text.includes(secret), secret);
    assert.ok(typeof request.body.messages[1].content === 'string');
  }
});

test('cancel, intermediate provider failure and source changes do not save partial recommendations', async t => {
  await t.test('cancel during second request', async sub => {
    const f = await fixture(sub, Array.from({ length: 120 }, (_, i) => q(`Q-${i}`)));
    const controller = new AbortController();
    f.before((_request, index) => { if (index === 1) controller.abort(); });
    await assert.rejects(f.direct({ prompt: '101题递进练习', count: 101 }, { signal: controller.signal, emit() {} }), error => error instanceof ApiError && error.code === 'AI_CANCELLED');
    assert.equal(f.store.database.records('ai_runs').length, 0); assert.equal(f.store.all('papers').length, 0);
  });
  await t.test('intermediate failure', async sub => {
    const f = await fixture(sub, Array.from({ length: 120 }, (_, i) => q(`Q-${i}`)));
    f.before((_request, index) => { if (index === 1) throw new Error('fixture fails second batch'); });
    assert.equal((await f.api('/api/ai/paper-plan', { prompt: '101题递进练习', count: 101 }, 502)).error.code, 'AI_PROVIDER_ERROR');
    assert.equal(f.store.database.records('ai_runs').length, 0); assert.equal(f.store.all('papers').length, 0);
  });
  await t.test('selected source changed after an early batch', async sub => {
    const f = await fixture(sub, Array.from({ length: 120 }, (_, i) => q(`Q-${i}`)));
    f.before((request, index) => {
      if (index !== 1) return;
      const selected = request.material.previouslySelected[0], question = f.store.require<any>('questions', selected);
      f.store.put('questions', selected, { ...question, updatedAt: nextStamp(question.updatedAt) });
    });
    assert.equal((await f.api('/api/ai/paper-plan', { prompt: '101题递进练习', count: 101 }, 409)).error.code, 'AI_QUESTION_VERSION_CONFLICT');
    assert.equal(f.store.database.records('ai_runs').length, 0); assert.equal(f.store.all('papers').length, 0);
  });
  await t.test('cached candidate changed before selection in a later batch', async sub => {
    const f = await fixture(sub, Array.from({ length: 120 }, (_, i) => q(`Q-${i}`)));
    f.before((request, index) => {
      if (index !== 1) return;
      const future = request.material.candidates[0].id, question = f.store.require<any>('questions', future);
      f.store.put('questions', future, { ...question, updatedAt: nextStamp(question.updatedAt) });
    });
    assert.equal((await f.api('/api/ai/paper-plan', { prompt: '101题递进练习', count: 101 }, 409)).error.code, 'AI_QUESTION_VERSION_CONFLICT');
    assert.equal(f.store.database.records('ai_runs').length, 0); assert.equal(f.store.all('papers').length, 0);
  });
});

test('hand adjustments only accept actually reviewed candidates, and versions are rechecked on confirmation', async t => {
  const f = await fixture(t, Array.from({ length: 1300 }, (_, i) => q(`Q-${i}`)));
  f.intent({ count: 1 });
  const run = await f.api('/api/ai/paper-plan', { prompt: '从全库推荐一题' });
  assert.ok(run.result.candidates.length < 1300);
  const reviewed = new Set<string>(run.result.candidates.map((item: any) => item.id));
  const unreviewed = f.store.questionMetadata().find(item => !reviewed.has(item.id))!;
  assert.ok(unreviewed);
  assert.equal((await f.api(`/api/ai/runs/${run.id}/paper`, { confirmed: true, title: '不能添加未看过的题', questionIds: [unreviewed.id] }, 400)).error.code, 'AI_PAPER_CANDIDATE_MISMATCH');
  const alternate = run.result.candidates.find((item: any) => !run.questionIds.includes(item.id));
  assert.ok(alternate);
  const source = f.store.require<any>('questions', alternate.id);
  f.store.put('questions', source.id, { ...source, updatedAt: nextStamp(source.updatedAt) });
  assert.equal((await f.api(`/api/ai/runs/${run.id}/paper`, { confirmed: true, title: '候选变化后不能添加', questionIds: [source.id] }, 409)).error.code, 'AI_QUESTION_VERSION_CONFLICT');
  assert.equal(f.store.all('papers').length, 0);
  const valid = run.result.candidates.find((item: any) => !run.questionIds.includes(item.id) && item.id !== source.id)!;
  const saved = await f.api(`/api/ai/runs/${run.id}/paper`, { confirmed: true, title: '人工选择另一道已比较候选', questionIds: [valid.id] }, 201);
  assert.deepEqual(saved.paper.questionIds, [valid.id]);
});

test('confirmation accepts reviewed candidates without timestamps and rejects inherited object keys', async t => {
  const f = await fixture(t, [q('Q-1', { createdAt: undefined, updatedAt: undefined }), q('toString')]);
  f.select(info => ({ title: '基础练习', description: '', items: [{ questionId: 'Q-1', reason: '复习事务基础' }] }));
  const run = await f.api('/api/ai/paper-plan', { prompt: '选择一题', count: 1 });
  // Only the first question belongs to the run's reviewed candidate set.
  const stored = f.store.require<any>('ai_runs', run.id);
  delete stored._context.candidateVersions.toString;
  f.store.put('ai_runs', run.id, stored);
  const rejected = await f.api(`/api/ai/runs/${run.id}/paper`, { confirmed: true, title: '拒绝继承属性', questionIds: ['toString'] }, 400);
  assert.equal(rejected.error.code, 'AI_PAPER_CANDIDATE_MISMATCH');
  const saved = await f.api(`/api/ai/runs/${run.id}/paper`, { confirmed: true, title: '无时间戳的已比较题', questionIds: ['Q-1'] }, 201);
  assert.deepEqual(saved.paper.questionIds, ['Q-1']);
});

test('large user-defined taxonomy is summarized within the complete request byte budget', async t => {
  const f = await fixture(t, [q('Q-1')]);
  f.store.transaction(() => {
    for (let i = 0; i < 1000; i++) f.store.put('categories', `custom-category-${i}`, { id: `custom-category-${i}`, domainId: 'en', parentId: null, name: `英语自定义分类${i}${'词汇语法'.repeat(60)}`, description: 'private taxonomy description', sortOrder: i });
    for (let i = 0; i < 800; i++) f.store.put('tags', `custom-tag-${i}`, { id: `custom-tag-${i}`, domainId: 'en', name: `英语自定义标签${i}${'词汇学习'.repeat(50)}`, description: 'private taxonomy description', color: '#123456', kind: 'custom' });
  });
  f.intent({ count: 1, domainIds: ['cs'], categoryIds: ['cs-cat'] });
  const run = await f.api('/api/ai/paper-plan', { prompt: '给我一道计算机后端开发事务题' });
  assert.equal(run.result.items[0].questionId, 'Q-1');
  for (const request of f.requests) {
    assert.ok(Buffer.byteLength(request.text) <= 550_000, `full JSON prompt should leave byte headroom, got ${Buffer.byteLength(request.text)}`);
    assert.ok(!request.text.includes('private taxonomy description'));
  }
});

test('large valid candidate tag arrays are summarized without weakening local hard filters', async t => {
  const tagIds = Array.from({ length: 500 }, (_, i) => `long-tag-${i}-${'x'.repeat(140)}`);
  const f = await fixture(t, Array.from({ length: 60 }, (_, i) => q(`Q-${i}`, { tagIds })));
  f.store.transaction(() => {
    for (const id of tagIds) f.store.put('tags', id, { id, domainId: 'cs', name: id, description: '', color: '#123456', kind: 'custom' });
  });
  const run = await f.api('/api/ai/paper-plan', { prompt: '整理29题计算机复习', count: 29, filters: { tagIds: [tagIds.at(-1)!] } });
  assert.equal(run.result.items.length, 29);
  assert.ok(run.result.retrieval.batches >= 2);
  for (const request of f.requests) assert.ok(Buffer.byteLength(request.text) <= 550_000);
  for (const item of run.result.items) assert.ok(f.store.require<any>('questions', item.questionId).tagIds.includes(tagIds.at(-1)));
});
