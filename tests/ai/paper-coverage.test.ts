import test from 'node:test';
import assert from 'node:assert/strict';
import {
  paperCoverageReport,
  type PaperCoverageQuestion,
  type PaperCoverageRequirements,
} from '../../shared/ai/paper-coverage.js';
import {
  reservePaperCoverage,
  assertPaperCoverageForSave,
  validateCoverageReferences,
} from '../../server/modules/ai/paper-coverage.js';
import {
  paperCoverageRequirementsSchema,
  paperCoverageReportSchema,
} from '../../server/modules/ai/paper-coverage-schema.js';
import { Store } from '../../server/core/store.js';
import { fixtureQuestion } from '../fixtures/learning-seed.js';
import type { AiPaperPlanResult } from '../../shared/ai/ai.js';

const taxonomy = {
  categories: [
    { id: 'parent', name: '基础', parentId: null },
    { id: 'child', name: '子分类', parentId: 'parent' },
  ],
  tags: ['A', 'B', 'C', 'D', 'E', 'F'].map((id) => ({ id, name: id })),
};
const q = (id: string, tags: string[] = []): PaperCoverageQuestion => ({
  id,
  type: 'short_answer',
  difficulty: 1,
  categoryIds: ['child'],
  tagIds: tags,
});
const requirements = (
  patch: Partial<PaperCoverageRequirements> = {},
): PaperCoverageRequirements => ({ enforcement: 'required', rules: [], ...patch });

test('coverage counts root identities once, includes child categories and shows objective distributions', () => {
  const question = q('one', ['A', 'B']);
  const report = paperCoverageReport(
    [question, question, { ...q('group'), type: 'group', difficulty: 3 }],
    requirements({
      rules: [
        { kind: 'category', value: 'parent', minimum: 2 },
        { kind: 'tag', value: 'A', minimum: 1 },
        { kind: 'tag', value: 'B', minimum: 1 },
      ],
    }),
    taxonomy,
  );
  assert.equal(report.questionCount, 2);
  assert.equal(report.satisfied, true);
  assert.deepEqual(
    report.rows.map((row) => row.actual),
    [2, 1, 1],
  );
  assert.deepEqual(report.types, { short_answer: 1, group: 1 });
  assert.deepEqual(report.difficulties, { '1': 1, '3': 1 });
});

test('joint reservation repairs a greedy overlap corner case instead of rejecting a feasible two-question plan', () => {
  const pool = [
    q('broad', ['A', 'B', 'C', 'D']),
    q('left', ['A', 'B', 'E']),
    q('right', ['C', 'D', 'F']),
  ];
  const requested = requirements({
    rules: ['A', 'B', 'C', 'D', 'E', 'F'].map((value) => ({ kind: 'tag', value, minimum: 1 })),
  });
  const reserved = reservePaperCoverage(pool, 2, requested, taxonomy);
  assert.deepEqual(new Set(reserved.map((item) => item.id)), new Set(['left', 'right']));
  assert.equal(paperCoverageReport(reserved, requested, taxonomy).satisfied, true);
});

test('insufficient, mutually exclusive and jointly incompatible requirements fail with specific guidance', () => {
  assert.throws(
    () =>
      reservePaperCoverage(
        [q('only')],
        1,
        requirements({ rules: [{ kind: 'tag', value: 'A', minimum: 1 }] }),
        taxonomy,
      ),
    { code: 'AI_PAPER_COVERAGE_UNAVAILABLE' },
  );
  assert.throws(
    () =>
      reservePaperCoverage(
        [q('one'), { ...q('two'), type: 'true_false' }],
        1,
        requirements({
          rules: [
            { kind: 'type', value: 'short_answer', minimum: 1 },
            { kind: 'type', value: 'true_false', minimum: 1 },
          ],
        }),
        taxonomy,
      ),
    { code: 'AI_PAPER_COVERAGE_COUNT_CONFLICT' },
  );
  assert.throws(
    () =>
      reservePaperCoverage(
        [q('ab', ['A', 'B']), q('bc', ['B', 'C']), q('ac', ['A', 'C'])],
        1,
        requirements({
          rules: ['A', 'B', 'C'].map((value) => ({ kind: 'tag', value, minimum: 1 })),
        }),
        taxonomy,
      ),
    { code: 'AI_PAPER_COVERAGE_COMBINATION' },
  );
  assert.throws(
    () =>
      validateCoverageReferences(
        requirements({ rules: [{ kind: 'category', value: 'missing', minimum: 1 }] }),
        taxonomy,
      ),
    { code: 'AI_PAPER_COVERAGE_REFERENCE' },
  );
});

test('advisory requirements preserve the candidate scope and report unmet goals without reserving or inventing content', () => {
  const requested = requirements({
    enforcement: 'advisory',
    rules: [{ kind: 'tag', value: 'A', minimum: 3 }],
  });
  assert.deepEqual(reservePaperCoverage([q('one')], 1, requested, taxonomy), []);
  const report = paperCoverageReport([q('one')], requested, taxonomy, [q('one')]);
  assert.equal(report.satisfied, false);
  assert.equal(report.rows[0]!.available, 0);
});

test('coverage schemas reject duplicates, unknown types, invalid difficulty and unbounded rule counts', () => {
  for (const value of [
    requirements({ rules: [{ kind: 'type', value: 'unknown', minimum: 1 }] }),
    requirements({ rules: [{ kind: 'difficulty', value: '5', minimum: 1 }] }),
    requirements({ rules: [{ kind: 'tag', value: 'A', minimum: 0 }] }),
    requirements({
      rules: [
        { kind: 'tag', value: 'A', minimum: 1 },
        { kind: 'tag', value: 'A', minimum: 2 },
      ],
    }),
    requirements({
      rules: Array.from({ length: 21 }, (_, i) => ({ kind: 'tag', value: `t${i}`, minimum: 1 })),
    }),
  ])
    assert.equal(paperCoverageRequirementsSchema.safeParse(value).success, false);
});

test('persisted coverage summaries reject contradictory counts, rule identities and satisfaction flags', () => {
  const requested = requirements({ rules: [{ kind: 'type', value: 'short_answer', minimum: 1 }] });
  const good = paperCoverageReport([q('one')], requested, taxonomy, [q('one')]);
  assert.equal(paperCoverageReportSchema.safeParse(good).success, true);
  for (const changed of [
    { ...good, satisfied: false },
    { ...good, questionCount: 2 },
    { ...good, rows: [{ ...good.rows[0]!, met: false }] },
    { ...good, rows: [{ ...good.rows[0]!, minimum: 2 }] },
    { ...good, rows: [{ ...good.rows[0]!, actual: 2 }] },
    { ...good, rows: [] },
  ])
    assert.equal(paperCoverageReportSchema.safeParse(changed).success, false);
});

test('a large metadata pool produces a bounded root reservation and selected coverage can be rechecked', () => {
  const pool = Array.from({ length: 20000 }, (_, i) => ({
    ...q('Q' + i, i % 4 ? [] : ['A']),
    type: i % 2 ? 'short_answer' : 'true_false',
    difficulty: (i % 4) + 1,
  }));
  const requested = requirements({
    rules: [
      { kind: 'tag', value: 'A', minimum: 20 },
      { kind: 'type', value: 'short_answer', minimum: 20 },
      { kind: 'difficulty', value: '4', minimum: 10 },
    ],
  });
  const reserved = reservePaperCoverage(pool, 50, requested, taxonomy);
  assert.ok(reserved.length <= 50);
  assert.equal(new Set(reserved.map((item) => item.id)).size, reserved.length);
  assert.equal(paperCoverageReport(reserved, requested, taxonomy).satisfied, true);
});

test('save rechecks current question metadata against the saved run requirements and cannot trust a removed client quota', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.database.close());
  store.put(
    'questions',
    'first',
    fixtureQuestion('first', 'short_answer', { categoryIds: [], tagIds: [] }),
  );
  store.put(
    'questions',
    'second',
    fixtureQuestion('second', 'true_false', { categoryIds: [], tagIds: [] }),
  );
  const requested = requirements({ rules: [{ kind: 'type', value: 'true_false', minimum: 1 }] });
  const coverage = paperCoverageReport(
    [q('first'), { ...q('second'), type: 'true_false' }],
    requested,
    { categories: [], tags: [] },
  );
  const run = { result: { coverage } as AiPaperPlanResult };
  assert.equal(assertPaperCoverageForSave(store, run, ['first', 'second'])!.satisfied, true);
  assert.throws(() => assertPaperCoverageForSave(store, run, ['first']), {
    code: 'AI_PAPER_COVERAGE_NOT_MET',
  });
  run.result.coverage = { ...coverage, requirements: { ...requested, enforcement: 'advisory' } };
  assert.equal(assertPaperCoverageForSave(store, run, ['first'])!.satisfied, false);
});
