/** Persisted document tables. Names are a closed set, never taken from requests. */
export const recordTables = ['domains', 'categories', 'tags', 'questions', 'documents', 'papers', 'attempts', 'study', 'study_parts', 'learning_results', 'question_history', 'reviews', 'question_banks', 'settings', 'assets', 'paper_drafts', 'ai_settings', 'ai_runs'] as const;
export type RecordTable = typeof recordTables[number];
export interface DocumentRow { id: string; data: string }
export type AtlasDatabase = { [K in RecordTable]: DocumentRow } & {
  metadata: { key: string; value: string };
  'atlas_question_order': { id: string; ordinal: number };
  question_read_model: DocumentRow & { search_text: string; title_key: string };
  paper_read_model: DocumentRow;
  projection_pending: { source_table: string; source_id: string };
  asset_references: { source_table: string; source_id: string; asset_id: string };
};
