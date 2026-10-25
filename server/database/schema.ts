/** Persisted document tables. Names are a closed set, never taken from requests. */
export const recordTables = ['domains', 'categories', 'tags', 'questions', 'documents', 'papers', 'attempts', 'study', 'study_parts', 'learning_results', 'question_history', 'reviews', 'question_banks', 'settings', 'assets', 'paper_drafts', 'document_drafts', 'daily_pushes', 'ai_settings', 'ai_runs'] as const;
export type RecordTable = typeof recordTables[number];
export interface DocumentRow { id: string; data: string }
export type AtlasDatabase = { [K in RecordTable]: DocumentRow } & {
  metadata: { key: string; value: string };
  'atlas_question_order': { id: string; ordinal: number };
  question_read_model: DocumentRow & { search_text: string; title_key: string };
  paper_read_model: DocumentRow;
  search_read_model: { key: string; source_table: string; source_id: string; kind: string; entity_id: string; question_id: string | null; data: string; id_key: string; title_key: string; content_key: string; search_text: string; content: string; status: string; archived: number; updated_at: string };
  search_projection_pending: { source_table: string; source_id: string };
  projection_pending: { source_table: string; source_id: string };
  asset_references: { source_table: string; source_id: string; asset_id: string };
};
