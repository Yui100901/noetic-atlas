import { z } from 'zod';
import { id, types } from '../../core/validation.js';
import { PAPER_COVERAGE_KINDS, coverageRuleKey } from '../../../shared/ai/paper-coverage.js';

export const paperCoverageRuleSchema = z
  .object({
    kind: z.enum(PAPER_COVERAGE_KINDS),
    value: id,
    minimum: z.number().int().min(1).max(500),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.kind === 'type' && !types.safeParse(rule.value).success)
      ctx.addIssue({ code: 'custom', message: '覆盖要求包含未知题型' });
    if (rule.kind === 'difficulty' && !/^[1-4]$/.test(rule.value))
      ctx.addIssue({ code: 'custom', message: '覆盖难度应为D1至D4' });
  });
export const paperCoverageRequirementsSchema = z
  .object({
    enforcement: z.enum(['required', 'advisory']).default('required'),
    rules: z.array(paperCoverageRuleSchema).max(20).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.rules.map(coverageRuleKey)).size !== value.rules.length)
      ctx.addIssue({ code: 'custom', message: '同一覆盖项不能重复，请合并最低题数' });
  });
export const paperCoverageReportSchema = z
  .object({
    requirements: paperCoverageRequirementsSchema,
    questionCount: z.number().int().nonnegative(),
    satisfied: z.boolean(),
    rows: z
      .array(
        paperCoverageRuleSchema.safeExtend({
          label: z.string(),
          actual: z.number().int().nonnegative(),
          available: z.number().int().nonnegative().optional(),
          met: z.boolean(),
        }),
      )
      .max(20),
    types: z.record(z.string(), z.number().int().nonnegative()),
    difficulties: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict()
  .superRefine((report, context) => {
    const expected = report.requirements.rules;
    if (
      report.rows.length !== expected.length ||
      report.satisfied !== report.rows.every((row) => row.met) ||
      report.rows.some((row, index) => {
        const rule = expected[index];
        return (
          !rule ||
          coverageRuleKey(rule) !== coverageRuleKey(row) ||
          rule.minimum !== row.minimum ||
          row.actual > report.questionCount ||
          row.met !== row.actual >= row.minimum ||
          (row.available !== undefined && row.actual > row.available)
        );
      }) ||
      Object.values(report.types).reduce((n, value) => n + value, 0) !== report.questionCount ||
      Object.values(report.difficulties).reduce((n, value) => n + value, 0) > report.questionCount
    )
      context.addIssue({ code: 'custom', message: '覆盖摘要的题量、规则或达标状态不一致' });
  });
export const paperCandidateSchema = z
  .object({
    id,
    title: z.string(),
    type: types,
    difficulty: z.number().int().min(1).max(4).optional(),
    categoryIds: z.array(id).optional(),
    tagIds: z.array(id).optional(),
  })
  .strict();
