import type { AiDocumentBlock } from '../../../shared/ai/ai-document';
import type { DocumentFilesResult } from './ai-document-files';
import type { AiDocumentPreviewEdit } from './ai-document-preview';

export interface DocumentPreviewDraftEdit extends AiDocumentPreviewEdit {
  baseQuestions: string;
  baseRunId: string | null;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const draftString = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback;
export const draftNumber = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
export const draftStrings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
export function documentFilesDraft(value: unknown): DocumentFilesResult | null {
  if (!record(value) || !Array.isArray(value.sections) || !value.sections.length || value.sections.some(section => !record(section) || typeof section.text !== 'string')) return null;
  return { sections: value.sections.map(section => ({ text: section.text as string, ...(typeof section.label === 'string' ? { label: section.label } : {}), ...(typeof section.sourceName === 'string' ? { sourceName: section.sourceName } : {}), ...(typeof section.pageStart === 'number' ? { pageStart: section.pageStart } : {}), ...(typeof section.pageEnd === 'number' ? { pageEnd: section.pageEnd } : {}) })), sourceName: draftString(value.sourceName), characters: draftNumber(value.characters, 0), bytes: draftNumber(value.bytes, 0), files: draftNumber(value.files, 0), pages: draftNumber(value.pages, 0), warnings: draftStrings(value.warnings) };
}
export function documentPreviewDraft(value: unknown): Record<string, DocumentPreviewDraftEdit> {
  if (!record(value)) return {};
  const edits: Record<string, DocumentPreviewDraftEdit> = Object.create(null);
  for (const [id, edit] of Object.entries(value)) if (record(edit) && typeof edit.json === 'string') {
    edits[id] = { json: edit.json, selected: Array.isArray(edit.selected) ? edit.selected.filter((item): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0) : [], baseQuestions: draftString(edit.baseQuestions), baseRunId: typeof edit.baseRunId === 'string' ? edit.baseRunId : null };
  }
  return edits;
}
/** Compare the original immutable generation, not the user's edited JSON. */
export function previewDraftMatches(edit: DocumentPreviewDraftEdit, block?: AiDocumentBlock) {
  return !!block && !block.importedQuestionIds.length && edit.baseQuestions === JSON.stringify(block.questions) && edit.baseRunId === (block.generationRunId || null);
}
export function previewDraftEdit(edit: AiDocumentPreviewEdit, block: AiDocumentBlock): DocumentPreviewDraftEdit {
  return { ...edit, baseQuestions: JSON.stringify(block.questions), baseRunId: block.generationRunId || null };
}
