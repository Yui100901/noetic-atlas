import type { Question, QuestionInput } from '../models/types.js';
import type {
  QuestionRevisionContent,
  QuestionFieldDifference,
} from '../models/question-maintenance.js';

/** Explicit authoring boundary: admission, identity and learning state are never
 * copied into a revision, even when a detail endpoint enriched the source. */
export const QUESTION_CONTENT_FIELDS = [
  'title',
  'type',
  'stemMarkdown',
  'answerMarkdown',
  'explanationMarkdown',
  'gradingRequirements',
  'mathEnabled',
  'options',
  'correctAnswers',
  'blanks',
  'parts',
  'vocabulary',
  'concept',
  'difficulty',
  'depth',
  'frequency',
  'frequencyScope',
  'frequencyBasis',
  'collection',
  'categoryIds',
  'tagIds',
  'sourceRefs',
  'sourceDocument',
  'sourceAnchor',
  'documentLinks',
] as const;
export function questionRevisionContent(value: Question | QuestionInput): QuestionRevisionContent {
  return structuredClone(
    Object.fromEntries(
      QUESTION_CONTENT_FIELDS.filter((key) => value[key] !== undefined).map((key) => [
        key,
        value[key],
      ]),
    ),
  ) as QuestionRevisionContent;
}
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, value]) => [key, canonical(value)]),
        )
      : value;
export const questionContentEqual = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export function questionRevisionDifferences(
  before: QuestionRevisionContent,
  after: QuestionRevisionContent,
): QuestionFieldDifference[] {
  return QUESTION_CONTENT_FIELDS.filter(
    (field) => !questionContentEqual(before[field], after[field]),
  ).map((field) => ({
    field,
    before: structuredClone(before[field] ?? null),
    after: structuredClone(after[field] ?? null),
  }));
}
