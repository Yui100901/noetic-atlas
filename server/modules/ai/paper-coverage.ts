import type { AiPaperPlanResult } from '../../../shared/ai/ai.js';
import {
  coverageMatcher,
  paperCoverageReport,
  type PaperCoverageQuestion,
  type PaperCoverageRequirements,
  type PaperCoverageTaxonomy,
} from '../../../shared/ai/paper-coverage.js';
import type { Store } from '../../core/store.js';
import { fail } from '../../core/validation.js';
import { paperCoverageRequirementsSchema } from './paper-coverage-schema.js';
import { QuestionQueries } from '../questions/queries.js';

/** Bounded metadata-only reservation, independent of prompt wording. Quota
 * overlaps share roots. A small exact search repairs greedy corner cases;
 * complex unresolved combinations fail explicitly rather than pretend to fit. */
export function reservePaperCoverage<T extends PaperCoverageQuestion>(
  pool: T[],
  count: number,
  input: PaperCoverageRequirements | undefined,
  taxonomy: PaperCoverageTaxonomy,
): T[] {
  if (!input?.rules.length || input.enforcement !== 'required') return [];
  const requirements = paperCoverageRequirementsSchema.parse(input);
  const report = paperCoverageReport([], requirements, taxonomy, pool);
  const missing = report.rows.filter((row) => row.minimum > (row.available || 0));
  if (missing.length)
    fail(
      422,
      'AI_PAPER_COVERAGE_UNAVAILABLE',
      '当前筛选范围内覆盖题目不足，请降低最低题数或调整范围',
      { coverage: report },
    );
  if (requirements.rules.some((rule) => rule.minimum > count))
    fail(422, 'AI_PAPER_COVERAGE_COUNT_CONFLICT', '单项最低题数超过全卷题量，请调整要求', {
      count,
      coverage: report,
    });
  for (const kind of ['type', 'difficulty'] as const)
    if (
      requirements.rules
        .filter((rule) => rule.kind === kind)
        .reduce((n, rule) => n + rule.minimum, 0) > count
    )
      fail(
        422,
        'AI_PAPER_COVERAGE_COUNT_CONFLICT',
        '互斥题型或难度的最低题数总和超过全卷题量，请调整要求',
        { count, coverage: report },
      );
  const matchers = requirements.rules.map((rule) => coverageMatcher(rule, taxonomy));
  const groups = new Map<number, T[]>();
  for (const question of pool) {
    const mask = matchers.reduce(
      (value, matches, index) => (matches(question) ? value | (1 << index) : value),
      0,
    );
    if (!mask) continue;
    const entries = groups.get(mask) || [];
    entries.push(question);
    groups.set(mask, entries);
  }
  const patterns = [...groups].map(([mask, questions]) => ({ mask, questions }));
  const initial = requirements.rules.map((rule) => rule.minimum);
  const gain = (mask: number, deficits: number[]) =>
    deficits.reduce(
      (value, n, index) =>
        value +
        (n > 0 && mask & (1 << index)
          ? 1 / Math.max(1, report.rows[index]!.available! - initial[index]! + 1)
          : 0),
      0,
    );
  const apply = (deficits: number[], mask: number) =>
    deficits.map((n, index) => Math.max(0, n - Number(!!(mask & (1 << index)))));
  const lowerBound = (deficits: number[]) =>
    Math.max(
      0,
      ...deficits,
      ...(['type', 'difficulty'] as const).map((kind) =>
        deficits.reduce(
          (n, value, index) => n + (requirements.rules[index]!.kind === kind ? value : 0),
          0,
        ),
      ),
    );
  let deficits = [...initial];
  const greedy: T[] = [],
    used = patterns.map(() => 0);
  while (deficits.some(Boolean) && greedy.length <= count) {
    let best = -1,
      score = 0;
    for (let i = 0; i < patterns.length; i++) {
      if (used[i]! >= patterns[i]!.questions.length) continue;
      const next = gain(patterns[i]!.mask, deficits);
      if (next > score) {
        score = next;
        best = i;
      }
    }
    if (best < 0) break;
    const group = patterns[best]!;
    greedy.push(group.questions[used[best]!]!);
    used[best]!++;
    deficits = apply(deficits, group.mask);
  }
  if (!deficits.some(Boolean) && greedy.length <= count) return greedy;
  // Limit work in adversarial overlapping tag/category requests. Returning a
  // planning failure is safer than silently dropping a hard requirement.
  let budget = 20000;
  const consumed = patterns.map(() => 0),
    chosen: T[] = [];
  const search = (remaining: number[], slots: number): boolean => {
    if (!remaining.some(Boolean)) return true;
    if (--budget < 0 || lowerBound(remaining) > slots) return false;
    let required = -1,
      tightness = Infinity;
    for (let index = 0; index < remaining.length; index++)
      if (remaining[index]) {
        const available = patterns.reduce(
          (n, group, i) =>
            n + (group.mask & (1 << index) ? group.questions.length - consumed[i]! : 0),
          0,
        );
        if (available < remaining[index]!) return false;
        if (available / remaining[index]! < tightness) {
          required = index;
          tightness = available / remaining[index]!;
        }
      }
    const options = patterns
      .map((group, index) => ({ group, index, score: gain(group.mask, remaining) }))
      .filter(
        ({ group, index }) =>
          group.mask & (1 << required) && consumed[index]! < group.questions.length,
      )
      .sort((a, b) => b.score - a.score);
    for (const { group, index } of options) {
      chosen.push(group.questions[consumed[index]!]!);
      consumed[index]!++;
      if (search(apply(remaining, group.mask), slots - 1)) return true;
      consumed[index]!--;
      chosen.pop();
      if (budget < 0) break;
    }
    return false;
  };
  if (search(initial, count)) return chosen;
  return fail(
    422,
    'AI_PAPER_COVERAGE_COMBINATION',
    '当前题量下未找到可行的覆盖组合，请增加题量或简化重叠的最低题数要求',
    { count, coverage: report, searchLimited: budget < 0 },
  );
}

export function validateCoverageReferences(
  requirements: PaperCoverageRequirements | undefined,
  taxonomy: PaperCoverageTaxonomy,
) {
  if (!requirements) return;
  for (const rule of requirements.rules) {
    const entries =
      rule.kind === 'category'
        ? taxonomy.categories
        : rule.kind === 'tag'
          ? taxonomy.tags
          : undefined;
    if (entries && !entries.some((item) => item.id === rule.value))
      fail(400, 'AI_PAPER_COVERAGE_REFERENCE', '覆盖要求中的分类或标签已不存在，请刷新后重新选择');
  }
}

/** Called by the apply route after its normal candidate/source-version checks.
 * Requirements come from the saved AI run, never from a bypassable client flag. */
export function assertPaperCoverageForSave(
  store: Store,
  run: { result: AiPaperPlanResult },
  questionIds: string[],
) {
  const requirements = run.result.coverage?.requirements;
  if (!requirements?.rules.length) return undefined;
  const taxonomy = store.taxonomy();
  validateCoverageReferences(requirements, taxonomy);
  const questions = new QuestionQueries(store.database).metadata(
    {},
    { paperQuestions: questionIds, tags: [] },
  );
  if (questions.length !== new Set(questionIds).size)
    fail(
      409,
      'AI_PAPER_COVERAGE_SOURCE_UNAVAILABLE',
      '覆盖核对中发现题目已删除、归档或未发布，请刷新后重新推荐',
    );
  const report = paperCoverageReport(questions, requirements, taxonomy);
  if (requirements.enforcement === 'required' && !report.satisfied)
    fail(422, 'AI_PAPER_COVERAGE_NOT_MET', '调整后的题集未满足覆盖要求，请补足题目或重新推荐', {
      coverage: report,
    });
  return report;
}
