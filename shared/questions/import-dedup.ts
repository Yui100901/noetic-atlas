import { sha256 } from '@noble/hashes/sha2.js';
import type { QuestionInput } from '../models/types.js';

const encoder = new TextEncoder();
export const importDigest = (value: string) =>
  Array.from(sha256(encoder.encode(value)), (byte) => byte.toString(16).padStart(2, '0')).join('');
export const importKey = (text: string) =>
  text.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
const fields = [
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
] as const;
const sourceFields = new Set(['sourceLabel', 'sourceUrl', 'license', 'method']);
function canonical(value: unknown, assetKey: (id: string) => string, context = ''): unknown {
  if (typeof value === 'string')
    return value
      .replace(/\r\n?/g, '\n')
      .replace(/\/api\/assets\/([^/\s?#"'()<>\]]+)\/(?:content|data)/g, (_match, id: string) => {
        let decoded = id;
        try {
          decoded = decodeURIComponent(id);
        } catch {
          /* Preserve malformed identifiers for the normal attachment validator. */
        }
        return `asset:${assetKey(decoded)}`;
      });
  if (Array.isArray(value)) return value.map((item) => canonical(item, assetKey, context));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key, item]) =>
            item !== undefined &&
            !(key === 'id' && ['parts', 'blanks'].includes(context)) &&
            !(context === 'pronunciations' && sourceFields.has(key)),
        )
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item, assetKey, key)]),
    );
  return value;
}
/** Conservative identity: code whitespace, case, ordering, units and negation
 * remain significant. Admission, source metadata and learning are not content. */
export function importQuestionContent(
  question: QuestionInput,
  assetKey: (id: string) => string = (id) => id,
): string {
  return JSON.stringify(
    canonical(
      Object.fromEntries(
        fields.filter((key) => question[key] !== undefined).map((key) => [key, question[key]]),
      ),
      assetKey,
    ),
  );
}
export function importQuestionFeatures(question: QuestionInput) {
  const text = importKey(`${question.title}\n${question.stemMarkdown.slice(0, 1600)}`);
  const latin =
    text.match(/\.net\b|[a-z][a-z0-9_]*(?:\+\+|#|(?:[.-][a-z0-9_]+)+)?|\d+(?:\.\d+)?/gu) || [];
  const chinese: string[] = [];
  for (const word of text.match(/[\p{Script=Han}]+/gu) || [])
    for (let i = 0; i < word.length - 1; i++) chinese.push(word.slice(i, i + 2));
  const noise = new Set([
    '什么',
    '如何',
    '说明',
    '以下',
    '下列',
    '正确',
    '错误',
    '一个',
    'the',
    'and',
    'what',
    'this',
    'that',
    'which',
  ]);
  const tokens = [...new Set([...latin, ...chinese].filter((term) => !noise.has(term)))].slice(
    0,
    48,
  );
  const {
    answerMarkdown: _answer,
    explanationMarkdown: _explanation,
    gradingRequirements: _grading,
    correctAnswers: _correct,
    ...prompt
  } = question;
  const promptValue = {
    title: prompt.title,
    type: prompt.type,
    stemMarkdown: prompt.stemMarkdown,
    options: prompt.options,
    parts: prompt.parts?.map((part) => ({
      title: part.title,
      type: part.type,
      stemMarkdown: part.stemMarkdown,
      options: part.options,
    })),
  };
  return {
    titleKey: importKey(question.title),
    promptHash: importDigest(JSON.stringify(canonical(promptValue, (id) => id))),
    vocabKey: question.vocabulary
      ? `word:${question.vocabulary.language}:${importKey(question.vocabulary.headword)}`
      : question.concept
        ? `concept:${importKey(question.concept.term)}`
        : '',
    tokens,
  };
}
export function importTokenScore(left: readonly string[], right: readonly string[]): number {
  const set = new Set(right),
    common = left.filter((value) => set.has(value)).length;
  return common < 2
    ? 0
    : Math.round((100 * common) / Math.max(1, Math.min(left.length, right.length)));
}
