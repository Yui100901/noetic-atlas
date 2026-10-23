import type { Category, Question } from '../../../shared/models/types.js';
import { OUTDATED_TAG, OBSOLETE_TAG } from '../../../shared/questions/knowledge-tags.js';

const catalogId = /^(?:MED-DRUG-\d{6}$|TERM-MED-|TERM-MEDCL-|TERM-DOM-med-)/;
const ignored = new Set(['tagIds', 'status', 'createdAt', 'updatedAt']);
function fingerprint(question: Question, ignoreExplanation = false): string {
  return JSON.stringify(Object.entries(question)
    .filter(([key]) => !ignored.has(key) && !(ignoreExplanation && key === 'explanationMarkdown'))
    .sort(([a], [b]) => a.localeCompare(b)));
}

/** Correct a reviewed catalog revision, without recomputing user tags or
 * replacing edited questions. Callers supply validated before/after catalogs;
 * only explanations and the legacy blanket validity tag may change. Historical
 * papers/attempts, review status, source references and user state stay intact.
 */
export function planMedicineRefinement(
  current: Question[], before: Question[], after: Question[], categories: Category[],
): { changed: Question[]; skipped: Array<{ id: string; reason: string }> } {
  const domains = new Map(categories.map(category => [category.id, category.domainId]));
  const revisions = new Map(after.map(question => [question.id, question]));
  const originals = new Map(before.map(question => [question.id, question]));
  if (originals.size !== before.length || revisions.size !== after.length || originals.size !== revisions.size)
    throw new Error('Medical refinement requires matching, unique source IDs');
  for (const original of before) {
    const revised = revisions.get(original.id);
    if (!revised || !catalogId.test(original.id)
      || !original.categoryIds.some(id => domains.get(id) === 'medicine-pharmacy')
      || fingerprint(original, true) !== fingerprint(revised, true)
      || revised.tagIds.includes(OUTDATED_TAG) || revised.tagIds.includes(OBSOLETE_TAG))
      throw new Error('Medical refinement exceeds the reviewed catalog scope: ' + original.id);
    const previousTags = original.tagIds.filter(id => id !== OUTDATED_TAG).sort();
    if (JSON.stringify(previousTags) !== JSON.stringify([...revised.tagIds].sort()))
      throw new Error('Medical refinement must preserve other source tags: ' + original.id);
  }
  const changed: Question[] = [], skipped: Array<{ id: string; reason: string }> = [];
  for (const question of current) {
    const original = originals.get(question.id), revised = revisions.get(question.id);
    if (!original || !revised) continue;
    if (question.tagIds.includes(OBSOLETE_TAG)) {
      skipped.push({ id: question.id, reason: 'confirmed-obsolete' }); continue;
    }
    const body = fingerprint(question);
    if (body !== fingerprint(original) && body !== fingerprint(revised)) {
      skipped.push({ id: question.id, reason: 'locally-edited' }); continue;
    }
    const tagIds = question.tagIds.filter(id => id !== OUTDATED_TAG);
    if (question.explanationMarkdown === revised.explanationMarkdown && tagIds.length === question.tagIds.length) continue;
    changed.push({ ...question, explanationMarkdown: revised.explanationMarkdown, tagIds });
  }
  return { changed, skipped };
}
