import { typeLabels } from '../models/types.js';

export const PAPER_COVERAGE_KINDS = ['category', 'tag', 'type', 'difficulty'] as const;
export type PaperCoverageKind = (typeof PAPER_COVERAGE_KINDS)[number];
export interface PaperCoverageRule {
  kind: PaperCoverageKind;
  value: string;
  minimum: number;
}
export interface PaperCoverageRequirements {
  enforcement: 'required' | 'advisory';
  rules: PaperCoverageRule[];
}
export interface PaperCoverageQuestion {
  id: string;
  type: string;
  difficulty?: number;
  categoryIds?: string[];
  tagIds?: string[];
}
export interface PaperCoverageTaxonomy {
  categories: { id: string; name: string; parentId: string | null }[];
  tags: { id: string; name: string }[];
}
export interface PaperCoverageReport {
  requirements: PaperCoverageRequirements;
  questionCount: number;
  satisfied: boolean;
  rows: (PaperCoverageRule & { label: string; actual: number; available?: number; met: boolean })[];
  types: Record<string, number>;
  difficulties: Record<string, number>;
}
export const EMPTY_PAPER_COVERAGE: PaperCoverageRequirements = {
  enforcement: 'required',
  rules: [],
};
export const coverageRuleKey = (rule: Pick<PaperCoverageRule, 'kind' | 'value'>) =>
  `${rule.kind}:${rule.value}`;

/** A category quota includes its descendants; multi-category/tag roots count
 * once per rule. Group questions count as one root, not multiple child items. */
export function coverageMatcher(rule: PaperCoverageRule, taxonomy: PaperCoverageTaxonomy) {
  const categories = new Set([rule.value]);
  if (rule.kind === 'category') {
    let changed = true;
    while (changed) {
      changed = false;
      for (const category of taxonomy.categories)
        if (
          category.parentId &&
          categories.has(category.parentId) &&
          !categories.has(category.id)
        ) {
          categories.add(category.id);
          changed = true;
        }
    }
  }
  return (question: PaperCoverageQuestion) =>
    rule.kind === 'category'
      ? (question.categoryIds || []).some((id) => categories.has(id))
      : rule.kind === 'tag'
        ? (question.tagIds || []).includes(rule.value)
        : rule.kind === 'type'
          ? question.type === rule.value
          : question.difficulty === Number(rule.value);
}
export function paperCoverageReport(
  questions: readonly PaperCoverageQuestion[],
  requirements: PaperCoverageRequirements,
  taxonomy: PaperCoverageTaxonomy,
  available?: readonly PaperCoverageQuestion[],
): PaperCoverageReport {
  const unique = [...new Map(questions.map((question) => [question.id, question])).values()];
  const rows = requirements.rules.map((rule) => {
    const matches = coverageMatcher(rule, taxonomy);
    const actual = unique.filter(matches).length;
    const label =
      rule.kind === 'category'
        ? taxonomy.categories.find((item) => item.id === rule.value)?.name
        : rule.kind === 'tag'
          ? taxonomy.tags.find((item) => item.id === rule.value)?.name
          : rule.kind === 'type'
            ? typeLabels[rule.value as keyof typeof typeLabels]
            : `D${rule.value}`;
    return {
      ...rule,
      label: label || rule.value,
      actual,
      met: actual >= rule.minimum,
      ...(available ? { available: available.filter(matches).length } : {}),
    };
  });
  const types: Record<string, number> = {},
    difficulties: Record<string, number> = {};
  for (const question of unique) {
    types[question.type] = (types[question.type] || 0) + 1;
    if (question.difficulty !== undefined)
      difficulties[String(question.difficulty)] =
        (difficulties[String(question.difficulty)] || 0) + 1;
  }
  return {
    requirements,
    questionCount: unique.length,
    satisfied: rows.every((row) => row.met),
    rows,
    types,
    difficulties,
  };
}
