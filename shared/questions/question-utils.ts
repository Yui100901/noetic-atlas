import type { AttemptAnswer, BlankSpec, QuestionType } from '../models/types.js';

export const isSubjectiveType = (type: QuestionType) => type === 'short_answer' || type === 'essay';
/** Deterministic whole-question marking. Blank order is significant; aliases are
 * literal alternatives, never executable regular expressions. */
export function getObjectiveCorrect(q: { type: QuestionType; correctAnswers?: string[]; blanks?: Array<Omit<BlankSpec, 'answers'> & { answers?: string[] }> }, answer?: Pick<AttemptAnswer, 'value'>): boolean {
  if (isSubjectiveType(q.type) || q.type === 'group') return false;
  const value = answer?.value;
  if (q.type === 'fill_blank') {
    if (!Array.isArray(value) || !q.blanks?.length || value.length !== q.blanks.length) return false;
    return q.blanks.every((blank, index) => {
      const normalize = (text: string) => { const trimmed = blank.trim ? text.trim() : text; return blank.caseSensitive ? trimmed : trimmed.toLowerCase(); };
      return value[index] !== undefined && value[index]!.length > 0 && !!blank.answers?.some(alias => normalize(alias) === normalize(value[index]!));
    });
  }
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const expected = q.correctAnswers || [];
  return expected.length > 0 && values.length === expected.length && new Set(values).size === values.length && expected.every(v => values.includes(v));
}
