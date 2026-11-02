import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Store } from '../../server/core/store.js';
import { ApiError } from '../../server/core/validation.js';
import { learningSeed } from '../fixtures/learning-seed.js';
import {
  buildPaper,
  createAttempt,
  submitAttempt,
  reviewAttempt,
  createQuickAttempt,
} from '../../server/modules/practice/service.js';
import { cleanupPlan, executeCleanup } from '../../server/modules/maintenance/cleanup.js';
import { resetPlan, type ResetSelection } from '../../server/modules/maintenance/reset-plan.js';
import { executeReset } from '../../server/modules/maintenance/reset.js';
import { dataHealth } from '../../server/modules/maintenance/health.js';
import { registerMaintenanceRoutes } from '../../server/modules/maintenance/routes.js';
import { questionStatistics } from '../../server/modules/questions/history.js';
import { exportData, importData } from '../../server/modules/transfer/migration.js';
import { DEFAULT_SETTINGS } from '../../shared/models/settings.js';
import {
  createFocus,
  actFocus,
  validateFocusSession,
} from '../../server/modules/focus-review/service.js';
import type { FocusSession } from '../../shared/models/focus-review.js';
import { maintenanceJournal } from '../../server/modules/maintenance/journal.js';
import type { CleanupSelection } from '../../shared/models/maintenance.js';
import { dailyCalendar } from '../../server/modules/daily-push/calendar.js';

const old = '2020-01-01T00:00:00.000Z',
  oldNow = new Date('2026-10-30T10:00:00.000Z');
function fixture(t: test.TestContext, fsrs = false) {
  const store = new Store(':memory:');
  t.after(() => store.database.close());
  const seed = learningSeed();
  for (const d of seed.domains) store.put('domains', d.id, d);
  for (const c of seed.categories) store.put('categories', c.id, c);
  for (const tag of seed.tags) store.put('tags', tag.id, tag);
  for (const q of seed.questions) store.put('questions', q.id, q);
  store.put('settings', 'system', {
    ...structuredClone(DEFAULT_SETTINGS),
    reviewScheduling: { ...DEFAULT_SETTINGS.reviewScheduling, strategy: fsrs ? 'fsrs' : 'fixed' },
  });
  const qid = 'FIXTURE-BOOL';
  const paper = (id: string, questionIds = [qid]) => {
    const value = buildPaper(store, {
      id,
      title: `题集${id}`,
      description: '',
      mode: 'manual',
      questionIds,
    });
    store.put('papers', id, value);
    return value;
  };
  const answer = (id: string, value = 'false') =>
    submitAttempt(store, createAttempt(store, store.require('papers', id)), { [qid]: { value } });
  paper('A');
  paper('B');
  return { store, paper, answer, qid };
}
function reset(store: Store, selection: ResetSelection) {
  const plan = resetPlan(store, selection);
  return executeReset(store, selection, plan.preview.fingerprint);
}
function age(store: Store, table: 'attempts' | 'question_history', id: string) {
  const row = store.require<any>(table, id);
  store.put(table, id, {
    ...row,
    submittedAt: row.status === 'in_progress' ? null : old,
    startedAt: old,
    updatedAt: old,
  });
}

test('health reads metadata, checks integrity and counts protected/unused attachments', (t) => {
  const { store } = fixture(t);
  for (const id of ['orphan', 'used'])
    store.put('assets', id, {
      id,
      filename: `${id}.png`,
      mimeType: 'image/png',
      sizeBytes: 3,
      dataBase64: 'YWJj',
      createdAt: old,
    });
  store.put('documents', 'D', {
    id: 'D',
    title: '引用',
    contentMarkdown: '![](/api/assets/used/content) ![](/api/assets/missing/content)',
  });
  const health = dataHealth(store, true);
  assert.deepEqual(health.storage.integrity, ['ok']);
  assert.equal(health.unusedAssets, 1);
  assert.equal(health.unusedAssetBytes, 3);
  assert.ok(health.issues.some((i) => i.level === 'warning'));
  assert.equal(health.counts.questions, 6);
  assert.ok(!JSON.stringify(health).includes('YWJj'));
  const selection: CleanupSelection = { kinds: ['unused_assets'], olderThanDays: 30 };
  const plan = cleanupPlan(store, selection, oldNow);
  assert.deepEqual(
    plan.rows.get('unused_assets')!.map((r) => r.id),
    ['orphan'],
  );
  executeCleanup(store, selection, plan.preview.fingerprint, oldNow);
  assert.equal(store.get('assets', 'orphan'), undefined);
  assert.ok(store.get('assets', 'used'));
  assert.equal(maintenanceJournal(store).length, 1);
});

test('cleanup rejects stale snapshots even if edited content has equal length', (t) => {
  const { store } = fixture(t);
  store.put('paper_drafts', 'd', { id: 'd', title: '甲', updatedAt: old, private: 'abc' });
  const selection: CleanupSelection = { kinds: ['paper_drafts'], olderThanDays: 30 };
  const preview = cleanupPlan(store, selection, oldNow).preview;
  store.put('paper_drafts', 'd', { id: 'd', title: '乙', updatedAt: old, private: 'xyz' });
  assert.throws(
    () => executeCleanup(store, selection, preview.fingerprint, oldNow),
    (e: any) => e.code === 'MAINTENANCE_PREVIEW_STALE',
  );
  assert.ok(store.get('paper_drafts', 'd'));
  assert.equal(maintenanceJournal(store).length, 0);
});

test('reference added after cleanup preview protects asset atomically', (t) => {
  const { store } = fixture(t);
  store.put('assets', 'orphan', { id: 'orphan', filename: 'x.pdf', sizeBytes: 3, createdAt: old });
  const selection: CleanupSelection = { kinds: ['unused_assets'], olderThanDays: 30 };
  const preview = cleanupPlan(store, selection, oldNow).preview;
  store.put('document_versions', 'version', {
    id: 'version',
    contentMarkdown: '[原文](/api/assets/orphan/content)',
  });
  assert.throws(
    () => executeCleanup(store, selection, preview.fingerprint, oldNow),
    (e: any) => e.code === 'MAINTENANCE_PREVIEW_STALE',
  );
  assert.ok(store.get('assets', 'orphan'));
});

test('history cleanup preserves cumulative results, wrong state and recent question detail', (t) => {
  const { store, answer, qid } = fixture(t),
    a = answer('A');
  age(store, 'attempts', a.id);
  const before = { ...questionStatistics(store, qid), lastAnsweredAt: old };
  const selection: CleanupSelection = { kinds: ['attempt_history'], olderThanDays: 30 };
  executeCleanup(
    store,
    selection,
    cleanupPlan(store, selection, oldNow).preview.fingerprint,
    oldNow,
  );
  assert.equal(store.get('attempts', a.id), undefined);
  assert.deepEqual(questionStatistics(store, qid), before);
  assert.equal(store.study(qid).wrongCount, 1);
  assert.ok(store.all<any>('question_history')[0].detail);
});

test('combined history cleanup removes selected details without regenerating unpreviewed rows', (t) => {
  const { store, answer, qid } = fixture(t),
    a = answer('A');
  age(store, 'attempts', a.id);
  for (const row of store.all<any>('question_history')) age(store, 'question_history', row.id);
  const selection: CleanupSelection = {
    kinds: ['attempt_history', 'question_history'],
    olderThanDays: 30,
  };
  const preview = cleanupPlan(store, selection, oldNow).preview;
  assert.equal(preview.total, 2);
  executeCleanup(store, selection, preview.fingerprint, oldNow);
  assert.equal(store.all('question_history').length, 0);
  assert.equal(store.all('attempts').length, 0);
  assert.equal(store.study(qid).wrongCount, 1);
  assert.ok(store.get('learning_results', a.id));
});

test('cleanup skips active timers/exams and AI jobs or feedback evidence', (t) => {
  const { store } = fixture(t);
  store.put('settings', 'system', {
    ...store.require<any>('settings', 'system'),
    maxDraftsPerPaper: 100,
  });
  const paper = store.require<any>('papers', 'A');
  for (const kind of ['paused', 'running', 'exam']) {
    const a = createAttempt(store, paper, kind === 'exam' ? { mode: 'exam' } : {});
    a.id = kind;
    a.updatedAt = old;
    if (kind === 'running') a.practiceTiming = { ...a.practiceTiming!, running: true };
    store.put('attempts', a.id, a);
  }
  for (const [id, extra] of [
    ['independent', {}],
    ['feedback', { feedbackId: 'f' }],
    ['job', { jobId: 'j' }],
    ['busy', { status: 'running' }],
  ] as const)
    store.database.putRecord('ai_runs', id, { id, status: 'completed', createdAt: old, ...extra });
  const selection: CleanupSelection = {
      kinds: ['practice_drafts', 'ai_history'],
      olderThanDays: 30,
    },
    plan = cleanupPlan(store, selection, oldNow);
  assert.deepEqual(
    plan.rows.get('practice_drafts')!.map((r) => r.id),
    ['paused'],
  );
  assert.deepEqual(
    plan.rows.get('ai_history')!.map((r) => r.id),
    ['independent'],
  );
  assert.equal(plan.preview.protectedAiRuns, 2);
});

test('paper progress reset isolates peers, keeps notes/favorites and marks immutable history', (t) => {
  const { store, answer, qid } = fixture(t),
    a = answer('A'),
    b = answer('B');
  store.putStudy({ ...store.study(qid), notes: '保留笔记', favorite: true, mastery: 2 });
  const result = reset(store, { scope: 'paper', paperId: 'A', mode: 'progress' });
  assert.equal(result.counts.results, 1);
  assert.equal(store.study(qid).wrongCount, 1);
  assert.equal(store.study(qid).notes, '保留笔记');
  assert.equal(store.study(qid).favorite, true);
  assert.equal(store.study(qid).mastery, 2);
  assert.equal(store.get<any>('learning_results', a.id).reset, true);
  assert.ok(!store.get<any>('learning_results', b.id).reset);
  assert.ok(store.get('attempts', a.id));
  const history = store.all<any>('question_history');
  assert.equal(history.find((r) => r.attemptId === a.id).beforeReset, true);
  assert.ok(!history.find((r) => r.attemptId === b.id).beforeReset);
  reviewAttempt(store, store.require('attempts', a.id));
  assert.equal(store.study(qid).wrongCount, 1);
  assert.equal(store.get<any>('learning_results', a.id).reset, true);
  reset(store, { scope: 'paper', paperId: 'A', mode: 'progress' });
  assert.equal(store.study(qid).wrongCount, 1);
});

test('paper complete reset clears own submitted/draft details but keeps peer attempts', (t) => {
  const { store, answer, qid } = fixture(t),
    a = answer('A'),
    b = answer('B');
  const draft = createAttempt(store, store.require('papers', 'A'));
  store.putStudy({ ...store.study(qid), favorite: true, notes: '共享' });
  reset(store, { scope: 'paper', paperId: 'A', mode: 'complete' });
  assert.equal(store.get('attempts', a.id), undefined);
  assert.equal(store.get('attempts', draft.id), undefined);
  assert.ok(store.get('attempts', b.id));
  assert.equal(store.get('learning_results', a.id), undefined);
  assert.equal(
    store.all<any>('question_history').some((r) => r.attemptId === a.id),
    false,
  );
  assert.equal(store.study(qid).favorite, true);
  assert.equal(store.study(qid).notes, '共享');
});

test('FSRS replay retains the peer event and removes paired manual-review evidence', (t) => {
  const { store, answer, qid } = fixture(t, true);
  answer('A');
  const b = answer('B', 'true');
  const peerEvents = store.all<any>('review_events').filter((e) => e.attemptId === b.id);
  assert.equal(peerEvents.length, 1);
  reset(store, { scope: 'paper', paperId: 'A', mode: 'progress' });
  assert.deepEqual(
    store.all<any>('review_events').map((e) => e.id),
    peerEvents.map((e) => e.id),
  );
  assert.equal(store.all<any>('review_cards')[0].memory.reps, 1);
  const focus = createFocus(store, { paperId: 'A', scope: 'all', limit: 1 });
  let session = store.require<FocusSession>('focus_sessions', focus.id);
  actFocus(store, session, {
    action: 'reveal',
    revision: session.revision,
    index: session.index,
    mode: 'mental',
  });
  session = store.require('focus_sessions', session.id);
  actFocus(store, session, {
    action: 'rate',
    revision: session.revision,
    index: session.index,
    rating: 'good',
  });
  assert.ok(store.all<any>('reviews').some((r) => r.schedulerEventId));
  reset(store, { scope: 'paper', paperId: 'A', mode: 'progress' });
  assert.equal(
    store.all<any>('reviews').some((r) => r.schedulerEventId),
    false,
  );
  assert.equal(store.all('review_events').length, 1);
});

test('quick reset only clears single-question/self-test evidence', (t) => {
  const { store, answer, qid } = fixture(t);
  const paperAttempt = answer('A'),
    quick = submitAttempt(store, createQuickAttempt(store, { questionId: qid }), {
      [qid]: { value: 'false' },
    });
  reset(store, { scope: 'quick', mode: 'complete' });
  assert.equal(store.get('attempts', quick.id), undefined);
  assert.ok(store.get('attempts', paperAttempt.id));
  assert.equal(store.study(qid).wrongCount, 1);
});

test('complete global reset preserves library/configuration and authoring drafts', (t) => {
  const { store, answer, qid } = fixture(t, true);
  answer('A');
  createAttempt(store, store.require('papers', 'B'));
  store.putStudy({ ...store.study(qid), favorite: true, notes: '删除' });
  store.put('paper_drafts', 'draft', { id: 'draft', title: '保留编辑草稿' });
  store.put('documents', 'doc', { id: 'doc', title: '保留资料' });
  store.database.putRecord('ai_runs', 'grade', {
    id: 'grade',
    kind: 'grade',
    attemptId: store.all<any>('attempts')[0].id,
  });
  store.database.putRecord('ai_runs', 'explain', {
    id: 'explain',
    kind: 'explain',
    appendedNotes: ['FIXTURE-BOOL'],
  });
  const settings = store.get('settings', 'system');
  reset(store, { scope: 'all', mode: 'complete' });
  for (const table of [
    'attempts',
    'question_history',
    'learning_results',
    'study',
    'study_parts',
    'reviews',
    'review_cards',
    'review_events',
    'learning_task_results',
    'focus_sessions',
  ] as const)
    assert.equal(store.all(table).length, 0, table);
  assert.equal(store.all('questions').length, 6);
  assert.equal(store.all('papers').length, 2);
  assert.ok(store.get('paper_drafts', 'draft'));
  assert.ok(store.get('documents', 'doc'));
  assert.deepEqual(store.get('settings', 'system'), settings);
  assert.equal(store.database.getRecord('ai_runs', 'grade'), undefined);
  assert.deepEqual(store.database.getRecord<any>('ai_runs', 'explain').appendedNotes, []);
});

test('global progress reset retains notes, favorites and whole-paper snapshots', (t) => {
  const { store, answer, qid } = fixture(t, true),
    a = answer('A');
  store.putStudy({ ...store.study(qid), favorite: true, notes: '保留', mastery: 3 });
  reset(store, { scope: 'all', mode: 'progress' });
  assert.equal(store.study(qid).mastery, null);
  assert.equal(store.study(qid).favorite, true);
  assert.equal(store.study(qid).notes, '保留');
  assert.equal(store.all('review_events').length, 0);
  assert.ok(store.get('attempts', a.id));
});

test('reset preview is bound to scope/level and rejects changed evidence atomically', (t) => {
  const { store, answer } = fixture(t);
  const a = answer('A'),
    selection: ResetSelection = { scope: 'paper', paperId: 'A', mode: 'progress' },
    preview = resetPlan(store, selection).preview;
  assert.throws(
    () => executeReset(store, { ...selection, mode: 'complete' }, preview.fingerprint),
    (e: any) => e.code === 'LEARNING_RESET_PREVIEW_STALE',
  );
  const history = store.all<any>('question_history')[0];
  store.put('question_history', history.id, { ...history, beforeReset: true });
  assert.throws(
    () => executeReset(store, selection, preview.fingerprint),
    (e: any) => e.code === 'LEARNING_RESET_PREVIEW_STALE',
  );
  assert.ok(!store.get<any>('learning_results', a.id).reset);
});

test('maintenance API validates confirmation, exposes health and supports compact/reindex', async (t) => {
  const { store } = fixture(t),
    app = Fastify();
  t.after(() => app.close());
  app.setErrorHandler((e, _request, reply) =>
    e instanceof ApiError
      ? reply.code(e.status).send({ error: { code: e.code, message: e.message } })
      : reply.code(500).send({ error: String(e) }),
  );
  registerMaintenanceRoutes(app, store);
  assert.equal((await app.inject('/api/maintenance/health?integrity=true')).statusCode, 200);
  for (const url of [
    '/api/maintenance/cleanup',
    '/api/maintenance/reset',
    '/api/maintenance/compact',
    '/api/maintenance/reindex',
  ])
    assert.equal(
      (await app.inject({ method: 'POST', url, payload: { confirmed: false } })).statusCode,
      400,
    );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/maintenance/reset-preview',
        payload: { scope: 'paper', mode: 'progress' },
      })
    ).statusCode,
    400,
  );
  for (const action of ['compact', 'reindex']) {
    const response = await app.inject({
      method: 'POST',
      url: `/api/maintenance/${action}`,
      payload: { confirmed: true },
    });
    assert.equal(response.statusCode, 200, response.body);
  }
  assert.equal(maintenanceJournal(store).length, 2);
});

test('peer answers retain a shared plan task after its first source was reset', (t) => {
  const { store, answer, qid } = fixture(t);
  const date = dailyCalendar(new Date(), 'Asia/Shanghai').dateKey;
  store.put('learning_days', 'day', {
    id: 'day',
    dateKey: date,
    timeZone: 'Asia/Shanghai',
    generatedAt: new Date(Date.now() - 60000).toISOString(),
    tasks: [{ id: 'task', kind: 'new', questionId: qid, direction: 'standard' }],
  });
  const a = answer('A'),
    b = answer('B', 'true'),
    key = JSON.stringify(['day', 'task']);
  assert.equal(store.require<any>('learning_task_results', key).attemptId, a.id);
  reset(store, { scope: 'paper', paperId: 'A', mode: 'progress' });
  const remaining = store.require<any>('learning_task_results', key);
  assert.equal(remaining.attemptId, b.id);
  assert.ok(remaining.completedAt);
});

test('mixed focus sessions preserve peer entries and remain valid after removing a future item', (t) => {
  const { store, paper } = fixture(t, true);
  paper('B', ['FIXTURE-CHOICE-1']);
  const session = createFocus(store, { paperId: 'A', scope: 'all', limit: 1 });
  const second = createFocus(store, { paperId: 'B', scope: 'all', limit: 1 });
  session.paperId = null;
  session.title = '混合';
  session.items = [...session.items, ...second.items];
  session.items[0]!.paperId = 'A';
  session.items[1]!.paperId = 'B';
  session.summary = undefined;
  store.put('focus_sessions', session.id, session);
  store.remove('focus_sessions', second.id);
  const firstSnapshot = structuredClone(session.items[0]);
  reset(store, { scope: 'paper', paperId: 'B', mode: 'complete' });
  const saved = store.require<FocusSession>('focus_sessions', session.id);
  assert.deepEqual(saved.items[0], firstSnapshot);
  assert.equal(saved.items[1]!.beforeReset, true);
  assert.equal(saved.status, 'submitted');
  assert.doesNotThrow(() => validateFocusSession(saved));
});

test('scoped reset and reset markers round-trip through full JSON migration', (t) => {
  const { store, answer } = fixture(t, true);
  answer('A');
  answer('B');
  reset(store, { scope: 'paper', paperId: 'A', mode: 'progress' });
  const backup = exportData(store),
    copy = new Store(':memory:');
  t.after(() => copy.database.close());
  importData(copy, backup);
  assert.equal(copy.all<any>('learning_results').filter((r) => r.reset).length, 1);
  assert.equal(copy.all<any>('review_events').length, 1);
  assert.equal(copy.study('FIXTURE-BOOL').wrongCount, 1);
});

test('a failed scoped reset rolls back its changes and operation journal', (t) => {
  const { store, answer } = fixture(t);
  const a = answer('A'),
    selection: ResetSelection = { scope: 'paper', paperId: 'A', mode: 'complete' },
    preview = resetPlan(store, selection).preview;
  const original = store.database.deleteRecord.bind(store.database);
  store.database.deleteRecord = (table, id) => {
    if (table === 'question_history') throw new Error('injected failure');
    original(table, id);
  };
  assert.throws(() => executeReset(store, selection, preview.fingerprint), /injected failure/);
  store.database.deleteRecord = original;
  assert.ok(store.get('attempts', a.id));
  assert.ok(store.get('learning_results', a.id));
  assert.equal(maintenanceJournal(store).length, 0);
});

test('reset preview avoids materializing library, set and answer snapshots', (t) => {
  const { store, answer } = fixture(t, true);
  answer('A');
  const original = store.database.getRecord.bind(store.database);
  store.database.getRecord = (table, id) => {
    if (
      ['questions', 'papers', 'learning_results', 'question_history', 'focus_sessions'].includes(
        table,
      )
    )
      throw new Error('Full snapshot read during preview: ' + table);
    return original(table, id);
  };
  try {
    const preview = resetPlan(store, { scope: 'paper', paperId: 'A', mode: 'progress' }).preview;
    assert.equal(preview.title, '题集A');
    assert.equal(preview.counts.results, 1);
  } finally {
    store.database.getRecord = original;
  }
});
