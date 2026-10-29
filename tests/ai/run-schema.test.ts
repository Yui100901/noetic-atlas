import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../server/core/store.js';
import { ApiError } from '../../server/core/validation.js';
import { AI_RUN_KINDS } from '../../shared/ai/ai.js';
import {
  completedAiResultSchemas,
  storedCompletedAiRunSchema,
} from '../../server/modules/ai/run-schema.js';
import { putCompletedAiRun } from '../../server/modules/ai/run-storage.js';
import { fixtureQuestion } from '../fixtures/learning-seed.js';

const at = '2026-10-29T00:00:00.000Z';
const imported = {
  questions: [fixtureQuestion('import-candidate', 'short_answer')],
  taxonomySuggestions: { domains: [], categories: [], tags: [] },
};
const results = {
  explain: { explanationMarkdown: '解释', followUpsMarkdown: '', pitfallsMarkdown: '' },
  grade: {
    items: [
      {
        questionId: 'q',
        verdict: 'correct',
        score: 1,
        maxPoints: 1,
        comment: '符合要求',
        strengths: [],
        improvements: [],
      },
    ],
  },
  import: imported,
  review: { items: [{ questionId: 'q', verdict: 'valid', issues: [] }], approvedIds: ['q'] },
  paper_plan: {
    title: '题集',
    description: '',
    items: [{ questionId: 'q', reason: '符合条件' }],
    requestedCount: 1,
    candidateCount: 1,
    candidates: [{ id: 'q', title: '题目', type: 'short_answer' }],
    retrieval: {
      availableCount: 1,
      matchedCount: 1,
      reviewedCount: 1,
      batches: 1,
      interpreted: false,
      summary: '手动范围',
    },
  },
  document_plan: {
    title: '章节',
    summary: '概要',
    topics: ['要点'],
    sourceName: '教材',
    label: '第一章',
  },
  document_generate: imported,
  feedback_review: {
    verdict: 'valid',
    reason: '反馈有依据',
    suggestion: '',
    comparisons: [],
    runId: 'run-feedback',
    reviewedAt: at,
    sourceFingerprint: 'a'.repeat(64),
    candidateCount: 0,
  },
  similar_questions: {
    items: [{ questionId: 'q', reason: '相同概念' }],
    candidates: [{ id: 'q', title: '概念', type: 'short_answer' }],
    scope: '本机题库',
  },
  question_edit: {
    summary: '可补充边界',
    suggestions: [
      {
        id: 'suggestion',
        title: '补充答案',
        reason: '明确适用条件',
        confidence: 'high',
        changes: { answerMarkdown: '补充后的答案' },
      },
    ],
    warnings: [],
  },
} satisfies Record<keyof typeof completedAiResultSchemas, unknown>;
const run = (kind: keyof typeof results = 'explain', result: unknown = results[kind]) => ({
  id: 'run',
  kind,
  status: 'completed',
  createdAt: at,
  model: 'test-model',
  warnings: [],
  questionIds: ['q'],
  result,
  _context: { questionVersions: { q: at }, sourceByItem: { q: 'q' } },
});

test('every completed AI kind has an explicit strict durable result contract', () => {
  assert.deepEqual(
    Object.keys(completedAiResultSchemas),
    AI_RUN_KINDS.filter((kind) => kind !== 'connection_test'),
  );
  for (const [kind, result] of Object.entries(results))
    assert.ok(
      storedCompletedAiRunSchema.safeParse(run(kind as keyof typeof results, result)).success,
      kind,
    );
  assert.equal(
    storedCompletedAiRunSchema.safeParse({ ...run(), kind: 'connection_test' }).success,
    false,
  );
  for (const kind of Object.keys(results) as (keyof typeof results)[]) {
    const wrong = kind === 'explain' ? results.paper_plan : results.explain;
    assert.equal(
      storedCompletedAiRunSchema.safeParse(run(kind, wrong)).success,
      false,
      kind + " cannot accept another kind's result",
    );
    assert.equal(
      storedCompletedAiRunSchema.safeParse(
        run(kind, { ...(results[kind] as object), unexpected: true }),
      ).success,
      false,
      kind + ' must reject unmodeled result fields',
    );
  }
});

test('AI metadata and nested plan/context contracts reject corruption without widening restore inputs', () => {
  for (const value of [
    { ...run(), unexpected: true },
    { ...run(), questionIds: ['q', 'q'] },
    { ...run(), importedQuestionIds: ['q', 'q'] },
    { ...run(), _context: { ...run()._context, injected: true } },
    {
      ...run(),
      _context: {
        questionVersions: {},
        sourceByItem: {},
        partByItem: { 'q::part': { partId: 'part', type: 'short_answer' } },
      },
    },
    run('paper_plan', {
      ...results.paper_plan,
      candidates: [{ id: 'q', title: '题目', type: 'unknown' }],
    }),
    run('paper_plan', {
      ...results.paper_plan,
      retrieval: { ...results.paper_plan.retrieval, batches: -1 },
    }),
    run('paper_plan', {
      ...results.paper_plan,
      retrieval: { ...results.paper_plan.retrieval, unexpected: true },
    }),
  ])
    assert.equal(storedCompletedAiRunSchema.safeParse(value).success, false);
  assert.ok(
    storedCompletedAiRunSchema.safeParse({
      ...run(),
      _context: {
        questionVersions: {},
        sourceByItem: { 'q::part': 'q' },
        partByItem: { 'q::part': { partId: 'part', type: 'short_answer' } },
      },
    }).success,
  );
});

test('invalid completed writes leave no record and fail inside the caller transaction atomically', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.database.close());
  putCompletedAiRun(store, run());
  const previous = store.database.getRecord('ai_runs', 'run');
  assert.throws(() => putCompletedAiRun(store, { ...run(), result: results.grade }), ApiError);
  assert.deepEqual(store.database.getRecord('ai_runs', 'run'), previous);
  assert.throws(
    () =>
      store.transaction(() => {
        store.put('questions', 'new-question', fixtureQuestion('new-question', 'short_answer'));
        putCompletedAiRun(store, { ...run(), id: 'bad-run', result: {} });
      }),
    ApiError,
  );
  assert.equal(store.get('questions', 'new-question'), undefined);
  assert.equal(store.database.getRecord('ai_runs', 'bad-run'), undefined);
});
