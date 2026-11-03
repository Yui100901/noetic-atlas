import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { Store, now, nextStamp } from '../../server/core/store.js';
import { ApiError, questionSchema } from '../../server/core/validation.js';
import type { Question } from '../../shared/models/types.js';
import { questionRevisionContent } from '../../shared/questions/question-revisions.js';
import { registerQuestionRoutes } from '../../server/modules/questions/routes.js';
import { registerQuestionDraftRoutes } from '../../server/modules/questions/drafts.js';
import { registerQuestionRevisionRoutes } from '../../server/modules/questions/revisions.js';
import { validateQuestionRevision } from '../../server/modules/questions/maintenance-schema.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';
import { buildApp } from '../../server/index.js';

test('revision summaries do not load the current source body just to establish existence', async (t) => {
  const f = await fixture(t),
    question = f.put();
  await f.api('/api/questions/' + question.id, 'PUT', { ...question, title: '修订后' });
  const original = f.store.get.bind(f.store);
  f.store.get = ((table: string, id: string) => {
    assert.notEqual(
      table,
      'questions',
      'summary lists must project the source identity instead of its full body',
    );
    return original(table as any, id);
  }) as typeof f.store.get;
  const page = await f.api('/api/questions/' + question.id + '/revisions');
  assert.equal(page.total, 2);
  assert.ok(page.items.every((item: any) => !Object.hasOwn(item, 'content')));
  await f.api('/api/questions/MISSING/revisions', 'GET', undefined, 404);
});

async function fixture(t: test.TestContext) {
  const store = new Store(':memory:');
  store.put('settings', 'system', { ...DEFAULT_SETTINGS, updatedAt: now() });
  const app = Fastify({ bodyLimit: 80 * 1024 * 1024 });
  app.setErrorHandler((error, _request, reply) =>
    reply.code(error instanceof ApiError ? error.status : 500).send({
      error: {
        code: error instanceof ApiError ? error.code : 'TEST_ERROR',
        message: error.message,
      },
    }),
  );
  registerQuestionRoutes(app, store);
  registerQuestionDraftRoutes(app, store);
  registerQuestionRevisionRoutes(app, store);
  const api = async (url: string, method = 'GET', payload?: unknown, status = 200) => {
    const result = await app.inject({
      url,
      method: method as any,
      ...(payload === undefined ? {} : { payload }),
    });
    assert.equal(result.statusCode, status, result.body);
    return result.json();
  };
  const put = (id = 'Q', patch: Partial<Question> = {}) => {
    const q = {
      ...questionSchema.parse({
        id,
        title: '事务整体性',
        type: 'short_answer',
        stemMarkdown: '解释原子性。',
        answerMarkdown: '整体提交或整体回滚。',
        createdAt: now(),
        updatedAt: now(),
        status: 'published',
        ...patch,
      }),
    } as Question;
    store.put('questions', id, q);
    return q;
  };
  const state = (q: Question) => ({
    form: { ...questionRevisionContent(q), status: q.status },
    sources: '尚未完成的来源行',
    reason: '编辑中的说明',
  });
  t.after(async () => {
    await app.close();
    store.database.close();
  });
  return { app, store, api, put, state };
}

test('incomplete question drafts are private snapshots, context-capped and resumed by identity with optimistic versions', async (t) => {
  const f = await fixture(t),
    q = f.put(),
    state = f.state(q);
  state.form.title = '';
  state.form.stemMarkdown = '';
  state.form.type = 'single_choice';
  state.form.options = [{ key: 'A', text: '' }];
  state.form.correctAnswers = ['MISSING'];
  const before = f.store.require('questions', q.id),
    draft = await f.api(
      '/api/question-drafts',
      'POST',
      { questionId: q.id, baseUpdatedAt: q.updatedAt, state },
      201,
    );
  assert.deepEqual(f.store.require('questions', q.id), before);
  assert.equal(draft.conflict, false);
  let latest = draft;
  for (let i = 0; i < 3; i++)
    latest = await f.api(
      '/api/question-drafts',
      'POST',
      { questionId: q.id, baseUpdatedAt: q.updatedAt, state: { ...state, reason: '草稿' + i } },
      201,
    );
  const list = await f.api('/api/question-drafts?questionId=Q&page=1&pageSize=2');
  assert.equal(list.total, 3);
  assert.equal(list.items.length, 2);
  assert.equal(list.items[0].id, latest.id);
  assert.equal(list.items[0].state, undefined);
  await f.api('/api/question-drafts/' + draft.id, 'GET', undefined, 404);
  const saved = await f.api('/api/question-drafts/' + latest.id, 'PUT', {
    expectedUpdatedAt: latest.updatedAt,
    state: { ...state, reason: '继续同份草稿' },
  });
  assert.equal(saved.id, latest.id);
  assert.notEqual(saved.updatedAt, latest.updatedAt);
  assert.equal((await f.api('/api/question-drafts?questionId=Q')).total, 3);
  await f.api(
    '/api/question-drafts/' + latest.id,
    'PUT',
    { expectedUpdatedAt: latest.updatedAt, state },
    409,
  );
  await f.api(
    '/api/question-drafts/' + latest.id,
    'DELETE',
    { expectedUpdatedAt: latest.updatedAt },
    409,
  );
  await f.api('/api/question-drafts/' + latest.id, 'DELETE', {
    expectedUpdatedAt: saved.updatedAt,
  });
  assert.equal((await f.api('/api/question-drafts?questionId=Q')).total, 2);
});

test('draft source changes remain explicit conflicts until an intentional current-version rebase', async (t) => {
  const f = await fixture(t),
    q = f.put(),
    state = f.state(q),
    draft = await f.api(
      '/api/question-drafts',
      'POST',
      { questionId: q.id, baseUpdatedAt: q.updatedAt, state },
      201,
    );
  const changed = { ...q, title: '另一个编辑页的新标题', updatedAt: nextStamp(q.updatedAt) };
  f.store.put('questions', q.id, changed);
  assert.equal((await f.api('/api/question-drafts/' + draft.id)).conflict, true);
  const continued = await f.api('/api/question-drafts/' + draft.id, 'PUT', {
    expectedUpdatedAt: draft.updatedAt,
    state,
  });
  assert.equal(continued.baseUpdatedAt, q.updatedAt);
  assert.equal(continued.conflict, true);
  await f.api(
    '/api/question-drafts/' + draft.id,
    'PUT',
    { expectedUpdatedAt: continued.updatedAt, baseUpdatedAt: q.updatedAt, state },
    409,
  );
  const rebased = await f.api('/api/question-drafts/' + draft.id, 'PUT', {
    expectedUpdatedAt: continued.updatedAt,
    baseUpdatedAt: changed.updatedAt,
    state,
  });
  assert.equal(rebased.conflict, false);
  await f.api(
    '/api/questions/Q',
    'PUT',
    { ...q, title: '旧草稿标题', draftId: draft.id, draftUpdatedAt: rebased.updatedAt },
    409,
  );
  assert.equal((await f.api('/api/question-drafts/' + draft.id)).updatedAt, rebased.updatedAt);
});

test('formal save consumes only its matching current draft atomically and never lets new drafts self-publish', async (t) => {
  const f = await fixture(t),
    q = f.put(),
    draft = await f.api(
      '/api/question-drafts',
      'POST',
      { questionId: q.id, baseUpdatedAt: q.updatedAt, state: f.state(q) },
      201,
    ),
    other = f.put('OTHER');
  await f.api(
    '/api/questions/OTHER',
    'PUT',
    { ...other, title: '跨题误覆盖', draftId: draft.id, draftUpdatedAt: draft.updatedAt },
    409,
  );
  assert.equal((await f.api('/api/questions/OTHER')).title, other.title);
  const changed = await f.api('/api/questions/Q', 'PUT', {
    ...q,
    title: '修改后的标题',
    draftId: draft.id,
    draftUpdatedAt: draft.updatedAt,
    revisionReason: '澄清题意',
  });
  assert.equal(changed.title, '修改后的标题');
  await f.api('/api/question-drafts/' + draft.id, 'GET', undefined, 404);
  const newDraft = await f.api(
    '/api/question-drafts',
    'POST',
    { questionId: null, baseUpdatedAt: null, state: f.state(q) },
    201,
  );
  const created = await f.api(
    '/api/questions',
    'POST',
    {
      ...questionRevisionContent(q),
      status: 'published',
      draftId: newDraft.id,
      draftUpdatedAt: newDraft.updatedAt,
    },
    201,
  );
  assert.equal(created.status, 'pending');
  await f.api('/api/question-drafts/' + newDraft.id, 'GET', undefined, 404);
  const first = await f.api('/api/questions/' + created.id + '/revisions');
  assert.equal(first.total, 1);
  assert.equal(first.items[0].origin, 'baseline');
});

test('revisions show field differences, omit admission and learning fields and do not record no-op or review-only saves', async (t) => {
  const f = await fixture(t),
    q = f.put();
  f.store.putStudy({ ...f.store.study(q.id), notes: '私人学习笔记' });
  const first = await f.api('/api/questions/Q', 'PUT', {
    ...q,
    answerMarkdown: '事务全部成功才提交，否则整体回滚。',
    revisionReason: '补充成功条件',
  });
  const list = await f.api('/api/questions/Q/revisions');
  assert.equal(list.total, 2);
  assert.deepEqual(list.items[0].changedFields, ['answerMarkdown']);
  assert.equal(list.items[0].content, undefined);
  assert.equal(list.items[0].reason, '补充成功条件');
  const detail = await f.api('/api/questions/Q/revisions/' + list.items[1].id);
  assert.equal(detail.content.status, undefined);
  assert.equal(detail.content.id, undefined);
  assert.equal(detail.content.study, undefined);
  assert.deepEqual(
    detail.diff.map((item: any) => item.field),
    ['answerMarkdown'],
  );
  assert.equal(detail.diff[0].before, q.answerMarkdown);
  await f.api('/api/questions/Q', 'PUT', { ...first, revisionReason: '正文没有变化' });
  assert.equal((await f.api('/api/questions/Q/revisions')).total, 2);
  const pending = f.put('PENDING', { status: 'pending' });
  await f.api('/api/questions/review', 'POST', {
    ids: [pending.id],
    action: 'approve',
    confirmed: true,
    expectedUpdatedAt: { [pending.id]: pending.updatedAt },
  });
  assert.equal((await f.api('/api/questions/PENDING/revisions')).total, 0);
  assert.equal(f.store.study(q.id).notes, '私人学习笔记');
});

test('restore is an explicit new revision with current identity/status and preserves frozen papers, grades and study', async (t) => {
  const f = await fixture(t),
    q = f.put('Q', { status: 'pending' }),
    oldStudy = { ...f.store.study(q.id), notes: '已有笔记' };
  f.store.putStudy(oldStudy);
  const changed = await f.api('/api/questions/Q', 'PUT', { ...q, title: '新标题' });
  const list = await f.api('/api/questions/Q/revisions'),
    baseline = list.items.find((item: any) => item.origin === 'baseline');
  const frozen = {
    id: 'P',
    title: '冻结题集',
    snapshot: [q],
    questionIds: ['Q'],
    custom: 'snapshot',
  };
  f.store.put('papers', 'P', frozen);
  const attempt = {
    id: 'A',
    questions: [q],
    answers: { Q: { value: '回答', score: 3 } },
    objectiveScore: 0,
    subjectiveScore: 3,
  };
  f.store.put('attempts', 'A', attempt);
  const path = '/api/questions/Q/revisions/' + baseline.id + '/restore';
  await f.api(path, 'POST', { expectedUpdatedAt: changed.updatedAt }, 400);
  await f.api(path, 'POST', { expectedUpdatedAt: q.updatedAt, confirmed: true }, 409);
  const restored = await f.api(path, 'POST', {
    expectedUpdatedAt: changed.updatedAt,
    confirmed: true,
    reason: '恢复误改标题',
  });
  assert.equal(restored.id, q.id);
  assert.equal(restored.title, q.title);
  assert.equal(restored.status, 'pending');
  assert.equal(restored.createdAt, q.createdAt);
  assert.notEqual(restored.updatedAt, changed.updatedAt);
  const history = await f.api('/api/questions/Q/revisions');
  assert.equal(history.total, 3);
  assert.equal(history.items[0].origin, 'restore');
  assert.equal(history.items[0].restoredFromId, baseline.id);
  assert.deepEqual(f.store.require('papers', 'P'), frozen);
  assert.deepEqual(f.store.require('attempts', 'A'), attempt);
  assert.deepEqual(f.store.study(q.id), oldStudy);
});

test('old malformed baselines remain inspectable while restoration validates answers and current dependencies', async (t) => {
  const f = await fixture(t),
    bad = {
      ...f.put(),
      type: 'single_choice' as const,
      options: [
        { key: 'A', text: '甲' },
        { key: 'B', text: '乙' },
      ],
      correctAnswers: ['MISSING'],
    };
  f.store.put('questions', bad.id, bad);
  const fixed = await f.api('/api/questions/Q', 'PUT', { ...bad, correctAnswers: ['A'] });
  const history = await f.api('/api/questions/Q/revisions');
  assert.equal(history.total, 2);
  const baseline = history.items.find((item: any) => item.origin === 'baseline');
  await f.api(
    '/api/questions/Q/revisions/' + baseline.id + '/restore',
    'POST',
    { expectedUpdatedAt: fixed.updatedAt, confirmed: true },
    400,
  );
  assert.equal((await f.api('/api/questions/Q')).correctAnswers[0], 'A');
  const validDetail = await f.api('/api/questions/Q/revisions/' + history.items[0].id);
  assert.ok(validDetail.content);
});

test('repairing a missing attachment retains readable baseline evidence but cannot restore the broken content', async (t) => {
  const f = await fixture(t);
  const broken = f.put('MISSING-ASSET', {
    stemMarkdown: '![旧图片](/api/assets/missing-asset/content)\n\n解释事务。',
  });
  const fixed = await f.api('/api/questions/MISSING-ASSET', 'PUT', {
    ...broken,
    stemMarkdown: '解释事务整体性。',
  });
  const history = await f.api('/api/questions/MISSING-ASSET/revisions');
  const baseline = history.items.find((item: any) => item.origin === 'baseline');
  const saved = f.store.require<any>('question_revisions', baseline.id);
  assert.doesNotThrow(() => validateQuestionRevision(f.store, saved));
  const detail = await f.api('/api/questions/MISSING-ASSET/revisions/' + baseline.id);
  assert.match(detail.content.stemMarkdown, /missing-asset/);
  await f.api(
    '/api/questions/MISSING-ASSET/revisions/' + baseline.id + '/restore',
    'POST',
    { expectedUpdatedAt: fixed.updatedAt, confirmed: true },
    400,
  );
  assert.equal((await f.api('/api/questions/MISSING-ASSET')).stemMarkdown, '解释事务整体性。');
  assert.equal((await f.api('/api/questions/MISSING-ASSET/revisions')).total, 2);
});

test('bounded revisions and delete cascade affect only the selected source maintenance rows', async (t) => {
  const f = await fixture(t);
  f.store.put('settings', 'system', {
    ...DEFAULT_SETTINGS,
    updatedAt: now(),
    maxQuestionRevisions: 2,
  });
  let q = f.put();
  const other = f.put('OTHER');
  for (let i = 0; i < 4; i++)
    q = await f.api('/api/questions/Q', 'PUT', { ...q, title: '版本' + i });
  const history = await f.api('/api/questions/Q/revisions');
  assert.equal(history.total, 2);
  assert.equal(history.items[0].sequence, 5);
  await f.api(
    '/api/question-drafts',
    'POST',
    { questionId: q.id, baseUpdatedAt: q.updatedAt, state: f.state(q) },
    201,
  );
  await f.api(
    '/api/question-drafts',
    'POST',
    { questionId: other.id, baseUpdatedAt: other.updatedAt, state: f.state(other) },
    201,
  );
  await f.api('/api/questions/Q', 'DELETE');
  assert.equal(f.store.database.records('question_revisions').length, 0);
  assert.equal((await f.api('/api/question-drafts?questionId=OTHER')).total, 1);
});

test('draft envelopes reject identity/learning injection and docs expose versioned inputs and bounded lists', async (t) => {
  const f = await fixture(t),
    q = f.put(),
    state = f.state(q);
  for (const patch of [
    { id: 'OTHER' },
    { createdAt: now() },
    { study: { notes: 'injected' } },
    { feedbackSummary: { active: 0 } },
  ])
    await f.api(
      '/api/question-drafts',
      'POST',
      {
        questionId: q.id,
        baseUpdatedAt: q.updatedAt,
        state: { ...state, form: { ...state.form, ...patch } },
      },
      400,
    );
  await f.api(
    '/api/question-drafts',
    'POST',
    {
      questionId: q.id,
      baseUpdatedAt: q.updatedAt,
      state: { ...state, sources: '旧来源 /api/assets/absent-source/content' },
    },
    400,
  );
  await f.api(
    '/api/question-drafts',
    'POST',
    {
      questionId: q.id,
      baseUpdatedAt: q.updatedAt,
      state: { ...state, reason: '已删除 /api/assets/absent-source/content 的失效引用' },
    },
    201,
  );
  const app = await buildApp({
    databasePath: ':memory:',
    seedPath: 'absent-maintenance-seed',
    dailyPushScheduler: false,
    staticRoot: 'absent-maintenance-web',
  });
  t.after(() => app.close());
  const spec = (await app.inject('/api/openapi.json')).json();
  assert.ok(
    spec.paths['/api/question-drafts'].post.requestBody.content['application/json'].schema
      .properties.state,
  );
  assert.ok(
    spec.paths['/api/questions/{id}/revisions/{revisionId}/restore'].post.requestBody.content[
      'application/json'
    ].schema.required.includes('expectedUpdatedAt'),
  );
  assert.equal(
    spec.paths['/api/question-drafts'].get.responses[200].content['application/json'].schema
      .properties.items.items.properties.state,
    undefined,
  );
  assert.ok(
    spec.paths['/api/questions'].post.requestBody.content['application/json'].schema.properties
      .revisionReason,
  );
});
