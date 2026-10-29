import type { RecordTable } from './schema.js';

/** Every persisted owner of managed attachments must participate in both
 * validation and dirty-index refresh before deletion is allowed. */
export const assetReferenceSources = [
  'questions',
  'documents',
  'papers',
  'attempts',
  'study',
  'study_parts',
  'reviews',
  'learning_results',
  'question_history',
  'document_drafts',
  'ai_import_jobs',
] as const satisfies readonly RecordTable[];
export type AssetReferenceSource = (typeof assetReferenceSources)[number];

/** Draft metadata and uploaded textbook source text are not published file
 * owners. Only the editable document and generated candidate questions count. */
export function assetReferenceContent(source: AssetReferenceSource, record: unknown): unknown {
  if (source === 'document_drafts') return (record as { state: unknown }).state;
  if (source === 'ai_import_jobs')
    return ((record as { blocks?: { questions?: unknown[] }[] }).blocks || []).flatMap(
      (block) => block.questions || [],
    );
  return record;
}
