import type { Question } from '../../../shared/models/types.js';
import { fail } from '../../core/validation.js';
export interface StoredLeafQuestion extends Question { sourceQuestionId?: string; groupId?: string; groupTitle?: string; groupStemMarkdown?: string; partId?: string; partIndex?: number }
export function flattenQuestions(questions: Question[]): StoredLeafQuestion[] {
  return questions.flatMap(q => q.type !== 'group' ? [q] : (q.parts || []).map((part, index) => ({ ...q, ...part, id: `${q.id}::${part.id}`, parts: undefined, sourceQuestionId: q.id, groupId: q.id, groupTitle: q.title, groupStemMarkdown: q.stemMarkdown, partId: part.id, partIndex: index })));
}
/** Papers count material groups as one question, but every independent answer
 * still consumes the shared 500-answer payload/snapshot limit. */
export function validatePaperAnswers(questions: Question[], maxAnswers = 500) {
  const ids = flattenQuestions(questions).map(q => q.id);
  if (new Set(ids).size !== ids.length || ids.length > maxAnswers) fail(400, 'INVALID_PAPER_PARTS', `展平后的子题题号冲突或作答项超过${maxAnswers}项限制`);
}
/** Largest remainder allocation in integer cents; input order breaks ties. */
export function distributeGroupPoints(q: Question, points: number): Record<string, number> {
  if (q.type !== 'group') return { [q.id]: points };
  const parts = q.parts || [];
  const total = Math.round(points * 100), weight = parts.reduce((n, p) => n + (p.weight ?? 1), 0);
  const values = parts.map((p, i) => { const exact = total * (p.weight ?? 1) / weight; return { id: `${q.id}::${p.id}`, i, cents: Math.floor(exact), remainder: exact - Math.floor(exact) }; });
  const left = total - values.reduce((n, p) => n + p.cents, 0);
  [...values].sort((a, b) => b.remainder - a.remainder || a.i - b.i).slice(0, left).forEach(p => p.cents++);
  return Object.fromEntries(values.map(p => [p.id, p.cents / 100]));
}
