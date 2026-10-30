import test from 'node:test';
import {
  getSettings,
  saveSettings,
  settingsRetentionPlan,
} from '../../server/modules/settings/service.js';
import { buildApp } from '../../server/index.js';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Store } from '../../server/core/store.js';
import { questionSchema } from '../../server/core/validation.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';
import type { FocusSession } from '../../shared/models/focus-review.js';
import type { Question } from '../../shared/models/types.js';
import {
  buildPaper,
  reviewAttempt,
  type StoredAttempt,
} from '../../server/modules/practice/service.js';
import {
  actFocus,
  createFocus,
  focusView,
  validateFocusSession,
} from '../../server/modules/focus-review/service.js';
import { registerFocusRoutes } from '../../server/modules/focus-review/routes.js';
import { createFocusSchema, focusActionSchema } from '../../server/modules/focus-review/schema.js';
import { questionStatistics } from '../../server/modules/questions/history.js';
import { exportData, importData } from '../../server/modules/transfer/migration.js';
import { learningResetPreview, resetLearningProgress } from '../../server/modules/study/reset.js';
import {
  initialPracticeTiming,
  updatePracticeTiming,
} from '../../server/modules/practice/practice-timing.js';

function fixture(t: test.TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  store.put('settings', 'system', structuredClone(DEFAULT_SETTINGS));
  const values = [
    {
      id: 'TF',
      title: '判断',
      type: 'true_false',
      stemMarkdown: '进程具有独立地址空间。',
      correctAnswers: ['true'],
      answerMarkdown: '答案隐私标记',
    },
    {
      id: 'SA',
      title: '解释',
      type: 'short_answer',
      stemMarkdown: '说明互斥与同步。',
      answerMarkdown: '答案隐私标记',
    },
    {
      id: 'GROUP',
      title: '程序阅读',
      type: 'group',
      stemMarkdown: '共享材料隐私标记',
      parts: [
        {
          id: 'a',
          title: '小题一',
          type: 'true_false',
          stemMarkdown: '判断程序是否终止。',
          correctAnswers: ['true'],
        },
        {
          id: 'b',
          title: '小题二',
          type: 'short_answer',
          stemMarkdown: '解释理由。',
          answerMarkdown: '答案隐私标记',
        },
      ],
    },
    {
      id: 'WORD',
      title: 'abandon',
      type: 'short_answer',
      stemMarkdown: 'abandon',
      answerMarkdown: '放弃',
      vocabulary: {
        language: 'en',
        headword: 'abandon',
        meaningPrompt: '放弃',
        acceptedAnswers: ['abandon'],
        pronunciations: [
          {
            label: '英式',
            ipa: 'əˈbændən',
            sourceLabel: '隔离测试',
            sourceUrl: 'https://example.test/word',
            license: '测试',
            method: 'manual',
          },
        ],
      },
    },
    {
      id: 'CONCEPT',
      title: '沉没成本',
      type: 'short_answer',
      stemMarkdown: '沉没成本',
      answerMarkdown: '已经发生且无法收回的支出',
      concept: {
        term: '沉没成本',
        meaningPrompt: '已经发生且无法收回的支出',
        acceptedAnswers: ['沉没成本'],
      },
    },
  ];
  for (const value of values) {
    const q = questionSchema.parse({ ...value, status: 'published' }) as Question;
    store.put('questions', q.id, q);
    const paper = buildPaper(store, {
      id: `P-${q.id}`,
      title: `复习${q.id}`,
      description: '',
      mode: 'manual',
      questionIds: [q.id],
    });
    store.put('papers', paper.id, paper);
  }
  const create = (id = 'TF', extra = {}) =>
    createFocus(
      store,
      createFocusSchema.parse({ paperId: `P-${id}`, scope: 'all', count: 20, ...extra }),
    );
  const act = (session: FocusSession, action: string, extra: Record<string, unknown> = {}) =>
    actFocus(
      store,
      store.require<FocusSession>('focus_sessions', session.id),
      focusActionSchema.parse({
        index: session.index,
        revision: session.revision,
        action,
        ...extra,
      }),
    );
  return { store, create, act };
}

test('mental recall never counts as an answer and FSRS rating retries are idempotent', (t) => {
  const { store, create, act } = fixture(t);
  let session = create();
  assert.doesNotMatch(
    JSON.stringify(focusView(session)),
    /答案隐私标记|correctAnswers|explanationMarkdown|answerMarkdown/,
  );
  assert.equal(store.all('attempts').length, 0);
  session = act(session, 'reveal', { mode: 'mental' });
  assert.match(JSON.stringify(focusView(session)), /答案隐私标记/);
  const request = focusActionSchema.parse({
    index: 0,
    revision: session.revision,
    action: 'rate',
    rating: 'good',
  });
  session = actFocus(store, session, request);
  actFocus(store, store.require('focus_sessions', session.id), request);
  assert.equal(session.status, 'submitted');
  assert.equal(session.summary!.mental, 1);
  assert.equal(store.all('review_events').length, 1);
  assert.equal(store.all('attempts').length, 0);
  assert.equal(questionStatistics(store, 'TF').answered, 0);
});

test('written objective is counted once; wrong work can only schedule Again', (t) => {
  const { store, create, act } = fixture(t);
  let session = create();
  session = act(session, 'reveal', { mode: 'written', answer: 'false' });
  const request = focusActionSchema.parse({
    index: 0,
    revision: 1,
    action: 'reveal',
    mode: 'written',
    answer: 'false',
  });
  actFocus(store, store.require('focus_sessions', session.id), request);
  assert.equal(questionStatistics(store, 'TF').answered, 1);
  assert.equal(questionStatistics(store, 'TF').incorrect, 1);
  assert.equal(store.all('review_events').length, 0);
  assert.throws(() => act(session, 'rate', { rating: 'good' }), /回答错误/);
  session = act(session, 'rate', { rating: 'again' });
  assert.equal(store.all('review_events').length, 1);
  assert.equal(questionStatistics(store, 'TF').answered, 1);
  assert.equal(session.summary!.written, 1);
});

test('written subjective supports ungraded and partial/correct verdicts without duplicate reviews', (t) => {
  const { store, create, act } = fixture(t);
  let session = create('SA');
  session = act(session, 'reveal', {
    mode: 'written',
    answer: '互斥限制同时访问，同步约束执行次序。',
  });
  assert.equal(questionStatistics(store, 'SA').ungraded, 1);
  session = act(session, 'rate', { rating: 'good', verdict: 'correct' });
  assert.equal(questionStatistics(store, 'SA').correct, 1);
  assert.equal(store.all('review_events').length, 1);
  const attempt = store.require<StoredAttempt>('attempts', session.items[0]!.attemptId!);
  reviewAttempt(store, attempt, {}, {}, { SA: 'partial' });
  assert.equal(questionStatistics(store, 'SA').partial, 1);
  assert.equal(store.all('review_events').length, 1);
  let second = create('SA');
  second = act(second, 'reveal', { mode: 'written', answer: '不完整说明' });
  assert.throws(() => act(second, 'rate', { rating: 'easy', verdict: 'partial' }), /关键遗漏/);
  second = act(second, 'rate', { rating: 'again', verdict: 'partial' });
  assert.equal(questionStatistics(store, 'SA').answered, 2);
});

test('group parts retain shared material but receive independent review states', (t) => {
  const { store, create, act } = fixture(t);
  let session = create('GROUP');
  assert.equal(session.items.length, 2);
  assert.ok(session.items.every((item) => item.question.groupStemMarkdown === '共享材料隐私标记'));
  const partId = session.items[0]!.partId;
  session = act(session, 'reveal', { mode: 'mental' });
  session = act(session, 'rate', { rating: 'good' });
  session = act(session, 'skip');
  assert.equal(session.summary!.rated, 1);
  assert.equal(session.summary!.skipped, 1);
  assert.equal(store.all<any>('review_cards')[0]!.partId, partId);
  assert.equal(questionStatistics(store, 'GROUP').answered, 0);
});

test('reverse word and concept prompts do not reveal the target; written fills count correctly', (t) => {
  const { store, create, act } = fixture(t);
  for (const [id, answer] of [
    ['WORD', 'abandon'],
    ['CONCEPT', '沉没成本'],
  ]) {
    let session = create(id, { direction: 'meaning_to_word' });
    const before = JSON.stringify(focusView(session));
    assert.ok(!before.includes(answer!));
    session = act(session, 'reveal', { mode: 'written', answer: [answer] });
    assert.equal(focusView(session).current!.correct, true);
    session = act(session, 'rate', { rating: 'easy' });
    assert.equal(questionStatistics(store, id!).correct, 1);
  }
});

test('draft retention, stale tabs, source changes and skip do not corrupt prior learning', (t) => {
  const { store, create, act } = fixture(t);
  for (let i = 0; i < 4; i++) create();
  assert.equal(store.all('focus_sessions').length, 3);
  let session = create('SA');
  const old = structuredClone(session);
  session = act(session, 'save', { mode: 'written', answer: '草稿原文' });
  assert.throws(() => act(old, 'save', { answer: '另一标签页' }), /其他页面/);
  const q = store.require<Question>('questions', 'SA');
  store.put('questions', 'SA', { ...q, answerMarkdown: '修订后的答案' });
  assert.throws(
    () => act(session, 'reveal', { mode: 'written', answer: '草稿原文' }),
    /原题已修改/,
  );
  session = act(session, 'skip');
  assert.equal(store.all('attempts').length, 0);
  assert.equal(store.all('review_events').length, 0);
  assert.equal(session.summary!.skipped, 1);
});

test('focus sessions round-trip with drafts and actual answers through JSON migration', (t) => {
  const { store, create, act } = fixture(t);
  let draft = create('SA');
  draft = act(draft, 'save', { mode: 'written', answer: '可迁移草稿' });
  let answered = create();
  answered = act(answered, 'reveal', { mode: 'written', answer: 'true' });
  const target = new Store(':memory:');
  t.after(() => target.db.close());
  importData(target, exportData(store));
  assert.equal(
    validateFocusSession(target.require('focus_sessions', draft.id)).items[0]!.answer!.value,
    '可迁移草稿',
  );
  let restored = target.require<FocusSession>('focus_sessions', answered.id);
  restored = actFocus(
    target,
    restored,
    focusActionSchema.parse({
      index: 0,
      revision: restored.revision,
      action: 'rate',
      rating: 'good',
    }),
  );
  assert.equal(restored.status, 'submitted');
  assert.equal(questionStatistics(target, 'TF').correct, 1);
  assert.equal(target.all('review_events').length, 1);
});

test('fixed due selection advances the existing due date; skips leave scheduling unchanged', (t) => {
  const { store, create, act } = fixture(t);
  store.put('settings', 'system', {
    ...structuredClone(DEFAULT_SETTINGS),
    reviewScheduling: { ...DEFAULT_SETTINGS.reviewScheduling, strategy: 'fixed' },
  });
  store.putStudy({ ...store.study('TF'), nextReviewAt: '2020-01-01T00:00:00.000Z' });
  let session = create('TF', { scope: 'due' });
  session = act(session, 'reveal', { mode: 'mental' });
  session = act(session, 'rate', { rating: 'good' });
  assert.equal(store.all('review_events').length, 0);
  assert.ok(Date.parse(store.study('TF').nextReviewAt!) > Date.now());
  assert.throws(() => create('TF', { scope: 'due' }), /没有到期/);
});

test('leaving and resuming use cumulative checkpoints, and reset closes old sessions', (t) => {
  const { store, create } = fixture(t);
  let session = create();
  const previous = initialPracticeTiming({ elapsedSeconds: 0 });
  assert.deepEqual(session.practiceTiming, previous);
  session = updatePracticeTiming(
    store,
    session,
    { action: 'resume', sessionId: 'focus-timer-1', expectedSessionId: null },
    'focus_sessions',
  );
  session = updatePracticeTiming(
    store,
    session,
    { action: 'pause', sessionId: 'focus-timer-1', elapsedMilliseconds: 12500 },
    'focus_sessions',
  );
  assert.equal(session.elapsedSeconds, 12);
  assert.equal(session.practiceTiming.running, false);
  session = updatePracticeTiming(
    store,
    session,
    { action: 'resume', sessionId: 'focus-timer-2', expectedSessionId: 'focus-timer-1' },
    'focus_sessions',
  );
  session = updatePracticeTiming(
    store,
    session,
    { action: 'checkpoint', sessionId: 'focus-timer-2', elapsedMilliseconds: 3500 },
    'focus_sessions',
  );
  assert.equal(session.elapsedSeconds, 16);
  const preview = learningResetPreview(store);
  resetLearningProgress(store, preview.fingerprint);
  const reset = store.require<FocusSession>('focus_sessions', session.id);
  assert.equal(reset.reset, true);
  assert.equal(reset.status, 'submitted');
  assert.equal(reset.practiceTiming.running, false);
  assert.throws(
    () =>
      actFocus(
        store,
        reset,
        focusActionSchema.parse({ index: 0, revision: reset.revision, action: 'reveal' }),
      ),
    /已结束/,
  );
});

test('list/detail APIs paginate summaries without exposing unrevealed snapshots', async (t) => {
  const { store, create } = fixture(t);
  const session = create('SA'),
    app = Fastify();
  t.after(() => app.close());
  registerFocusRoutes(app, store);
  const list = await app.inject({
    method: 'GET',
    url: '/api/focus-sessions?paperId=P-SA&page=1&pageSize=10',
  });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().total, 1);
  assert.doesNotMatch(list.body, /答案隐私标记|stemMarkdown|sourceFingerprint/);
  const detail = await app.inject({ method: 'GET', url: `/api/focus-sessions/${session.id}` });
  assert.equal(detail.statusCode, 200);
  assert.doesNotMatch(detail.body, /答案隐私标记|answerMarkdown/);
});

test('changing retention limits previews and confirms focus cleanup while retaining learning events', (t) => {
  const { store, create, act } = fixture(t);
  for (let i = 0; i < 3; i++) {
    let session = create('TF');
    session = act(session, 'reveal', { mode: 'mental' });
    act(session, 'rate', { rating: 'good' });
    create('SA');
  }
  const settings = { ...getSettings(store), maxDraftsPerPaper: 1, maxHistoryPerPaper: 1 },
    plan = settingsRetentionPlan(store, settings);
  assert.equal(plan.retention.focusDrafts, 2);
  assert.equal(plan.retention.focusHistory, 2);
  assert.equal(plan.retention.total, 4);
  assert.throws(() => saveSettings(store, settings), /确认/);
  assert.equal(store.all('focus_sessions').length, 6);
  store.transaction(() =>
    saveSettings(store, settings, { confirmedRetention: true, expectedRetention: plan.retention }),
  );
  assert.equal(store.all('focus_sessions').length, 2);
  assert.equal(store.all('review_events').length, 3);
  assert.equal(questionStatistics(store, 'TF').answered, 0);
});

test('full service documents focus inputs and blocks focus actions during an exam', async (t) => {
  const { store } = fixture(t),
    app = await buildApp({ databasePath: ':memory:', dailyPushScheduler: false });
  t.after(() => app.close());
  const imported = await app.inject({
    method: 'POST',
    url: '/api/import',
    payload: { mode: 'merge', data: exportData(store) },
  });
  assert.equal(imported.statusCode, 200, imported.body);
  const docs = await app.inject('/api/openapi.json'),
    paths = docs.json().paths;
  assert.equal(
    paths['/api/focus-sessions'].post.requestBody.content['application/json'].schema.properties
      .count.maximum,
    200,
  );
  const focus = await app.inject({
    method: 'POST',
    url: '/api/focus-sessions',
    payload: { paperId: 'P-TF', scope: 'all', count: 1 },
  });
  assert.equal(focus.statusCode, 201, focus.body);
  const created = focus.json();
  const reveal = await app.inject({
    method: 'PUT',
    url: `/api/focus-sessions/${created.id}/current`,
    payload: {
      index: 0,
      revision: created.revision,
      action: 'reveal',
      mode: 'written',
      answer: 'true',
    },
  });
  assert.equal(reveal.statusCode, 200, reveal.body);
  const attemptId = reveal.json().current.attemptId;
  const attempt = await app.inject(`/api/attempts/${attemptId}`);
  assert.equal(attempt.json().focusSessionId, created.id);
  const wrongEntry = await app.inject({
    method: 'POST',
    url: `/api/review-scheduler/attempts/${attemptId}/rating`,
    payload: { leafId: 'TF', rating: 'good' },
  });
  assert.equal(wrongEntry.statusCode, 409, wrongEntry.body);
  assert.equal(wrongEntry.json().error.code, 'FOCUS_RATING_IN_SESSION');
  const exam = await app.inject({
    method: 'POST',
    url: '/api/papers/P-TF/attempts',
    payload: { mode: 'exam', durationMinutes: 1 },
  });
  assert.equal(exam.statusCode, 201, exam.body);
  const denied = await app.inject({
    method: 'POST',
    url: '/api/focus-sessions',
    payload: { paperId: 'P-TF', scope: 'all' },
  });
  assert.equal(denied.statusCode, 409, denied.body);
  assert.equal(denied.json().error.code, 'EXAM_ACTIVE');
});

test('due sessions honor domain/category and paper membership and reject corrupted migrations atomically', (t) => {
  const { store } = fixture(t);
  for (const [id, domainId, categoryId] of [
    ['TF', 'D1', 'C1'],
    ['SA', 'D2', 'C2'],
  ]) {
    store.put('domains', domainId!, {
      id: domainId,
      name: domainId,
      description: '',
      sortOrder: 0,
    });
    store.put('categories', categoryId!, {
      id: categoryId,
      domainId,
      parentId: null,
      name: categoryId,
      description: '',
      sortOrder: 0,
    });
    store.put('questions', id!, {
      ...store.require<Question>('questions', id!),
      domainIds: [domainId],
      categoryIds: [categoryId],
    });
    store.putStudy({ ...store.study(id!), nextReviewAt: '2020-01-01T00:00:00.000Z' });
  }
  const session = createFocus(
    store,
    createFocusSchema.parse({ scope: 'due', domainId: 'D1', categoryId: 'C1', kind: 'overdue' }),
  );
  assert.deepEqual(
    session.items.map((item) => item.questionId),
    ['TF'],
  );
  assert.throws(
    () =>
      createFocus(
        store,
        createFocusSchema.parse({ paperId: 'P-SA', scope: 'due', domainId: 'D1' }),
      ),
    /没有到期/,
  );
  const data = exportData(store) as any;
  data.focusSessions[0].index = 1;
  const target = new Store(':memory:');
  t.after(() => target.db.close());
  assert.throws(() => importData(target, data));
  assert.equal(target.all('questions').length, 0);
  assert.equal(target.all('focus_sessions').length, 0);
});
