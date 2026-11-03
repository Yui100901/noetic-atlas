import type { RecordTable } from './schema.js';

/** Every persisted owner of managed attachments must participate in both
 * validation and dirty-index refresh before deletion is allowed. */
export const assetReferenceSources = [
  'questions',
  'documents',
  'document_versions',
  'papers',
  'attempts',
  'study',
  'study_parts',
  'reviews',
  'learning_results',
  'question_history',
  'document_drafts',
  'question_drafts',
  'question_revisions',
  'ai_import_jobs',
  'focus_sessions',
] as const satisfies readonly RecordTable[];
export type AssetReferenceSource = (typeof assetReferenceSources)[number];

/** Draft metadata and uploaded textbook source text are not published file
 * owners. Only the editable document and generated candidate questions count. */
export function assetReferenceContent(source: AssetReferenceSource, record: unknown): unknown {
  if (source === 'document_drafts') return (record as { state: unknown }).state;
  if (source === 'question_drafts') {
    const { form, sources } = (record as { state: { form: unknown; sources: string } }).state;
    return { form, sources };
  }
  if (source === 'question_revisions') return (record as { content: unknown }).content;
  if (source === 'ai_import_jobs')
    return ((record as { blocks?: { questions?: unknown[] }[] }).blocks || []).flatMap(
      (block) => block.questions || [],
    );
  return record;
}
