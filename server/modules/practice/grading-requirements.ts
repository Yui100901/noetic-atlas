import type { Question } from '../../../shared/models/types.js';
import { isSubjectiveType } from '../../../shared/questions/question-utils.js';
import { fail, parse, questionGradingRequirementsSchema } from '../../core/validation.js';
import { flattenQuestions } from '../questions/structure.js';

/** These are the source standards before a set applies its local overrides. */
export function inheritedRubrics(questions: Question[]): Record<string, string> {
  return Object.fromEntries(
    flattenQuestions(questions)
      .filter((q) => isSubjectiveType(q.type))
      .map((q) => [q.id, q.gradingRequirements || '']),
  );
}

export function applyQuestionRubrics(
  questions: Question[],
  overrides: Record<string, string> = {},
): Question[] {
  const values = parse(questionGradingRequirementsSchema, overrides);
  const subjects = inheritedRubrics(questions);
  for (const id of Object.keys(values))
    if (!Object.hasOwn(subjects, id))
      fail(400, 'INVALID_QUESTION_RUBRIC', '逐题判题要求仅可引用本题集中的主观题或主观小题', {
        questionId: id,
      });
  return questions.map((q) =>
    q.type === 'group'
      ? {
          ...q,
          parts: q.parts?.map((part) =>
            Object.hasOwn(values, `${q.id}::${part.id}`)
              ? { ...part, gradingRequirements: values[`${q.id}::${part.id}`]! }
              : { ...part },
          ),
        }
      : Object.hasOwn(values, q.id)
        ? { ...q, gradingRequirements: values[q.id]! }
        : { ...q },
  );
}

/** Import validation must agree with the exact effective standards in the
 * frozen snapshot, while allowing the original questions to keep their own. */
export function validateStoredRubrics(paper: {
  snapshot: Question[];
  questionGradingRequirements?: Record<string, string>;
  inheritedGradingRequirements?: Record<string, string>;
}) {
  const effective = inheritedRubrics(paper.snapshot),
    overrides = paper.questionGradingRequirements || {};
  parse(questionGradingRequirementsSchema, overrides);
  for (const [id, value] of Object.entries(overrides))
    if (!Object.hasOwn(effective, id) || effective[id] !== value)
      fail(400, 'INVALID_QUESTION_RUBRIC', '题集逐题要求与保存快照不一致', { questionId: id });
  const base = paper.inheritedGradingRequirements;
  if (Object.keys(overrides).length && !base)
    fail(400, 'INVALID_QUESTION_RUBRIC', '题集覆盖要求缺少原标准基线');
  if (base) {
    parse(questionGradingRequirementsSchema, base);
    if (Object.keys(base).some((id) => !Object.hasOwn(effective, id)))
      fail(400, 'INVALID_QUESTION_RUBRIC', '题集原标准包含不在本集中的主观题');
    if (Object.keys(overrides).some((id) => !Object.hasOwn(base, id)))
      fail(400, 'INVALID_QUESTION_RUBRIC', '题集覆盖要求缺少对应原标准');
    for (const [id, value] of Object.entries(base))
      if (effective[id] !== (Object.hasOwn(overrides, id) ? overrides[id] : value))
        fail(400, 'INVALID_QUESTION_RUBRIC', '题集有效标准与沿用或覆盖规则不一致', {
          questionId: id,
        });
  }
}
