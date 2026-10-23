import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import type { Question, QuestionType } from '../../shared/models/types.js';
import { cents, planScoredQuestions } from '../../server/modules/practice/scoring.js';
import { ApiError } from '../../server/core/validation.js';

const names: QuestionType[] = ['true_false', 'single_choice', 'multiple_choice', 'short_answer'];
const poolOf = (caps: number[]) => names.flatMap((type, index) => Array.from({ length: caps[index]! }, (_, i) => ({ id: `${type}-${i}`, type } as Question)));

// This oracle enumerates every possible composition; it does not use the
// planner's DP, gcd reduction, candidate ordering or minimum-count tables.
function oracle(caps: number[], values: number[], total: number, percent: number, count?: number) {
  let error = Infinity;
  for (let a = 0; a <= caps[0]!; a++) for (let b = 0; b <= caps[1]!; b++) for (let c = 0; c <= caps[2]!; c++) for (let d = 0; d <= caps[3]!; d++) {
    if (count !== undefined && a + b + c + d !== count) continue;
    const objective = a * values[0]! + b * values[1]! + c * values[2]!;
    if (objective + d * values[3]! !== total) continue;
    error = Math.min(error, Math.abs(objective * 100 - total * percent));
  }
  return error;
}

test('planner handles all missing-type combinations and matches an independent exhaustive optimum with or without a fixed count', () => {
  const schemes = [[25, 50, 75, 125], [50, 50, 50, 75], [25, 275, 175, 75]];
  let verified = 0;
  for (let mask = 0; mask < 16; mask++) for (const values of schemes) {
    const caps = names.map((_, i) => mask & (1 << i) ? 1 + (mask + i) % 3 : 0);
    const pool = poolOf(caps);
    const pointsByType = Object.fromEntries(names.map((type, i) => [type, values[i]! / 100]));
    for (const percent of [0, 60, 100]) for (let units = 1; units <= 18; units++) {
      const total = units * 25;
      for (const count of [undefined, 1 + (units + mask) % 9]) {
        const best = oracle(caps, values, total, percent, count);
        let plan;
        try { plan = planScoredQuestions(pool, { enabled: true, totalPoints: total / 100, objectivePercent: percent, pointsByType }, count); }
        catch (error) { assert.equal(best, Infinity, `Rejected reachable mask=${mask} units=${units} count=${count}`); assert.ok(error instanceof ApiError); assert.equal(error.code, 'UNREACHABLE_TOTAL_POINTS'); verified++; continue; }
        assert.notEqual(best, Infinity, 'A solution must never be invented for an unreachable total');
        const selected = names.map(type => plan.selected[type]);
        assert.ok(selected.every((n, i) => Number.isInteger(n) && n >= 0 && n <= caps[i]!));
        assert.equal(selected.reduce((n, q, i) => n + q * values[i]!, 0), total);
        if (count !== undefined) assert.equal(selected.reduce((n, q) => n + q, 0), count);
        const objective = selected.slice(0, 3).reduce((n, q, i) => n + q * values[i]!, 0);
        assert.equal(Math.abs(objective * 100 - total * percent), best);
        verified++;
      }
    }
  }
  assert.equal(verified, 5184);
});

test('planner enforces the 500-question ceiling and bounds pathological decimal planning', () => {
  const pool = poolOf([500, 500, 500, 500]);
  const lowPoints = Object.fromEntries(names.map(type => [type, 0.01]));
  const plan = planScoredQuestions(pool, { enabled: true, totalPoints: 5, pointsByType: lowPoints });
  assert.equal(Object.values(plan.selected).reduce((n, q) => n + q, 0), 500);
  assert.throws(() => planScoredQuestions(pool, { enabled: true, totalPoints: 5.01, pointsByType: lowPoints }), (error: unknown) => error instanceof ApiError && error.code === 'UNREACHABLE_TOTAL_POINTS');
  const difficult = { enabled: true, totalPoints: 10000, pointsByType: { true_false: 0.01, single_choice: 1000, multiple_choice: 1000, short_answer: 1000 } };
  const started = performance.now();
  assert.throws(() => planScoredQuestions(pool, difficult), (error: unknown) => error instanceof ApiError && error.code === 'SCORING_COMPLEXITY_LIMIT');
  // A fixed count switches to bounded algebraic enumeration and remains useful
  // even when the unrestricted cents DP would exceed its declared state limit.
  const fixed = planScoredQuestions(pool, difficult, 10);
  assert.equal(Object.values(fixed.selected).reduce((n, q) => n + q, 0), 10);
  assert.equal(names.reduce((n, type) => n + fixed.selected[type] * cents(difficult.pointsByType[type]), 0), 1000000);
  assert.ok(performance.now() - started < 2000, 'A pathological request must return promptly');
});
