import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { buildApp } from '../../server/index.js';

async function fixture(t: test.TestContext) {
  const app = await buildApp({
    databasePath: ':memory:',
    seedPath: 'test-results/no-math-seed',
    dailyPushScheduler: false,
    logger: false,
  });
  t.after(() => app.close());
  const api = async (path: string, method = 'GET', payload?: unknown, status = 200) => {
    const response = await app.inject({
      url: path,
      method: method as 'GET',
      ...(payload === undefined ? {} : { payload }),
    });
    assert.equal(response.statusCode, status, response.body);
    return response.json();
  };
  const q = await api(
    '/api/questions',
    'POST',
    {
      id: 'Q',
      title: '积分与单位',
      type: 'short_answer',
      mathEnabled: true,
      stemMarkdown: '$\\int_0^1 x\\,\\mathrm{d}x$ 的值是多少？',
      answerMarkdown: '$\\frac{1}{2}$',
    },
    201,
  );
  await api('/api/questions/review', 'POST', {
    ids: ['Q'],
    action: 'approve',
    confirmed: true,
    expectedUpdatedAt: { Q: q.updatedAt },
  });
  return { app, api };
}
test('API saves answer math in drafts and immutable question history without changing objective grading', async (t) => {
  const { api } = await fixture(t);
  const paper = await api(
      '/api/papers',
      'POST',
      { title: '公式练习', mode: 'manual', questionIds: ['Q'], scoring: { enabled: false } },
      201,
    ),
    attempt = await api(`/api/papers/${paper.id}/attempts`, 'POST', {}, 201);
  assert.equal(attempt.questions[0].mathEnabled, true);
  await api(`/api/attempts/${attempt.id}`, 'PUT', {
    answers: { Q: { value: '$\\frac{1}{2}$', mathEnabled: true } },
  });
  assert.equal((await api(`/api/attempts/${attempt.id}`)).answers.Q.mathEnabled, true);
  const submitted = await api(`/api/attempts/${attempt.id}/submit`, 'POST', {
    answers: { Q: { value: '$\\frac{1}{2}$', mathEnabled: true } },
  });
  assert.equal(submitted.answers.Q.mathEnabled, true);
  const history = await api('/api/questions/Q/history');
  assert.equal(history.items[0].answer.mathEnabled, true);
  assert.equal(history.items[0].question.mathEnabled, true);
  const fill = await api(
    '/api/questions',
    'POST',
    {
      id: 'F',
      title: '精确填空',
      type: 'fill_blank',
      mathEnabled: true,
      stemMarkdown: '$1+1=$ ____',
      blanks: [{ id: 'a', label: '结果', answers: ['2'], caseSensitive: false, trim: true }],
    },
    201,
  );
  await api('/api/questions/review', 'POST', {
    ids: ['F'],
    action: 'approve',
    confirmed: true,
    expectedUpdatedAt: { F: fill.updatedAt },
  });
  const fp = await api(
      '/api/papers',
      'POST',
      { title: '精确判分', mode: 'manual', questionIds: ['F'], scoring: { enabled: false } },
      201,
    ),
    fa = await api(`/api/papers/${fp.id}/attempts`, 'POST', {}, 201);
  const result = await api(`/api/attempts/${fa.id}/submit`, 'POST', {
    answers: { F: { value: ['1+1'] } },
  });
  assert.equal(
    result.answerStates.F,
    'incorrect',
    'formula display must not add symbolic equivalence grading',
  );
});
test('focus review persists formula answer mode across save, reveal and history', async (t) => {
  const { api } = await fixture(t);
  const paper = await api(
    '/api/papers',
    'POST',
    { title: '专注公式', mode: 'manual', questionIds: ['Q'], scoring: { enabled: false } },
    201,
  );
  let focus = await api(
    '/api/focus-sessions',
    'POST',
    { paperId: paper.id, scope: 'all', count: 1 },
    201,
  );
  focus = await api(`/api/focus-sessions/${focus.id}/current`, 'PUT', {
    index: 0,
    revision: focus.revision,
    action: 'save',
    mode: 'written',
    answer: '$1/2$',
    mathEnabled: true,
  });
  assert.equal(focus.current.answer.mathEnabled, true);
  focus = await api(`/api/focus-sessions/${focus.id}/current`, 'PUT', {
    index: 0,
    revision: focus.revision,
    action: 'reveal',
    mode: 'written',
    answer: '$1/2$',
    mathEnabled: true,
  });
  assert.equal(focus.current.answer.mathEnabled, true);
  assert.equal((await api(`/api/attempts/${focus.current.attemptId}`)).answers.Q.mathEnabled, true);
});
test('AI formula output, note appending and malformed generation use audited contracts', async (t) => {
  const { api } = await fixture(t);
  let malformed = false,
    requests = 0;
  const provider = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw),
      input = JSON.parse(body.messages[1].content);
    assert.match(body.messages[0].content, /mathEnabled:true/);
    assert.match(body.messages[0].content, /反斜杠/);
    requests++;
    const result = input.task.includes('explanationMarkdown、followUpsMarkdown')
      ? {
          explanationMarkdown: '结果为 $\\frac{1}{2}$。',
          followUpsMarkdown: '单位写成 $\\mathrm{m/s^2}$。',
          pitfallsMarkdown: '',
        }
      : {
          questions: [
            {
              title: '化学表达',
              type: 'short_answer',
              mathEnabled: true,
              stemMarkdown: malformed ? '$\\frac{1}{$' : '配平 $\\ce{H2 + O2 -> H2O}$。',
              answerMarkdown: '$\\ce{2H2 + O2 -> 2H2O}$',
            },
          ],
          taxonomySuggestions: { domains: [], categories: [], tags: [] },
        };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }],
      }),
    );
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => provider.close(() => resolve())));
  const address = provider.address() as { port: number };
  await api('/api/ai/settings', 'PUT', {
    enabled: true,
    baseUrl: `http://127.0.0.1:${address.port}`,
    model: 'isolated-formula-test',
    key: 'test-only',
    timeoutSeconds: 10,
    maxTokens: 4096,
    supportsImages: false,
    sendImages: false,
  });
  await api('/api/study/Q', 'PUT', { notes: '预算 $10，余额 $2。' });
  const run = await api('/api/ai/explain', 'POST', { questionId: 'Q' });
  assert.equal(run.mathEnabled, true);
  await api(`/api/ai/runs/${run.id}/apply`, 'POST', { confirmed: true, appendNotes: true });
  const updated = await api('/api/questions/Q');
  assert.equal(updated.study.notesMathEnabled, true);
  assert.match(updated.study.notes, /预算 \\\$10/);
  assert.match(updated.study.notes, /\$\\frac\{1\}\{2\}\$/);
  const imported = await api('/api/ai/import', 'POST', {
    text: '水的化合反应',
    mode: 'generate',
    count: 1,
  });
  assert.equal(imported.result.questions[0].mathEnabled, true);
  assert.equal(imported.result.questions[0].status, 'pending');
  malformed = true;
  await api('/api/ai/import', 'POST', { text: '无效公式', mode: 'generate', count: 1 }, 502);
  const failed = await api('/api/ai/runs?kind=import&status=failed');
  assert.ok(failed.some((item: any) => item.failure.code === 'AI_IMPORT_INVALID_FORMULA'));
  assert.equal(requests, 3);
});
