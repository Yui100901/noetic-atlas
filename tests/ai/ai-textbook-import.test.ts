import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import Fastify from 'fastify';
import { Store } from '../../server/core/store.js';
import { ApiError } from '../../server/core/validation.js';
import { registerAiRoutes } from '../../server/modules/ai/routes.js';
import { buildApp } from '../../server/index.js';

const chapter = 'CHAPTER_CANARY：变量将名称关联到值。表达式产生值，语句执行动作。赋值语句计算右侧表达式后更新左侧名称。整数和字符串属于不同类型。';
const question = (title: string, type = 'short_answer', difficulty = 2) => ({
  id: 'model-invented-id', title, type, stemMarkdown: title,
  answerMarkdown: '变量将名称关联到值。', explanationMarkdown: '依据本章的变量与赋值说明。', difficulty,
  status: 'published', categoryIds: ['model-invented-category'], tagIds: ['model-invented-tag'],
  sourceRefs: [{ label: '模型虚构来源', url: 'https://unprovided.example.test/claim' }],
  ...(type === 'true_false' ? { correctAnswers: ['true'] } : {}),
});
const result = (...questions: any[]) => ({ questions, taxonomySuggestions: { domains: ['计算机'], categories: ['编程基础'], tags: ['变量'] } });

async function fixture(t: test.TestContext) {
  const store = new Store(':memory:');
  store.put('domains', 'computer', { id: 'computer', name: '计算机', description: '', sortOrder: 0 });
  store.put('categories', 'chapter', { id: 'chapter', name: '变量与表达式', domainId: 'computer', parentId: null, description: '', sortOrder: 0 });
  store.put('tags', 'variable', { id: 'variable', name: '变量', domainId: 'computer', kind: 'topic', color: '#39C5BB', description: '' });
  const requests: Array<{ method: string; url: string; task: string; material: any; stream?: boolean }> = [];
  let output: any = result(question('什么是变量？'));
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const input = JSON.parse(body.messages[1].content);
    requests.push({ method: request.method!, url: request.url!, task: input.task, material: input.untrustedMaterial, stream: body.stream });
    const content = JSON.stringify(output);
    if (body.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: content.slice(0, 80) } }] }) + '\n\n');
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: content.slice(80) }, finish_reason: 'stop' }] }) + '\n\n');
      response.end('data: [DONE]\n\n');
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }));
    }
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const modelAddress = `http://127.0.0.1:${(model.address() as { port: number }).port}`;
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    return reply.code(500).send({ error: { message: String(error) } });
  });
  registerAiRoutes(app, store);
  const api = async (url: string, payload?: unknown, expected = 200) => {
    const response = await app.inject({ url, method: payload === undefined ? 'GET' : 'POST', ...(payload === undefined ? {} : { payload }) });
    assert.equal(response.statusCode, expected, response.body); return response.json();
  };
  const configured = await app.inject({ url: '/api/ai/settings', method: 'PUT', payload: { enabled: true, baseUrl: modelAddress, model: 'isolated-textbook-model', key: 'test-key', supportsImages: false, sendImages: false, timeoutSeconds: 10, maxTokens: 4096 } });
  assert.equal(configured.statusCode, 200, configured.body);
  t.after(async () => { await app.close(); store.db.close(); await new Promise<void>(resolve => model.close(() => resolve())); });
  return { app, api, store, requests, modelAddress, output: (value: any) => { output = value; } };
}

test('existing-question extraction remains the default and does not promote or leak material into saved provenance', async t => {
  const f = await fixture(t);
  const run = await f.api('/api/ai/import', { text: chapter, sourceName: '习题.txt', categoryIds: ['chapter'], tagIds: ['variable'] });
  assert.equal(f.requests[0].material.mode, 'extract'); assert.equal(f.requests[0].material.text, chapter);
  assert.match(f.requests[0].task, /已经存在/); assert.match(f.requests[0].task, /不为凑数创建新的题目/);
  assert.deepEqual(run.result.source, { mode: 'extract', name: '习题.txt' });
  assert.equal(run.result.questions[0].status, 'pending'); assert.equal(run.result.questions[0].id, undefined);
  assert.deepEqual(run.result.questions[0].categoryIds, ['chapter']); assert.deepEqual(run.result.questions[0].tagIds, ['variable']);
  assert.equal(f.store.all('questions').length, 0);
  assert.doesNotMatch(JSON.stringify(f.store.all('ai_runs')), /CHAPTER_CANARY/);
});

test('textbook generation creates reviewable exercises from prose with trusted source metadata and explicit pending import', async t => {
  const f = await fixture(t);
  f.output(result(question('赋值语句如何更新变量？'), question('表达式能够产生值。', 'true_false')));
  const sourceUrl = f.modelAddress + '/not-fetched-textbook.pdf';
  const run = await f.api('/api/ai/import', { mode: 'generate', text: chapter, sourceName: '编程基础第2章.pdf', sourceUrl, requirements: '用中文考察变量、表达式与赋值，不要求背诵原文。', questionTypes: ['short_answer', 'true_false'], difficulty: 2, categoryIds: ['chapter'], tagIds: ['variable'], count: 3 });
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].url, '/chat/completions');
  assert.match(f.requests[0].task, /原文不需要含有现成习题/); assert.match(f.requests[0].task, /用中文考察变量/);
  assert.equal(f.requests[0].material.mode, 'generate'); assert.equal(f.requests[0].material.sourceUrl, sourceUrl);
  assert.equal(run.result.source.mode, 'generate'); assert.equal(run.result.source.url, sourceUrl);
  for (const item of run.result.questions) {
    assert.equal(item.status, 'pending'); assert.equal(item.id, undefined); assert.equal(item.difficulty, 2);
    assert.deepEqual(item.sourceRefs, [{ label: '编程基础第2章.pdf', url: sourceUrl }]); assert.equal(item.sourceDocument, '编程基础第2章.pdf');
    assert.deepEqual(item.categoryIds, ['chapter']); assert.deepEqual(item.tagIds, ['variable']);
  }
  assert.ok(run.warnings.some((warning: string) => warning.includes('少于3道上限')));
  assert.equal(f.store.all('questions').length, 0);
  await f.api(`/api/ai/runs/${run.id}/import`, { confirmed: false }, 400);
  const saved = await f.api(`/api/ai/runs/${run.id}/import`, { confirmed: true, indexes: [0, 1] });
  assert.equal(saved.added, 2); assert.ok(saved.items.every((item: any) => item.status === 'pending'));
  assert.deepEqual(saved.items[0].sourceRefs, run.result.questions[0].sourceRefs);
  await f.api(`/api/ai/runs/${run.id}/import`, { confirmed: true }, 409);
});

test('invalid generation constraints fail before any provider call or saved run', async t => {
  const f = await fixture(t);
  for (const changes of [
    { mode: 'rewrite' }, { questionTypes: ['true_false', 'true_false'] }, { questionTypes: ['unknown'] },
    { difficulty: 5 }, { difficulty: 1.5 }, { count: 51 }, { requirements: 'x'.repeat(5001) },
    { sourceUrl: 'file:///private/book.pdf' }, { sourceUrl: 'not-a-url' }, { sourceUrl: 'https://user:secret@example.test/book' },
    { categoryIds: ['missing'] }, { forcePublish: true },
  ]) await f.api('/api/ai/import', { mode: 'generate', text: chapter, ...changes }, 400);
  assert.equal(f.requests.length, 0); assert.equal(f.store.all('questions').length, 0); assert.equal(f.store.database.records<any>('ai_runs').filter(run => run.status === 'completed').length, 0);
});

test('out-of-range type, difficulty, quantity and duplicate generated questions reject the complete preview', async t => {
  const f = await fixture(t);
  const cases = [
    { value: result(question('题型不符', 'true_false')), constraints: { questionTypes: ['short_answer'] }, code: 'AI_IMPORT_TYPE_MISMATCH' },
    { value: result(question('难度不符', 'short_answer', 1)), constraints: { difficulty: 2 }, code: 'AI_IMPORT_DIFFICULTY_MISMATCH' },
    { value: result(question('重复题'), { ...question('另一标题'), stemMarkdown: '重复题' }), constraints: {}, code: 'AI_IMPORT_DUPLICATE' },
    { value: result(question('一'), question('二')), constraints: { count: 1 }, code: 'AI_IMPORT_TOO_MANY' },
  ];
  for (const row of cases) {
    f.output(row.value);
    const failed = await f.api('/api/ai/import', { text: chapter, mode: 'generate', ...row.constraints }, 502);
    assert.equal(failed.error.code, row.code);
    assert.equal(f.store.database.records<any>('ai_runs').filter(run => run.status === 'completed').length, 0); assert.equal(f.store.all('questions').length, 0);
  }
});

test('generated reference solutions must be present for every answerable group part before saving any preview', async t => {
  const f = await fixture(t);
  const part = (id: string) => ({ id, title: `子题${id}`, type: 'short_answer', stemMarkdown: `变量问题${id}`, answerMarkdown: '将名称关联到值。', explanationMarkdown: '由本章赋值语句的说明可知。' });
  const group = () => ({ ...question('阅读变量与表达式材料', 'group'), parts: [part('one'), part('two')] });
  const cases = [
    { ...question('缺参考解答'), answerMarkdown: undefined, explanationMarkdown: undefined },
    { ...question('空白参考解答'), answerMarkdown: ' \n\t ', explanationMarkdown: ' \n\t ' },
    { ...group(), parts: [part('one'), { ...part('two'), answerMarkdown: ' \n ', explanationMarkdown: '' }] },
  ];
  for (const candidate of cases) {
    // A valid first question must not be saved if the later item is incomplete.
    f.output(result(question('有效题目'), candidate));
    const failed = await f.api('/api/ai/import', { text: chapter, mode: 'generate' }, 502);
    assert.equal(failed.error.code, 'AI_IMPORT_MISSING_SOLUTION');
    assert.match(failed.error.message, /第2题.*缺少可核对的参考解答/);
    if (candidate.parts?.some(item => !item.answerMarkdown?.trim())) assert.match(failed.error.message, /小题/);
    assert.equal(f.store.database.records<any>('ai_runs').filter(run => run.status === 'completed').length, 0); assert.equal(f.store.all('questions').length, 0);
  }
  // The group parent is shared reading material, not an independently answered
  // question. Only its answerable leaves need solutions.
  f.output(result({ ...group(), answerMarkdown: '', explanationMarkdown: '' }));
  const run = await f.api('/api/ai/import', { text: chapter, mode: 'generate', questionTypes: ['group'] });
  assert.equal(run.result.questions[0].parts.length, 2);
  assert.equal(run.result.questions[0].answerMarkdown, ''); assert.equal(run.result.questions[0].explanationMarkdown, '');
  const imported = await f.api(`/api/ai/runs/${run.id}/import`, { confirmed: true });
  assert.equal(imported.added, 1); assert.equal(imported.items[0].status, 'pending'); assert.equal(imported.items[0].parts.length, 2);
});

test('generated explanations are optional when answers contain the solution, including group leaves', async t => {
  const f = await fixture(t), answer = '名称关联到值；赋值先计算右侧表达式，再将结果绑定到左侧名称。因此变量名与值并非同一个概念。';
  const part = (id: string, explanationMarkdown?: string) => ({ id, title: `子题${id}`, type: 'short_answer', stemMarkdown: `解释变量与赋值${id}。`, answerMarkdown: answer, explanationMarkdown });
  f.output(result(
    { ...question('参考答案已包含解释'), answerMarkdown: answer, explanationMarkdown: undefined },
    { ...question('无需独立解析的定义'), answerMarkdown: '表达式：能够计算并产生值的语法结构。', explanationMarkdown: '' },
    { ...question('公共材料无需另写解析', 'group'), answerMarkdown: '', explanationMarkdown: '', parts: [part('one'), part('two', '')] },
  ));
  const run = await f.api('/api/ai/import', { text: chapter, mode: 'generate' });
  assert.equal(run.result.questions.length, 3);
  assert.equal(run.result.questions[0].answerMarkdown, answer); assert.equal(run.result.questions[0].explanationMarkdown, '');
  assert.ok(run.result.questions[2].parts.every((item: any) => item.answerMarkdown === answer && item.explanationMarkdown === ''));
  const imported = await f.api(`/api/ai/runs/${run.id}/import`, { confirmed: true });
  assert.equal(imported.added, 3); assert.ok(imported.items.every((item: any) => item.status === 'pending'));
  assert.equal(imported.items[0].answerMarkdown, answer); assert.equal(imported.items[0].explanationMarkdown, '');
});

test('generation accepts explanation-only subjective solutions and objective structured keys without duplicate answer prose', async t => {
  const f = await fixture(t), explanation = '名称先关联到值；赋值计算右侧表达式后，再将值绑定到左侧名称。因此同一个名称可以在不同时间引用不同的值。';
  const objective = (title: string, type: string, fields: Record<string, unknown>) => ({ ...question(title, type), answerMarkdown: '', explanationMarkdown: '', ...fields });
  f.output(result(
    { ...question('答案放在解析中'), answerMarkdown: '', explanationMarkdown: explanation },
    objective('表达式可产生值', 'true_false', { correctAnswers: ['true'] }),
    objective('选择表达式', 'single_choice', { options: [{key:'A',text:'1 + 2'}, {key:'B',text:'if x:'}], correctAnswers: ['A'] }),
    objective('选择可产生值的表达式', 'multiple_choice', { options: [{key:'A',text:'1 + 2'}, {key:'B',text:'3 * 4'}, {key:'C',text:'赋值语句'}], correctAnswers: ['A','B'] }),
    objective('变量关联填空', 'fill_blank', { stemMarkdown:'变量将名称关联到____。', blanks:[{id:'value',label:'关联对象',answers:['值']}] }),
    { ...question('混合参考解答的组合题', 'group'), answerMarkdown:'', explanationMarkdown:'', parts:[
      {id:'explain',title:'主观解析解答',type:'short_answer',stemMarkdown:'变量绑定是什么意思？',answerMarkdown:'',explanationMarkdown:explanation},
      {id:'judge',title:'仅判分键',type:'true_false',stemMarkdown:'表达式能够产生值。',correctAnswers:['true'],answerMarkdown:'',explanationMarkdown:''},
    ] },
  ));
  const run = await f.api('/api/ai/import', {text:chapter, mode:'generate', count:10});
  assert.equal(run.result.questions.length,6);assert.ok(run.result.questions.every((item:any)=>item.answerMarkdown===''));
  const imported = await f.api(`/api/ai/runs/${run.id}/import`, {confirmed:true});
  assert.equal(imported.added,6);assert.ok(imported.items.every((item:any)=>item.status==='pending'));
  assert.equal(imported.items[0].explanationMarkdown,explanation);assert.deepEqual(imported.items.find((item:any)=>item.type==='multiple_choice').correctAnswers,['A','B']);
  assert.deepEqual(imported.items.find((item:any)=>item.type==='fill_blank').blanks[0].answers,['值']);
  assert.equal(imported.items.find((item:any)=>item.type==='group').parts[0].explanationMarkdown,explanation);
});

test('zero proposed questions produce actionable insufficient-material errors rather than malformed-output failures', async t => {
  const f = await fixture(t);
  f.output(result());
  const extracted = await f.api('/api/ai/import', { text: chapter }, 422);
  assert.equal(extracted.error.code, 'AI_IMPORT_NO_QUESTIONS'); assert.match(extracted.error.message, /未.*找到现成题目.*教材知识出题/);
  assert.equal(f.requests[0].material.mode, 'extract'); assert.match(f.requests[0].task, /questions:\[\]/);
  const generated = await f.api('/api/ai/import', { text: chapter, mode: 'generate' }, 422);
  assert.equal(generated.error.code, 'AI_IMPORT_NO_QUESTIONS'); assert.match(generated.error.message, /资料不足.*补充教材正文/);
  assert.match(f.requests[1].task, /questions:\[\]/);
  assert.equal(f.store.database.records<any>('ai_runs').filter(run => run.status === 'completed').length, 0); assert.equal(f.store.all('questions').length, 0);
  // Extraction still permits an honestly incomplete original question for manual
  // review; the stricter solution requirement is specific to newly generated work.
  f.output(result({ ...question('原题缺参考答案'), answerMarkdown: '', explanationMarkdown: '原资料未提供答案，需人工核实。' }));
  const run = await f.api('/api/ai/import', { text: chapter });
  assert.equal(run.result.questions[0].answerMarkdown, ''); assert.equal(run.result.questions[0].status, 'pending');
});

test('SSE propagates insufficient material and incomplete solutions without result frames or saved records', async t => {
  const f = await fixture(t);
  for (const row of [
    { mode: 'extract', output: result(), status: 422, code: 'AI_IMPORT_NO_QUESTIONS' },
    { mode: 'generate', output: result({ ...question('未完成的参考解答'), answerMarkdown: ' \n ', explanationMarkdown: '' }), status: 502, code: 'AI_IMPORT_MISSING_SOLUTION' },
  ]) {
    f.output(row.output);
    const response = await f.app.inject({ url: '/api/ai/import', method: 'POST', headers: { accept: 'text/event-stream' }, payload: { mode: row.mode, text: chapter } });
    assert.equal(response.statusCode, 200, response.body);
    const events = response.body.split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.split('\n').find(line => line.startsWith('data: '))!.slice(6)));
    assert.equal(events.filter(event => event.type === 'result').length, 0);
    const errors = events.filter(event => event.type === 'error'); assert.equal(errors.length, 1);
    assert.equal(errors[0].error.code, row.code); assert.equal(errors[0].error.statusCode, row.status);
    assert.equal(f.store.database.records<any>('ai_runs').filter(run => run.status === 'completed').length, 0); assert.equal(f.store.all('questions').length, 0);
  }
});

test('textbook generation uses the shared SSE pipeline and exposes only a validated pending preview', async t => {
  const f = await fixture(t);
  const response = await f.app.inject({ url: '/api/ai/import', method: 'POST', headers: { accept: 'text/event-stream' }, payload: { mode: 'generate', text: chapter, sourceName: '教材章节', questionTypes: ['short_answer'], count: 1 } });
  assert.equal(response.statusCode, 200, response.body); assert.match(String(response.headers['content-type']), /text\/event-stream/);
  const events = response.body.split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.split('\n').find(line => line.startsWith('data: '))!.slice(6)));
  assert.ok(events.some(event => event.type === 'delta'));
  const completed = events.find(event => event.type === 'result'); assert.ok(completed, response.body);
  assert.equal(completed.result.result.source.mode, 'generate'); assert.equal(completed.result.result.questions[0].status, 'pending');
  assert.equal(f.store.all('questions').length, 0); assert.equal(f.requests[0].stream, true);
});

test('OpenAPI uses the same import constraints and documents generated-source metadata', async t => {
  const app = await buildApp({ databasePath: ':memory:', staticRoot: 'missing-textbook-static', dailyPushScheduler: false });
  t.after(() => app.close());
  const response = await app.inject('/api/openapi.json'); assert.equal(response.statusCode, 200);
  const schema = response.json().paths['/api/ai/import'].post.requestBody.content['application/json'].schema;
  assert.deepEqual(schema.properties.mode.enum, ['extract', 'generate']); assert.equal(schema.properties.mode.default, 'extract');
  assert.equal(schema.properties.requirements.maxLength, 5000); assert.equal(schema.properties.count.maximum, 50);
  assert.equal(schema.properties.questionTypes.maxItems, 7); assert.ok(schema.properties.sourceUrl); assert.equal(schema.additionalProperties, false);
});
