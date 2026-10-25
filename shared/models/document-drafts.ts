import type { DocumentRecord } from './types.js';

/** An unpublished editor snapshot, separate from a saved library document. */
export type DocumentDraftState = Omit<DocumentRecord, 'id' | 'updatedAt'>;
export interface DocumentDraft {
  id: string;
  documentId: string | null;
  baseDocumentUpdatedAt: string | null;
  state: DocumentDraftState;
  createdAt: string;
  updatedAt: string;
}
